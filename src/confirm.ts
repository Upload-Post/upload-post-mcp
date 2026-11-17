import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ignoredPlatformOptions } from "./sdk-options.js";
import { ok } from "./schemas.js";
import { describeAdsAction } from "./tools/ads.js";

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
}

const CONFIRMED_FIELD = z
  .boolean()
  .optional()
  .describe(
    "Set to true only after the user has seen the preview this tool returns without it and approved it. Without it nothing is sent."
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
  const network = platform === "bluesky" ? "Bluesky" : "Instagram";
  const to = a.recipient_id !== undefined ? `recipient ${str(a.recipient_id)}` : `conversation ${str(a.conversation_id)}`;
  const action = typeof a.sender_action === "string" ? a.sender_action : undefined;
  if (action) {
    if (SILENT_SENDER_ACTIONS.has(action)) return undefined;
    if (action === "react" || action === "unreact") {
      return `${action === "react" ? "Adds" : "Removes"} the reaction ${str(a.reaction ?? "")} on message ${str(a.message_id)} in the ${network} chat with ${to}, as profile "${str(a.user)}"; the other participant sees it.`;
    }
    if (action === "accept") return `Accepts the ${network} message request from ${to} as profile "${str(a.user)}".`;
    if (action === "leave") return `Leaves the ${network} conversation with ${to} as profile "${str(a.user)}"; it disappears from the account's inbox.`;
    if (action === "delete") return `Deletes message ${str(a.message_id)} for profile "${str(a.user)}" only (the other participant keeps it).`;
    return `Runs ${action} on the ${network} conversation with ${to} as profile "${str(a.user)}".`;
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
    describe: (a) =>
      a.banAuthor && a.hidden !== false
        ? `Hides comment ${str(a.commentId)} and BANS its author from the YouTube channel.`
        : undefined,
  },
  comment_action: {
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
  manage_autodms: { describe: (a) => (a.action === "start" ? autodmStart(a) : undefined) },
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
    describe: (a) => {
      if (a.action === "delete") return `Deletes YouTube playlist ${str(a.playlist_id)} (the videos stay). It cannot be restored.`;
      if (a.action === "remove_video") return `Removes item ${str(a.item_id)} from YouTube playlist ${str(a.playlist_id)}.`;
      if (a.action === "delete_image") return `Deletes the image of YouTube playlist ${str(a.playlist_id)}.`;
      return undefined;
    },
  },
  manage_youtube_channel: {
    describe: (a) => {
      if (a.action === "delete_section") return `Deletes section ${str(a.section_id)} from the YouTube channel page of profile "${str(a.user)}".`;
      if (a.action === "remove_watermark") return `Removes the watermark from every video of the YouTube channel of profile "${str(a.user)}".`;
      return undefined;
    },
  },
  manage_youtube_videos: {
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
    describe: (a) =>
      a.action === "disconnect_social"
        ? `Disconnects ${str(a.social_platform)} from profile "${str(a.username)}": nothing more is published there until the user reconnects it by logging in to the network again.`
        : undefined,
  },
  save_post: {
    describe: (a) =>
      a.platform === "pinterest"
        ? `Saves Pin ${str(a.post_id)} to Pinterest board ${str(a.pinterest_board_id)} of profile "${str(a.user)}"; it shows on that board.`
        : undefined,
  },
  manage_google_business: {
    describe: (a) => {
      const p = (a.params ?? {}) as Args;
      if (a.action === "delete_review_reply") return `Deletes the PUBLIC owner reply to Google review ${str(p.review_name ?? p.review_id)} of profile "${str(a.user)}".`;
      return undefined;
    },
  },
  manage_telegram_payments: {
    describe: (a) => {
      const p = (a.params ?? {}) as Args;
      if (a.action === "send_invoice") return `Posts an invoice "${str(p.title ?? "")}" for ${JSON.stringify(p.prices ?? [])} ${str(p.currency ?? "XTR")} in the Telegram chat of profile "${str(a.user)}"; its members see it and can pay.`;
      return undefined;
    },
  },
  manage_telegram_business: {
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
    out[key] = /base64/i.test(key) && typeof value === "string" ? `<${value.length} base64 characters>` : value;
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
      description: `${tool.description ?? ""} ${gate.note ?? (field === "confirmed" ? CONFIRMED_NOTE : CONFIRM_USERNAME_NOTE)}`,
      paramsSchema: { ...shape, [field]: field === "confirmed" ? CONFIRMED_FIELD : CONFIRM_USERNAME_FIELD },
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
