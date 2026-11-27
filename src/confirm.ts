import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ignoredPlatformOptions } from "./sdk-options.js";
import { ok } from "./schemas.js";
import { describeAdsAction } from "./tools/ads.js";
import { needsImmediateStartConsent } from "./tools/phone_numbers.js";

/**
 * Confirmation step for actions that reach other people or publish as the user.
 *
 * A gated tool called without its confirmation argument does nothing: it
 * returns a preview of exactly what would go out and tells the model to show it
 * to the user. Only a second call with the confirmation argument runs it. The
 * check lives in the server, so it holds even if a model skips the description.
 *
 * Requested by Anthropic's directory review (2026-10-27). ChatGPT does not get
 * the gates: its tool surface is the one OpenAI reviewed, and ChatGPT already
 * asks the user before every write tool.
 *
 * Uploads with a `scheduledDate` or `addToQueue` are not gated: the review's
 * concern was a post going out immediately, and a scheduled or queued post can
 * still be reviewed and cancelled before it publishes. Without this, scheduled
 * unattended runs (nobody there to approve) could not post at all.
 */

type Args = Record<string, unknown>;

interface Gate {
  /** What the call would do, or undefined when this particular call needs no confirmation. */
  describe(args: Args): string | undefined;
  /** Argument that unlocks the call. Default: `confirmed: true`. */
  field?: "confirmed" | "confirm_username";
  /** Description note replacing the default one. */
  note?: string;
  /**
   * When only some actions are gated: those actions, in words. The description
   * then names them instead of saying every call needs approval (agents read
   * that and expected `create` to return a preview; it ran at once).
   */
  only?: string;
}

const CONFIRMED_FIELD = z
  .boolean()
  .optional()
  .describe(
    "Set to true only after the user has seen the preview this tool returns without it and approved it. Without it nothing is sent."
  );

const PARTIAL_CONFIRMED_FIELD = z
  .boolean()
  .optional()
  .describe(
    "Set to true only after the user has seen the preview this tool returns for an action that needs approval, and approved it. The other actions run without it."
  );

const CONFIRM_USERNAME_FIELD = z
  .string()
  .optional()
  .describe(
    "The profile name typed again by the user to confirm the deletion. Must equal `username`; otherwise nothing is deleted."
  );

const CONFIRMED_NOTE =
  "Needs the user's approval: call it first without `confirmed` to get a preview (nothing is sent), show the user exactly what will go out, and repeat the call with `confirmed: true` only after they approve.";

const UPLOAD_NOTE =
  "Publishing now needs the user's approval: call it first without `confirmed` to get a preview (nothing is sent), show the user exactly what will go out, and repeat the call with `confirmed: true` only after they approve. Calls with `scheduledDate` or `addToQueue` run straight away, since the post can still be reviewed and cancelled before it goes out.";

const partialNote = (only: string): string =>
  `Approval: only ${only}, not the other actions. Each of those needs the user's approval: call it first without \`confirmed\` to get a preview (nothing is sent), show the user what will change, and repeat the call with \`confirmed: true\` only after they approve. Every other action runs at once and returns no preview, so check with the user before calling one that changes what they or others see.`;

const CONFIRM_USERNAME_NOTE =
  "Needs the user's approval: the call only deletes when `confirm_username` repeats the profile name, typed or approved by the user. Without it the response says what would be deleted.";

const str = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
const list = (v: unknown): string => (Array.isArray(v) ? v.join(", ") : str(v));

/** Scheduled or queued: the post can still be cancelled before it goes out. */
const isDeferred = (a: Args): boolean =>
  (typeof a.scheduledDate === "string" && a.scheduledDate.trim() !== "") || a.addToQueue === true;

const upload = (what: string): Gate => ({
  note: UPLOAD_NOTE,
  describe: (a) =>
    isDeferred(a)
      ? undefined
      : `Publishes IMMEDIATELY ${what} as profile "${str(a.user)}" on ${a.platforms ? list(a.platforms) : "LinkedIn"}.`,
});

