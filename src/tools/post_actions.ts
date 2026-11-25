import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { genericResultOutputSchema, safe } from "../schemas.js";
import { apiConfirmField, callRoute, paramsField } from "./resource.js";

/**
 * Work on posts that are already published: edit, repost / forward, and the
 * per-network actions (Telegram reactions; Bluesky bookmark, pin and the
 * reply / quote settings). Deleting stays in unpublish_post.
 */

/** The field that holds the new text on each network's edit call. */
const EDIT_TEXT_FIELD: Record<string, string> = {
  facebook: "message",
  linkedin: "commentary",
  x: "text",
  google_business: "summary",
  telegram: "text",
  youtube: "description",
};

const BLUESKY_ACTIONS = [
  "bookmark",
  "unbookmark",
  "pin",
  "unpin",
  "reply_settings",
  "quote_settings",
  "detach_quote",
  "reattach_quote",
] as const;
const TELEGRAM_ACTIONS = ["react", "delete_reaction"] as const;
const X_ACTIONS = ["bookmark", "unbookmark", "unrepost"] as const;
/** Which actions each platform takes. */
const POST_ACTIONS_BY_PLATFORM: Record<string, readonly string[]> = {
  bluesky: BLUESKY_ACTIONS,
  telegram: TELEGRAM_ACTIONS,
  x: X_ACTIONS,
};

export function registerPostActionTools(server: McpServer, client: UploadPostMcpClient): RegisteredTool[] {
  const edit = server.registerTool(
    "edit_post",
    {
      title: "Edit a published post",
      description:
        "Change a post that is already live, in place. Facebook (Page posts), LinkedIn, X, Google Business, Telegram and YouTube. `text` is the new text (sent as each network's own field; YouTube: the description). " +
        "Telegram also takes `telegram_action`: pin, unpin, stop_poll, edit_live_location, stop_live_location, and in `params`: telegram_reply_markup (buttons), telegram_parse_mode, telegram_link_preview, telegram_show_caption_above_media, telegram_pin_notify, telegram_media + telegram_media_type (replace the photo/video by URL or file_id), telegram_location. " +
        "Google Business: the text plus call to action, event and offer fields in `params` (cta_type, cta_url, event_title, event_start_date, event_start_time, event_end_date, event_end_time, offer_coupon, offer_redeem_url, offer_terms); its media and schedule cannot be changed. Facebook: is_pinned, facebook_page_id. LinkedIn: linkedin_visibility, linkedin_disable_reshare. " +
        "YouTube (post_id = video id), in `params`: title, tags, privacyStatus, categoryId, publishAt, defaultLanguage, localizations {lang: {title, description}}, localizations_remove, brand_partner (a UC… channel id), embeddable, publicStatsViewable, selfDeclaredMadeForKids, containsSyntheticMedia, license, recordingDate, paid_partnership; editing these spends about 51 units of the account's daily YouTube allowance. " +
        "Instagram, TikTok and Threads posts cannot be edited.",
      inputSchema: {
        user: z.string().describe("Upload-Post profile name."),
        platform: z.enum(["facebook", "linkedin", "x", "google_business", "telegram", "youtube"]),
        post_id: z
          .string()
          .describe("The post id on the platform, as returned by the upload or get_media (Google Business: the full accounts/…/localPosts/… name)."),
        text: z.string().optional().describe("New text of the post (Telegram: text or caption)."),
        telegram_action: z
          .enum(["pin", "unpin", "stop_poll", "edit_live_location", "stop_live_location"])
          .optional()
          .describe("Telegram only: an action on the message instead of (or with) a text change."),
        params: paramsField("Per-network fields listed in the description."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Edit a published post",
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    safe(async (args) => {
      const { user, platform, post_id, text, telegram_action, params } = args as {
        user: string;
        platform: string;
        post_id: string;
        text?: string;
        telegram_action?: string;
        params?: Record<string, unknown>;
      };
      const body: Record<string, unknown> = { ...(params ?? {}), user, platform, post_id };
      if (text !== undefined) body[EDIT_TEXT_FIELD[platform] ?? "text"] = text;
      if (telegram_action) body.action = telegram_action;
      return callRoute(client, { method: "POST", path: "/uploadposts/posts/edit" }, body);
    })
  );

  const repost = server.registerTool(
    "repost_post",
    {
      title: "Repost / forward a post",
      description:
        "Reshare a published post. LinkedIn (reshare, optional `commentary`, `target_linkedin_page_id` to reshare as a Page), X (retweet), Threads (repost), Telegram (forward or copy a channel post into another chat). " +
        "Telegram: `mode` forward (shows the source) or copy (no link back), `target_chat_id` (@username or id) or `target_user` (another Upload-Post profile with Telegram), `post_ids` for several messages, `all_messages` true to include the messages a long post was split into (rest of the caption, first comment). " +
        "More Telegram fields in `params`: telegram_message_thread_id, telegram_disable_notification, telegram_protect_content, caption, telegram_remove_caption, telegram_reply_markup.",
      inputSchema: {
        user: z.string().describe("Upload-Post profile name that owns the post."),
        platform: z.enum(["linkedin", "x", "threads", "telegram"]),
        post_id: z.string().optional().describe("The post id on the platform. Telegram may use `post_ids` instead."),
        commentary: z.string().optional().describe("LinkedIn only: text added on top of the reshare."),
        target_linkedin_page_id: z.string().optional().describe("LinkedIn only: reshare as this organization Page."),
        mode: z.enum(["forward", "copy"]).optional().describe("Telegram only. Default forward."),
        target_chat_id: z.string().optional().describe("Telegram only: destination chat (@username or numeric id)."),
        target_user: z.string().optional().describe("Telegram only: another Upload-Post profile whose Telegram chat receives it."),
        post_ids: z.array(z.string()).min(1).max(100).optional().describe("Telegram only: several message ids (1-100) sent together."),
        all_messages: z.boolean().optional().describe("Telegram only: also send every message the post was split into."),
        params: paramsField("Telegram extras listed in the description."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Repost / forward a post",
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    safe(async (args) => {
      const { params, ...named } = args as { params?: Record<string, unknown>; [k: string]: unknown };
      return callRoute(client, { method: "POST", path: "/uploadposts/posts/repost" }, { ...(params ?? {}), ...compact(named) });
    })
  );

  const action = server.registerTool(
    "post_action",
    {
      title: "Act on a published post",
      description:
        "Actions on a published post. Bluesky: bookmark / unbookmark (private), pin / unpin on the profile (unpin takes no post_id), reply_settings (who can reply: `reply_settings` everyone, nobody, mention, following, followers or list:<at-uri>, one or several), quote_settings (`quote_settings` disable_quotes or everyone), detach_quote / reattach_quote (`quote_uri` = the post that quotes this one). " +
        "Telegram: react (`emoji`, or `params.telegram_reaction`, `params.telegram_is_big`), delete_reaction (removes another person's reaction in a group: `params.user_id` or `params.actor_chat_id`, needs `confirm`). " +
        "X: bookmark (optional folder_id, a bookmark folder) / unbookmark (private), unrepost (undo a repost the account made). Each counts toward the daily X write limit shared with replies, edits, reposts and likes (429 x_daily_write_limit); bookmarks need the X bookmark permission, so accounts connected before it get 403 x_reconnect_required (reconnect X); 502 x_write_outcome_unknown means X did not answer: check before retrying. " +
        "Bluesky likes and reposts are not available.",
      inputSchema: {
        user: z.string().describe("Upload-Post profile name."),
        platform: z.enum(["bluesky", "telegram", "x"]),
        action: z.enum([...BLUESKY_ACTIONS, ...TELEGRAM_ACTIONS, "unrepost"]),
        post_id: z.string().optional().describe("Bluesky: at:// URI or bsky.app link. Telegram: the post id returned by the upload. X: the post id."),
        folder_id: z.string().optional().describe("X bookmark only: bookmark folder id."),
        reply_settings: z.union([z.string(), z.array(z.string())]).optional().describe("Bluesky reply_settings action only."),
        quote_settings: z.enum(["disable_quotes", "everyone"]).optional().describe("Bluesky quote_settings action only."),
        quote_uri: z.string().optional().describe("Bluesky detach_quote / reattach_quote only."),
        emoji: z.string().optional().describe("Telegram react only: one emoji."),
        confirm: apiConfirmField,
        params: paramsField("Telegram reaction extras."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Act on a published post",
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    safe(async (args) => {
      const { params, ...named } = args as { params?: Record<string, unknown>; platform: string; action: string };
      if (!(POST_ACTIONS_BY_PLATFORM[named.platform] ?? []).includes(named.action)) {
        throw new Error(`Action '${named.action}' is not available on ${named.platform}.`);
      }
      return callRoute(client, { method: "POST", path: "/uploadposts/posts/action" }, { ...(params ?? {}), ...compact(named) });
    })
  );

  const bestTimes = server.registerTool(
    "get_best_times",
    {
      title: "Best times to post",
      description:
        "Best hours to publish for one connected account, from its own audience and post history. Answers `best_times` (hour, score), `by_hour`, `by_day` (0 = Monday), `source` (audience_activity, account_posts, upload_post_history or none) and `confidence`; with too little history `source` is none and `best_times` is empty. " +
        "Results are cached for 24 hours (YouTube 7 days). To fill the posting queue with these hours automatically, use update_queue_settings with slots \"auto\".",
      inputSchema: {
        profile_username: z.string().describe("Upload-Post profile name."),
        platform: z.enum(["tiktok", "instagram", "facebook", "youtube", "linkedin", "threads", "pinterest", "bluesky"]),
        timezone: z.string().optional().describe("IANA timezone for the hours, e.g. Europe/Madrid. Default: the queue's timezone, else UTC."),
        top: z.number().int().min(1).max(24).optional().describe("How many best hours to return. Default 5."),
        refresh: z.boolean().optional().describe("Recompute when the cached answer is at least 24 hours old (YouTube 7 days)."),
        page_urn: z.string().optional().describe("LinkedIn only: organization Page id or URN managed by the connection."),
        facebook_page_id: z.string().optional().describe("Facebook only: Page id managed by the connection."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Best times to post",
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    safe(async (args) =>
      client.request("GET", "/uploadposts/best-times", { query: compact(args as Record<string, unknown>) })
    )
  );

  return [edit, repost, action, bestTimes];
}