const autodmStart = (a: Args): string => {
  const platform = str(a.platform ?? "instagram");
  const answer = platform === "instagram" ? "a private Instagram DM" : `a PUBLIC reply on ${platform}`;
  const keywords = a.trigger_keywords ? `comments containing ${list(a.trigger_keywords)}` : "EVERY comment";
  // Instagram and TikTok comments arrive by webhook and are answered within
  // seconds; the other networks are checked every `monitoring_interval` minutes.
  const pace =
    platform === "instagram" || platform === "tiktok"
      ? "within seconds of each new comment"
      : `every ${str(a.monitoring_interval ?? 15)} minutes`;
  return (
    `Starts a monitor on profile "${str(a.profile_username)}" that answers ${keywords} on ${str(a.post_url ?? a.post_id)} ` +
    `with ${answer}, ${pace}, for up to 15 days, with nobody reviewing each message.`
  );
};

/** Bluesky sender actions that change nothing the other person sees run without a preview. */
const SILENT_SENDER_ACTIONS = new Set(["mark_seen", "mark_read", "mute", "unmute"]);

const sendDm = (a: Args): string | undefined => {
  const platform = str(a.platform ?? "instagram");
  const network =
    platform === "bluesky" ? "Bluesky" : platform === "telegram" ? "Telegram" : platform === "whatsapp" ? "WhatsApp" : "Instagram";
  const to = a.recipient_id !== undefined ? `recipient ${str(a.recipient_id)}` : `conversation ${str(a.conversation_id)}`;
  const action = typeof a.sender_action === "string" ? a.sender_action : undefined;
  // WhatsApp read receipts and typing change nothing the person reads.
  if (platform === "whatsapp" && (action === "mark_read" || action === "typing_on")) return undefined;
  if (platform === "whatsapp" && !action && a.reaction !== undefined) {
    const r = (typeof a.reaction === "object" && a.reaction ? a.reaction : {}) as Args;
    const emoji = typeof a.reaction === "string" ? a.reaction : str(r.emoji ?? "");
    const target = str(a.message_id ?? r.message_id);
    return emoji
      ? `Reacts ${emoji} to message ${target} in the WhatsApp chat with ${to}, as profile "${str(a.user)}"; the person sees it.`
      : `Removes the reaction on message ${target} in the WhatsApp chat with ${to}, as profile "${str(a.user)}".`;
  }
  if (action) {
    if (SILENT_SENDER_ACTIONS.has(action)) return undefined;
    if (action === "react" || action === "unreact") {
      return `${action === "react" ? "Adds" : "Removes"} the reaction ${str(a.reaction ?? "")} on message ${str(a.message_id)} in the ${network} chat with ${to}, as profile "${str(a.user)}"; the other participant sees it.`;
    }
    if (action === "accept") return `Accepts the ${network} message request from ${to} as profile "${str(a.user)}".`;
    if (action === "leave") return `Leaves the ${network} conversation with ${to} as profile "${str(a.user)}"; it disappears from the account's inbox.`;
    if (action === "delete" && platform === "telegram") {
      return `Deletes ${a.message_ids !== undefined ? `messages ${list(a.message_ids)}` : `message ${str(a.message_id)}`} from the Telegram chat with ${to} for both sides, as profile "${str(a.user)}"; it cannot be undone.`;
    }
    if (action === "delete") return `Deletes message ${str(a.message_id)} for profile "${str(a.user)}" only (the other participant keeps it).`;
    return `Runs ${action} on the ${network} conversation with ${to} as profile "${str(a.user)}".`;
  }
  if (platform === "whatsapp" && a.template !== undefined) {
    const t = (typeof a.template === "object" && a.template ? a.template : {}) as Args;
    return `Sends the WhatsApp template "${str(t.name ?? "")}" as profile "${str(a.user)}" to ${to}; Meta bills the conversation to the user's WhatsApp Business account.`;
  }
  return `Sends a ${network} DM as profile "${str(a.user)}" to ${to}.`;
};

const autodmRule = (a: Args): string => {
  const triggers = a.triggers ? list(a.triggers) : "comment";
  const keywords = a.trigger_keywords ? `only when the text contains ${list(a.trigger_keywords)}` : "to EVERYONE who triggers it";
  return (
    `Creates an account-wide Instagram rule on profile "${str(a.profile_username)}" that sends a private DM, ${keywords}, ` +
    `for these triggers: ${triggers}, on every post and story of the account, present and future, with no end date and nobody reviewing each message.`
  );
};

export const GATES: Record<string, Gate> = {
  upload_video: upload("a video"),
  upload_photos: upload("photos"),
  upload_text: upload("a text post"),
  upload_document: upload("a document"),
  send_dm: { describe: sendDm },
  manage_whatsapp_templates: {
    only: "`delete` and `edit`",
    describe: (a) => {
      if (a.action === "delete") return `Deletes the WhatsApp template "${str(a.name)}" (every language) of profile "${str(a.user)}". It cannot be restored; Meta blocks the name for a while.`;
      if (a.action === "edit") return `Changes WhatsApp template ${str(a.template_id)} of profile "${str(a.user)}" (it goes back to Meta's review; Meta allows 10 edits per 30 days).`;
      return undefined;
    },
  },
  manage_whatsapp_number: {
    only: "`block_users`, `request_display_name`, `apply_display_name`, `change_pin` and `enable_template_insights`",
    describe: (a) => {
      if (a.action === "block_users") return `Blocks ${list(a.users)} on the WhatsApp number of profile "${str(a.user)}": they can no longer write to it, and it cannot write to them.`;
      if (a.action === "request_display_name") return `Asks Meta to review "${str(a.display_name)}" as the new display name of the WhatsApp number of profile "${str(a.user)}".`;
      if (a.action === "apply_display_name") return `Applies the approved new display name of the WhatsApp number of profile "${str(a.user)}"; everyone who chats with it sees the new name.`;
      if (a.action === "change_pin") return `Changes the two-step verification PIN of the WhatsApp number of profile "${str(a.user)}".`;
      if (a.action === "enable_template_insights") return `Turns template analytics on for the WhatsApp Business account of profile "${str(a.user)}"; Meta does not let it be turned off again.`;
      return undefined;
    },
  },
  manage_whatsapp_flows: {
    only: "`publish`, `deprecate` and `delete`",
    describe: (a) => {
      if (a.action === "publish") return `Publishes WhatsApp Flow ${str(a.flow_id)} of profile "${str(a.user)}"; once published it cannot be edited or deleted, only deprecated.`;
      if (a.action === "deprecate") return `Deprecates WhatsApp Flow ${str(a.flow_id)} of profile "${str(a.user)}"; it can no longer be sent.`;
      if (a.action === "delete") return `Deletes the draft WhatsApp Flow ${str(a.flow_id)} of profile "${str(a.user)}".`;
      return undefined;
    },
  },
  manage_facebook_video_captions: {
    describe: (a) =>
      `Changes the captions of Facebook video ${str(a.video_id)} of profile "${str(a.user)}": ${[
        a.srt ? `adds a ${str(a.locale)} track` : "",
        a.default_locale ? `default ${str(a.default_locale)}` : "",
        Array.isArray(a.delete_locales) && a.delete_locales.length ? `DELETES ${list(a.delete_locales)}` : "",
      ]
        .filter(Boolean)
        .join(", ")}. Viewers see the change.`,
  },
  manage_pinterest_api: {
    only: "`DELETE`",
    describe: (a) =>
      a.method === "DELETE" ? `Deletes Pinterest ${str(a.endpoint)} of profile "${str(a.user)}" (a board deletes its Pins too). It cannot be undone.` : undefined,
  },
  manage_instagram_messaging_profile: {
    only: "`set` and `delete`",
    describe: (a) => {
      if (a.action === "set") return `Replaces the Instagram ${[a.ice_breakers !== undefined ? "ice breakers" : "", a.persistent_menu !== undefined ? "persistent menu" : ""].filter(Boolean).join(" and ")} of profile "${str(a.user)}"; everyone who opens a chat with the account sees them.`;
      if (a.action === "delete") return `Removes the Instagram ${list(a.fields)} of profile "${str(a.user)}".`;
      return undefined;
    },
  },
  manage_x_lists: {
    only: "`delete`",
    describe: (a) => (a.action === "delete" ? `Deletes X list ${str(a.list_id)} of profile "${str(a.user)}". It cannot be undone.` : undefined),
  },
  manage_whatsapp_business: {
    only: "`update_profile` and `delete_qr_code`",
    describe: (a) => {
      if (a.action === "update_profile") {
        const { action: _a, user: _u, confirmed: _c, ...p } = a;
        return `Changes the public WhatsApp Business profile of profile "${str(a.user)}" (everyone who opens the chat sees it): ${JSON.stringify(p)}.`;
      }
      if (a.action === "delete_qr_code") return `Deletes WhatsApp QR code / link ${str(a.code)} of profile "${str(a.user)}"; it stops working for anyone who has it.`;
      return undefined;
    },
  },
  purchase_phone_number: {
    // A consumer purchase without immediate_start_consent gets no preview: the
    // tool refuses it before sending and says which consent to ask for first.
    describe: (a) => {
      if (needsImmediateStartConsent(a)) return undefined;
      const docs = a.documents && typeof a.documents === "object" ? Object.keys(a.documents as Args) : [];
      return `Buys ${a.phone_number ? `phone number ${str(a.phone_number)}` : `the first available ${str(a.number_type)} number${a.area_code ? ` in area code ${str(a.area_code)}` : ""}`} in ${str(a.country)} for profile "${str(a.profile_username)}": the monthly price is charged on the account's subscription now (prorated) and on every renewal until the number is released${docs.length ? `; sends the end user's identity and documents (${docs.join(", ")}) to our carrier for review` : ""}. The user accepts the phone number terms (version ${str(a.terms_version)}): no emergency calls.${
        a.immediate_start_consent === true && (a.end_user as Args | undefined)?.type === "individual"
          ? " The end user, a consumer, asks for the service to start now, within the 14-day withdrawal period."
          : ""
      }`;
    },
  },
  send_sms: {
    describe: (a) => `Sends an SMS from phone number ${str(a.number_id)} to ${str(a.to)}, billed per message part: ${str(a.text)}`,
  },
  release_phone_number: {
    describe: (a) =>
      `Releases phone number ${str(a.number_id)} for good: it stops receiving SMS and calls, WhatsApp on it stops working, and the carrier may give it to someone else. The monthly charge stops, with no refund for the rest of the period (a number whose identity review was declined is refunded instead). It cannot be undone.`,
  },
  fix_phone_number_kyc: {
    describe: (a) => {
      if (a.action === "reply") {
        const files = Array.isArray(a.attachments) ? a.attachments.length : 0;
        return `Sends this message to our carrier's identity reviewer about phone number ${str(a.number_id)}${files ? ` with ${files} attachment${files > 1 ? "s" : ""}` : ""}: ${str(a.text)}`;
      }
      const parts = [
        a.values && typeof a.values === "object" ? `values (${Object.keys(a.values as Args).join(", ")})` : "",
        a.documents && typeof a.documents === "object" ? `documents (${Object.keys(a.documents as Args).join(", ")})` : "",
        a.end_user ? "the end user with a new address" : "",
        a.phone_number ? `replacement number ${str(a.phone_number)}` : "",
      ].filter(Boolean);
      return `Sends corrected identity data for phone number ${str(a.number_id)} to our carrier and submits the review again: ${parts.join(", ") || "nothing"}. No new charge.`;
    },
  },
  manage_phone_kyc_links: {
    describe: (a) => {
      if (a.action === "revoke") return `Revokes KYC link ${str(a.link_id)}: it stops working at once for whoever has it. It cannot be undone.`;
      return `Creates a single-use KYC link (valid 7 days) for profile "${str(a.profile_username)}": whoever opens it fills in the identity for ${a.phone_number ? `phone number ${str(a.phone_number)}` : `a ${str(a.number_type)} number`} in ${str(a.country)}, and on submitting it the number is bought and BILLED TO THIS ACCOUNT (monthly price now, prorated, and on every renewal until released).`;
    },
  },
  reply_to_comment: {
    describe: (a) => `Sends a private DM as profile "${str(a.user)}" to the author of comment ${str(a.commentId)}.`,
  },
  public_reply_to_comment: {
    describe: (a) => `Posts a PUBLIC reply as profile "${str(a.user)}" under comment ${str(a.commentId)}.`,
  },
  create_comment: {
    describe: (a) =>
      `Posts a PUBLIC ${a.commentId ? "reply" : "comment"} on ${str(a.platform ?? "instagram")} as profile "${str(a.user)}".`,
  },
  reply_to_google_business_review: {
    describe: (a) =>
      `Posts (or replaces) the PUBLIC owner reply to Google review ${str(a.review_name ?? a.review_id)} as profile "${str(a.user)}".`,
  },
  edit_comment: {
    describe: (a) => `Rewrites comment ${str(a.commentId)} on ${str(a.platform)}; the previous text is not kept.`,
  },
  hide_comment: {
    only: "hiding with `banAuthor`",
    describe: (a) =>
      a.banAuthor && a.hidden !== false
        ? `Hides comment ${str(a.commentId)} and BANS its author from the YouTube channel.`
        : undefined,
  },
  comment_action: {
    only: "`edit`, and `hide` with `banAuthor`",
    describe: (a) => {
      if (a.action === "edit") return `Rewrites comment ${str(a.commentId)} on ${str(a.platform)}; the previous text is not kept.`;
      if (a.banAuthor && a.action === "hide") return `Hides comment ${str(a.commentId)} and BANS its author from the YouTube channel.`;
      return undefined;
    },
  },
  start_autodm: { describe: autodmStart },
  create_autodm_rule: { describe: autodmRule },
  redeliver_webhook: {
    describe: (a) =>
      `Sends webhook delivery ${str(a.delivery_id)} again, with the same body, to the webhook URL configured now; the receiver gets the event a second time.`,
  },
  manage_autodms: { only: "`start`", describe: (a) => (a.action === "start" ? autodmStart(a) : undefined) },
  edit_post: {
    describe: (a) =>
      `Changes the live post ${str(a.post_id)} on ${str(a.platform)} as profile "${str(a.user)}"${a.text !== undefined ? ` to the text: ${str(a.text)}` : ""}${a.telegram_action ? ` (${str(a.telegram_action)})` : ""}; the previous version is not kept.`,
  },
  repost_post: {
    describe: (a) =>
      `Reposts ${a.post_ids ? `messages ${list(a.post_ids)}` : `post ${str(a.post_id)}`} on ${str(a.platform)} as profile "${str(a.user)}"${a.target_chat_id ? ` into chat ${str(a.target_chat_id)}` : ""}${a.target_user ? ` into the Telegram chat of profile "${str(a.target_user)}"` : ""}; its followers see it.`,
  },
  manage_youtube_comments: {
    describe: (a) => {
      const p = (a.params ?? {}) as Args;
      if (a.action === "create") {
        return `Posts a PUBLIC YouTube ${p.parent_id ? `reply to comment ${str(p.parent_id)}` : `comment on video ${str(p.video_id)}`} as the channel of profile "${str(a.user)}": ${str(p.text ?? "")}`;
      }
      if (a.action === "edit") return `Rewrites YouTube comment ${str(a.comment_id ?? p.comment_id)} to: ${str(p.text ?? "")}`;
      if (a.action === "delete") return `Deletes YouTube comment ${str(a.comment_id ?? p.comment_id)} of profile "${str(a.user)}". It cannot be restored.`;
      return `Sets ${list(p.comment_ids ?? "")} to ${str(p.status)} on the YouTube channel of profile "${str(a.user)}"${p.ban_author ? " and BANS their authors" : ""}.`;
    },
  },
  manage_youtube_live: {
    only: "`send_chat_message`, `transition` to `live` or `complete`, `delete_broadcast`, `delete_stream`, `delete_chat_message`, `ban_user` and `remove_moderator`",
    describe: (a) => {
      const p = (a.params ?? {}) as Args;
      if (a.action === "send_chat_message") {
        return `Posts ${p.poll ? "a poll" : `the message "${str(p.message ?? "")}"`} in the PUBLIC live chat of broadcast ${str(a.broadcast_id ?? p.live_chat_id)} as profile "${str(a.user)}".`;
      }
      if (a.action === "transition" && (p.status === "live" || p.status === "complete")) {
        return `Takes YouTube broadcast ${str(a.broadcast_id)} ${p.status === "live" ? "LIVE for its audience" : "off the air (it cannot be restarted)"}.`;
      }
      if (a.action === "delete_broadcast") return `Deletes YouTube broadcast ${str(a.broadcast_id)}. It cannot be restored.`;
      if (a.action === "delete_stream") return `Deletes YouTube stream ${str(a.stream_id)}; encoders using its key stop.`;
      if (a.action === "delete_chat_message") return `Deletes live chat message ${str(a.message_id)}.`;
      if (a.action === "ban_user") {
        const kind = p.type === "temporary" ? `for ${str(p.duration_seconds ?? "?")} seconds` : "PERMANENTLY";
        return `Bans YouTube channel ${str(p.channel_id)} ${kind} from the live chat of broadcast ${str(a.broadcast_id ?? p.live_chat_id)} (profile "${str(a.user)}").`;
      }
      if (a.action === "remove_moderator") return `Removes moderator ${str(a.moderator_id)} from the live chat of profile "${str(a.user)}".`;
      return undefined;
    },
  },
  manage_youtube_playlists: {
    only: "`delete`, `remove_video` and `delete_image`",
    describe: (a) => {
      if (a.action === "delete") return `Deletes YouTube playlist ${str(a.playlist_id)} (the videos stay). It cannot be restored.`;
      if (a.action === "remove_video") return `Removes item ${str(a.item_id)} from YouTube playlist ${str(a.playlist_id)}.`;
      if (a.action === "delete_image") return `Deletes the image of YouTube playlist ${str(a.playlist_id)}.`;
      return undefined;
    },
  },
  manage_youtube_channel: {
    only: "`delete_section` and `remove_watermark`",
    describe: (a) => {
      if (a.action === "delete_section") return `Deletes section ${str(a.section_id)} from the YouTube channel page of profile "${str(a.user)}".`;
      if (a.action === "remove_watermark") return `Removes the watermark from every video of the YouTube channel of profile "${str(a.user)}".`;
      return undefined;
    },
  },
  manage_youtube_videos: {
    only: "`delete_caption` and `report_abuse`",
    describe: (a) => {
      if (a.action === "delete_caption") return `Deletes YouTube caption track ${str(a.caption_id)}. It cannot be restored.`;
      if (a.action === "report_abuse") {
        const p = (a.params ?? {}) as Args;
        return `Reports YouTube video ${str(a.video_id)} to YouTube for abuse (reason ${str(p.reason_id)}) as the channel of profile "${str(a.user)}". A report cannot be withdrawn.`;
      }
      return undefined;
    },
  },
  post_action: {
    describe: (a) => {
      // Bookmarks are private; delete_reaction carries the API's own `confirm`.
      if (a.action === "bookmark" || a.action === "unbookmark" || a.action === "delete_reaction") return undefined;
      if (a.action === "react") return `Reacts ${str(a.emoji ?? "")} to message ${str(a.post_id)} on Telegram as profile "${str(a.user)}"; the chat sees it.`;
      if (a.platform === "x") return `Runs ${str(a.action)} on X post ${str(a.post_id)} as profile "${str(a.user)}"; it changes what others see.`;
      return `Runs ${str(a.action)} on Bluesky post ${str(a.post_id ?? "(pinned)")} as profile "${str(a.user)}"; it changes what others see on the post or profile.`;
    },
  },
  manage_chatgpt_ads: { describe: describeAdsAction },
  create_webhook_subscription: {
    describe: (a) =>
      `From now on sends the account's ${list(a.events)} events${a.profile_username ? ` of profile "${str(a.profile_username)}"` : " of every profile"} to ${str(a.url)}, signed with the account webhook secret.`,
  },
  test_webhook_subscription: {
    describe: (a) =>
      `Sends a signed sample ${a.event ? `${str(a.event)} event` : "of the subscription's first event"} (test: true) now to the URL of webhook subscription ${str(a.subscription_id)} (list_webhook_subscriptions shows it); the receiver gets it like a real event.`,
  },
  delete_webhook_subscription: {
    describe: (a) => `Deletes webhook subscription ${str(a.subscription_id)}: Upload-Post stops sending events to its URL right away.`,
  },
  manage_webhook_settings: {
    only: "`set_account`, `remove_account`, `set_profile`, `test_account` and `remove_profile`",
    describe: (a) => {
      if (a.action === "set_account" && a.webhook_url !== undefined) return `Sends the account's events (uploads, DMs, comments…) to ${str(a.webhook_url)} from now on, instead of the current account webhook.`;
      if (a.action === "set_account") return `Changes the account webhook settings: ${JSON.stringify({ webhook_events: a.webhook_events, ...((a.params ?? {}) as Args) })}.`;
      if (a.action === "remove_account") return "Removes the account webhook: its URL, event list and signing secret are cleared and the webhook channel is turned off.";
      if (a.action === "set_profile") return `Sends the events of profile "${str(a.profile_username)}" to ${str(a.webhook_url)} from now on, instead of the account webhook.`;
      if (a.action === "test_account") {
        const p = (a.params ?? {}) as Args;
        return `Sends a sample upload_completed notification (marked as a test${p.platform ? `, platform ${str(p.platform)}` : ""}) now through every channel the account has configured: its webhook URL and Telegram chat, as get_account shows them.`;
      }
      if (a.action === "remove_profile") return `Removes the own webhook of profile "${str(a.profile_username)}"; its events go back to the account webhook.`;
      return undefined;
    },
  },
  manage_profile: {
    only: "`disconnect_social`",
    describe: (a) =>
      a.action === "disconnect_social"
        ? `Disconnects ${str(a.social_platform)} from profile "${str(a.username)}": nothing more is published there until the user reconnects it by logging in to the network again.`
        : undefined,
  },
  save_post: {
    only: "saving a Pin to a Pinterest board",
    describe: (a) =>
      a.platform === "pinterest"
        ? `Saves Pin ${str(a.post_id)} to Pinterest board ${str(a.pinterest_board_id)} of profile "${str(a.user)}"; it shows on that board.`
        : undefined,
  },
  manage_google_business: {
    only: "`delete_review_reply`",
    describe: (a) => {
      const p = (a.params ?? {}) as Args;
      if (a.action === "delete_review_reply") return `Deletes the PUBLIC owner reply to Google review ${str(p.review_name ?? p.review_id)} of profile "${str(a.user)}".`;
      return undefined;
    },
  },
  manage_telegram_payments: {
    only: "`send_invoice`",
    describe: (a) => {
      const p = (a.params ?? {}) as Args;
      if (a.action === "send_invoice") return `Posts an invoice "${str(p.title ?? "")}" for ${JSON.stringify(p.prices ?? [])} ${str(p.currency ?? "XTR")} in the Telegram chat of profile "${str(a.user)}"; its members see it and can pay.`;
      return undefined;
    },
  },
  manage_telegram_business: {
    only: "`post_story`, `repost_story`, `delete_story` and `update_profile`",
    describe: (a) => {
      const p = (a.params ?? {}) as Args;
      if (a.action === "post_story" || a.action === "repost_story") return `Posts a Telegram story as the user's Telegram Business account (profile "${str(a.user)}")${p.caption ? `: ${str(p.caption)}` : ""}; their contacts see it.`;
      if (a.action === "delete_story") return `Deletes Telegram story ${str(p.story_id)} of the user's Telegram Business account.`;
      if (a.action === "update_profile") return `Changes the user's own Telegram account profile: ${JSON.stringify(p)}.`;
      return undefined;
    },
  },
  approve_post: {
    describe: (a) =>
      `Approves post ${str(a.approval_id)} (version ${str(a.version)}): Upload-Post publishes it on its platforms ${a.publish_now ? "NOW" : a.scheduled_date ? `at ${str(a.scheduled_date)}${a.timezone ? ` (${str(a.timezone)})` : ""}` : "at its own date, or now if it had none, or in the next queue slot if it was queued"}.`,
  },
  reject_post: {
    describe: (a) => `Rejects post ${str(a.approval_id)}: it will not be published, it cannot be reopened, and the author sees the comment: ${str(a.comment)}`,
  },
  withdraw_pending_post: {
    describe: (a) => `Withdraws post ${str(a.approval_id)}: it will not be published and its media is deleted. It cannot be undone.`,
  },
  unpublish_post: {
    describe: (a) =>
      `Permanently deletes post ${str(a.postId)} from ${str(a.platform)} (profile "${str(a.user)}"). It cannot be restored.`,
  },
  delete_user: {
    field: "confirm_username",
    describe: (a) =>
      `Permanently deletes profile "${str(a.username)}" and disconnects every social account on it. It cannot be undone.`,
  },
};

/** Arguments as the user should review them: inline file bytes are summarised, not echoed. */
function previewArgs(args: Args): Args {
  const out: Args = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || key === "confirmed" || key === "confirm_username") continue;
    out[key] = /base64/i.test(key) && typeof value === "string" ? `<${value.length} base64 characters>` : summariseBase64(value);
  }
  return out;
}

/** Nested file bytes (e.g. identity documents) are summarised too. */
function summariseBase64(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => summariseBase64(v, depth + 1));
  const out: Args = {};
  for (const [key, v] of Object.entries(value as Args)) {
    out[key] = /base64/i.test(key) && typeof v === "string" ? `<${v.length} base64 characters>` : summariseBase64(v, depth + 1);
  }
  return out;
}

function confirmationRequired(name: string, action: string, args: Args, field: string): unknown {
  const nextStep =
    field === "confirm_username"
      ? `Nothing has been deleted. Tell the user exactly what this deletes and ask them to type the profile name to confirm. Only then call ${name} again with confirm_username set to it.`
      : `Nothing has been sent yet. Show the user this preview: the exact text, media, recipients or platforms, buttons, keywords and timing. Only after they approve it, call ${name} again with the same arguments plus confirmed: true. If they want changes, apply them and preview again.`;
  // Say before publishing which platformOptions would be dropped, so the user
  // is not shown an option in the preview that never reaches the platform.
  const ignored = ignoredPlatformOptions(args.platformOptions as Record<string, unknown> | undefined);
  return {
    status: "confirmation_required",
    executed: false,
    action,
    preview: previewArgs(args),
    ...(ignored.length
      ? {
          ignored_platform_options: ignored,
          platform_options_warning: `These platformOptions keys are not supported and will NOT be sent: ${ignored.join(", ")}. Fix or remove them before asking the user to approve, or tell the user they will not be applied.`,
        }
      : {}),
    next_step: nextStep,
  };
}

function isUnlocked(args: Args, field: string): boolean {
  if (field === "confirm_username") {
    return typeof args.confirm_username === "string" && args.confirm_username.trim() === str(args.username).trim();
  }
  return args.confirmed === true;
}

/**
 * Add the confirmation argument, description note and server-side check to
 * every gated tool registered on `server`. Call once per session, after any
 * other description rewrites.
 */
export function applyConfirmationGates(server: McpServer): void {
  // McpServer keeps no public lookup by name; this is the map it lists from.
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
  for (const [name, gate] of Object.entries(GATES)) {
    const tool = registered[name];
    if (!tool) continue;
    const field = gate.field ?? "confirmed";
    const shape = (tool.inputSchema as z.AnyZodObject).shape;
    const original = tool.handler as (args: Args, extra: unknown) => Promise<unknown>;
    tool.update({
      description: `${tool.description ?? ""} ${
        gate.note ?? (gate.only ? partialNote(gate.only) : field === "confirmed" ? CONFIRMED_NOTE : CONFIRM_USERNAME_NOTE)
      }`,
      paramsSchema: {
        ...shape,
        [field]:
          field === "confirm_username" ? CONFIRM_USERNAME_FIELD : gate.only ? PARTIAL_CONFIRMED_FIELD : CONFIRMED_FIELD,
      },
      callback: (async (args: Args, extra: unknown) => {
        const action = gate.describe(args);
        if (action && !isUnlocked(args, field)) {
          return ok(confirmationRequired(name, action, args, field));
        }
        const { confirmed: _confirmed, confirm_username: _username, ...rest } = args;
        return original(rest, extra);
      }) as never,
    });
  }
}
