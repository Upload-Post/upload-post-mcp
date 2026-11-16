import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AnalyticsPlatform } from "./schemas.js";
import { POST_ANALYTICS_LIVE_SENTENCE } from "./tools/analytics.js";

/**
 * Parameters added to EXISTING tools after the ChatGPT app review.
 *
 * ChatGPT keeps the exact schemas OpenAI reviewed (chatgpt-app-submission.json):
 * the tools are registered with those, and every other client gets them
 * widened here, once its profile is known. A new key joins ChatGPT's surface
 * with the next submission, not before (scripts/check-chatgpt-surface.mjs).
 */

type Shape = Record<string, z.ZodTypeAny>;

function registered(server: McpServer): Record<string, RegisteredTool> {
  // McpServer keeps no public lookup by name; this is the map it lists from.
  return (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
}

function shapeOf(tool: RegisteredTool): Shape {
  return { ...((tool.inputSchema as z.AnyZodObject).shape as Shape) };
}

/** Add keys to an optional object field (platformOptions), keeping its own description and passthrough. */
function widenObjectField(shape: Shape, key: string, extra: Shape): void {
  const field = shape[key];
  if (!field) return;
  const optional = field instanceof z.ZodOptional;
  const inner = (optional ? (field as z.ZodOptional<z.AnyZodObject>).unwrap() : field) as z.AnyZodObject;
  let widened: z.ZodTypeAny = inner.extend(extra);
  if (optional) widened = widened.optional();
  if (field.description) widened = widened.describe(field.description);
  shape[key] = widened;
}

/** Keep a field's description when its type changes. */
function retype(shape: Shape, key: string, type: z.ZodTypeAny): void {
  const description = shape[key]?.description;
  shape[key] = description ? type.describe(description) : type;
}

// ---- Publishing: sponsored content, Telegram, Bluesky, Google Business --------

const SPONSORED: Shape = {
  paidPartnership: z
    .boolean()
    .optional()
    .describe(
      "Mark the post as sponsored / paid partnership with each network's own label (TikTok branded content, YouTube paid product placement, X paid partnership; Facebook also needs facebookSponsorId). A network-specific field wins. Networks without a label publish without it and return a warning. Not allowed with TikTok privacy SELF_ONLY."
    ),
  facebookSponsorId: z
    .string()
    .optional()
    .describe("Facebook branded content: the sponsor's Page id (Page photos, videos and text posts; not Reels or Stories)."),
};

const TELEGRAM_COMMON: Shape = {
  telegramParseMode: z.enum(["HTML", "MarkdownV2"]).optional().describe("Telegram text formatting."),
  telegramReplyMarkup: z
    .union([z.string(), z.record(z.unknown())])
    .optional()
    .describe('Telegram buttons: InlineKeyboardMarkup JSON, e.g. {"inline_keyboard":[[{"text":"Shop","url":"https://…"}]]}.'),
  telegramDisableNotification: z.boolean().optional().describe("Telegram: send silently."),
  telegramProtectContent: z.boolean().optional().describe("Telegram: members cannot forward or save it."),
  telegramPin: z.boolean().optional().describe("Telegram: pin the post after publishing."),
  telegramMessageThreadId: z.number().int().optional().describe("Telegram: forum topic to post in."),
  telegramReplyToMessageId: z.number().int().optional().describe("Telegram: reply to this message of the chat."),
  telegramFirstCommentAsReply: z
    .boolean()
    .optional()
    .describe("Telegram: send the first comment as a reply to the post (true) or as a separate message (false)."),
};

const TELEGRAM_MEDIA: Shape = {
  telegramHasSpoiler: z.boolean().optional().describe("Telegram: hide the media behind a spoiler."),
  telegramShowCaptionAboveMedia: z.boolean().optional().describe("Telegram: caption above the media."),
  telegramCaptionOverflow: z
    .enum(["truncate", "split"])
    .optional()
    .describe("Telegram caption over 1024 characters: truncate (default: the request is refused) or split (the rest goes as a reply)."),
  telegramAsDocument: z.boolean().optional().describe("Telegram: send the file as a document, uncompressed."),
};

const TELEGRAM_TEXT: Shape = {
  telegramPoll: z
    .union([z.string(), z.record(z.unknown())])
    .optional()
    .describe('Telegram: send a poll or quiz instead of a text message, e.g. {"options":["Yes","No"],"is_anonymous":false}; the question defaults to the post text.'),
  telegramLocation: z
    .union([z.string(), z.record(z.unknown())])
    .optional()
    .describe("Telegram: send a location ({latitude, longitude, live_period…})."),
  telegramVenue: z
    .union([z.string(), z.record(z.unknown())])
    .optional()
    .describe("Telegram: send a venue ({latitude, longitude, title, address…})."),
  telegramContact: z
    .union([z.string(), z.record(z.unknown())])
    .optional()
    .describe("Telegram: send a contact card ({phone_number, first_name, last_name, vcard})."),
  telegramDice: z.union([z.string(), z.boolean()]).optional().describe("Telegram: send an animated dice (an emoji such as 🎲 🎯 🏀, or true)."),
  telegramLinkPreview: z.boolean().optional().describe("Telegram: false turns the link preview off."),
};

const BLUESKY_COMMON: Shape = {
  blueskyTags: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("Bluesky: up to 8 extra hashtags stored on the post without appearing in the text."),
  blueskyThreadgate: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("Bluesky: who can reply — nobody, mention, following, followers or list:<at-uri>, one or several. Default everyone."),
  blueskyPostgate: z.literal("disable_quotes").optional().describe("Bluesky: disable_quotes stops others quoting the post."),
  blueskyQuoteUri: z.string().optional().describe("Bluesky: quote this post (at:// URI or bsky.app link)."),
};

const YOUTUBE_VIDEO: Shape = {
  youtubeLocalizations: z
    .union([z.string(), z.record(z.record(z.string()))])
    .optional()
    .describe('YouTube title and description translations: {"es": {"title": "…", "description": "…"}}. Needs the video\'s default language (youtubeDefaultLanguage or set before).'),
  youtubeBrandPartner: z
    .string()
    .optional()
    .describe("YouTube paid partnership: the brand's channel id (UC…, 24 characters; handles are not accepted)."),
};

const BLUESKY_VIDEO: Shape = {
  blueskyCaptions: z
    .union([z.string(), z.array(z.record(z.unknown()))])
    .optional()
    .describe('Bluesky video subtitles, one per language: [{"lang":"es","url":"https://…/es.vtt"}] (WebVTT, up to 20).'),
  blueskyVideoPresentation: z.enum(["default", "gif"]).optional().describe("Bluesky: gif plays the video looping, muted, without controls."),
};

const BLUESKY_PHOTO: Shape = {
  blueskyGifAsVideo: z.boolean().optional().describe("Bluesky: publish a single animated GIF as a looping video."),
};

const BLUESKY_TEXT: Shape = {
  blueskyThreadOverflow: z
    .boolean()
    .optional()
    .describe("Bluesky: text longer than one post (300 characters) continues as replies instead of being cut."),
};

const GBP_COMMON: Shape = {
  gbpScheduledTime: z
    .string()
    .optional()
    .describe("Google Business: let Google publish the post at this time (RFC 3339 with offset, up to a year ahead)."),
  gbpRecurrence: z.enum(["DAILY", "WEEKLY", "MONTHLY"]).optional().describe("Google Business: repeat the post."),
  gbpRecurrenceDays: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("Google Business WEEKLY recurrence: days (MONDAY…SUNDAY)."),
  gbpRecurrenceDayOfMonth: z.number().int().min(1).max(31).optional().describe("Google Business MONTHLY recurrence: day of the month."),
  gbpRecurrenceWeekOccurrence: z
    .enum(["FIRST", "SECOND", "THIRD", "FOURTH", "LAST"])
    .optional()
    .describe("Google Business MONTHLY recurrence: week of the month, with gbpRecurrenceDays."),
  gbpRecurrenceEnd: z.string().optional().describe("Google Business: end of the series (YYYY-MM-DD or RFC 3339). Required with gbpRecurrence."),
  gbpUploadToGallery: z.boolean().optional().describe("Google Business: also add the post's photo or video to the location's gallery."),
};

const GBP_PHOTO: Shape = {
  gbpMultiMedia: z.boolean().optional().describe("Google Business: attach every photo of the call to the post (up to 10) instead of only the first."),
};

// ---- Other existing tools ------------------------------------------------------

const AnalyticsPlatformWithTelegram = z.enum([...AnalyticsPlatform.options, "telegram"]);

export function applySecondWaveParameters(server: McpServer): void {
  const tools = registered(server);
  const widen = (
    name: string,
    edit: (shape: Shape) => void,
    descriptionSuffix?: string,
    rewrite?: (description: string) => string
  ): void => {
    const tool = tools[name];
    if (!tool) return;
    const shape = shapeOf(tool);
    edit(shape);
    let description = tool.description ?? "";
    if (rewrite) description = rewrite(description);
    if (descriptionSuffix) description = `${description} ${descriptionSuffix}`;
    tool.update({
      paramsSchema: shape,
      ...(rewrite || descriptionSuffix ? { description } : {}),
    });
  };

  widen("upload_video", (s) =>
    widenObjectField(s, "platformOptions", { ...SPONSORED, ...YOUTUBE_VIDEO, ...TELEGRAM_COMMON, ...TELEGRAM_MEDIA, ...BLUESKY_COMMON, ...BLUESKY_VIDEO, ...GBP_COMMON })
  );
  widen("upload_photos", (s) =>
    widenObjectField(s, "platformOptions", {
      ...SPONSORED,
      ...TELEGRAM_COMMON,
      ...TELEGRAM_MEDIA,
      ...BLUESKY_COMMON,
      ...BLUESKY_PHOTO,
      ...GBP_COMMON,
      ...GBP_PHOTO,
    })
  );
  widen("upload_text", (s) =>
    widenObjectField(s, "platformOptions", { ...SPONSORED, ...TELEGRAM_COMMON, ...TELEGRAM_TEXT, ...BLUESKY_COMMON, ...BLUESKY_TEXT, ...GBP_COMMON })
  );

  widen(
    "update_queue_settings",
    (s) => {
      retype(
        s,
        "slots",
        z
          .union([(s.slots as z.ZodOptional<z.ZodTypeAny>).unwrap(), z.literal("auto")])
          .optional()
          .describe(
            'Posting slots sorted by local time, e.g. [{hour: 10, minute: 0}, {hour: 16, minute: 0}], or "auto" to use each day the best hours of the profile\'s accounts (see get_best_times), with these slots as fallback while there is not enough data.'
          )
      );
      s.slots_mode = z.enum(["auto", "fixed"]).optional().describe('Same as slots "auto"; "fixed" goes back to the fixed slots.');
      s.auto_slots_count = z.number().int().min(1).max(12).optional().describe("Auto mode: hours per day. Default: the number of fixed slots, or 3.");
      s.auto_platforms = z
        .array(z.string())
        .max(6)
        .optional()
        .describe("Auto mode: networks whose best hours count (up to 6). Default: every connected one except X.");
      s.refresh = z.boolean().optional().describe("Auto mode: recompute the best hours now (only when the cached ones are at least 24 hours old).");
    },
    'With slots "auto", get_queue_settings returns `slots_mode`, `auto_slots` and `effective_slots` (what the queue uses).'
  );

  widen(
    "unpublish_post",
    (s) => {
      retype(s, "platform", z.enum([...(s.platform as z.ZodEnum<[string, ...string[]]>).options, "telegram"]));
      s.delete_all_messages = z
        .boolean()
        .optional()
        .describe("Telegram only: also delete every message the post was split into (album, rest of a long caption, first comment).");
    },
    "Telegram posts can be deleted too: pass the post id returned by the upload."
  );

  widen("get_analytics", (s) => retype(s, "platforms", z.array(AnalyticsPlatformWithTelegram).optional()), "Telegram returns `followers` (subscribers or members), `boosts_active` and the chat's title and link; Telegram reports no views.");
  applyAnalyticsFreshness(widen);

  widen("list_dm_conversations", (s) => {
    s.kind = z.literal("direct").optional().describe("Bluesky only: only direct (1:1) conversations.");
    s.view = z
      .literal("summary")
      .optional()
      .describe("Bluesky only: up to 100 conversations per page, each with only its latest message (fastest).");
    s.include = z
      .literal("unread_counts")
      .optional()
      .describe("Bluesky only: add `unread_counts` {accepted, request} to the answer.");
  });
}

// ---- Analytics: freshness, periods, daily history, cached listing ---------------

type Widen = (
  name: string,
  edit: (shape: Shape) => void,
  descriptionSuffix?: string,
  rewrite?: (description: string) => string
) => void;

const DATE = (what: string) => z.string().optional().describe(`${what}, YYYY-MM-DD.`);

/** Replaces POST_ANALYTICS_LIVE_SENTENCE: a read is not always live any more. */
export const POST_ANALYTICS_FRESHNESS =
  "Freshness: each platform entry carries `as_of` (when the network was asked for these numbers) and `next_refresh_at` (the earliest moment a new call can return newer numbers; null = only `refresh: true` refreshes it). Depending on the post's age Upload-Post may answer from its last stored reading instead of asking the network again (`served_from`: `snapshot` or `live`), and repeated calls within 5 minutes return the same result, so do not poll: ask again after `next_refresh_at`. Pass `refresh: true` only when the user needs numbers newer than `as_of`; it is limited per hour (past the limit the stored reading comes back with `refresh_limited: true`). X and YouTube posts are only updated when someone reads them, never in the background. A metric the network did not report is listed in `missing` with a reason (`not_supported`, `reauth_required`, `quota`, `platform_delay`, `not_fetched`), never sent as 0. Watch time also comes normalized: `avg_watch_seconds` and `watch_time_seconds` in seconds, `completion_rate` in percent (0-100); the network's own keys keep their unit (Instagram `ig_reels_avg_watch_time` is in milliseconds). Reading changes nothing on the post or the account, and is limited to 100 per 5 minutes. With `daily: true` it returns the post's day-by-day history instead, from stored readings only (no call to the network, not rate limited): one row per day that has a reading, with `delta` gained over `gap_days` (never an invented per-day value); with requestId it needs `platform`.";

export const CACHED_POST_ANALYTICS_DESCRIPTION =
  "Bulk re-read of per-post metrics Upload-Post already stored, without calling the networks, so it is not subject to the 100 requests / 5 minutes per-post limit: prefer it to scan many posts, rank them or page through a profile's history. Each row's `as_of` is when that post was last read from its network; rows never refresh by themselves (`next_refresh_at` is null), so to refresh one post call get_post_analytics for it. By default it holds the posts read through get_post_analytics; `origin: \"external\"` returns posts NOT published with Upload-Post that account reads (get_analytics) already listed, `origin: \"all\"` both. Rows of posts published with Upload-Post carry `request_id`, `post_title` and `caption_preview`. Rank with `sort` (views, likes, comments, shares, engagement, published_at or as_of; prefix `-` for descending, e.g. `-views`) and filter by publish day instead of reading day with `date_field: \"published_at\"`. When `published_posts_in_range` is much larger than `cached_posts_in_range`, many posts were never read: say so instead of presenting partial totals as complete. Paginated: pass `next_cursor` back as `cursor` until `has_more` is false.";

function applyAnalyticsFreshness(widen: Widen): void {
  widen(
    "get_analytics",
    (s) => {
      s.since = DATE("Start of a period (adds a `period` block per platform, from stored daily snapshots; no extra call to the networks)");
      s.until = DATE("End of the period (default today, UTC; at most 366 days)");
      s.compare = z.enum(["previous"]).optional().describe("`previous` adds the previous period of the same length and `vs_previous`.");
    },
    "Each platform block carries `as_of` / `next_refresh_at` (account numbers are cached: do not poll), `missing` (metric -> reason, never a fake 0) and `views_field` (the field holding views comparable with the native app; null where the network reports impressions or a score instead). TikTok and X add `coverage`: how many posts the totals are built from (X reads only the latest posts, e.g. 10 of at least 31). Account totals are mostly last-30-day windows set by each network; never add them up day by day. For a date range pass `since` / `until` (and `compare: \"previous\"`): the `period` block gives `start` / `end` / `change` for followers-like counters and the `latest` value of window totals."
  );
  widen(
    "get_total_impressions",
    () => {},
    "`total_impressions` is a legacy mix of reach and impressions kept for compatibility; to compare with what the native apps show, use `views_total` and `views_by_platform` (views only), and `views_not_counted` for networks that report impressions or a score instead."
  );
  widen(
    "get_post_analytics",
    (s) => {
      s.refresh = z
        .boolean()
        .optional()
        .describe("Ask the network again even if a recent stored reading exists. Only when the user needs fresher numbers than `as_of`; limited per hour.");
      s.daily = z
        .boolean()
        .optional()
        .describe("Return the post's day-by-day history (stored readings, no network call) instead of its current metrics. With requestId, `platform` is required.");
      s.since = DATE("With daily: first day");
      s.until = DATE("With daily: last day");
    },
    undefined,
    (d) => {
      if (!d.includes(POST_ANALYTICS_LIVE_SENTENCE)) throw new Error("get_post_analytics description changed: update POST_ANALYTICS_LIVE_SENTENCE");
      return d.replace(POST_ANALYTICS_LIVE_SENTENCE, POST_ANALYTICS_FRESHNESS);
    }
  );
  widen(
    "get_cached_post_analytics",
    (s) => {
      retype(
        s,
        "platform",
        z.enum(["instagram", "tiktok", "youtube", "facebook", "linkedin", "x", "threads", "pinterest", "reddit", "bluesky"]).optional()
      );
      s.sort = z
        .string()
        .optional()
        .describe("views, likes, comments, shares, engagement, published_at or as_of; prefix `-` for descending (e.g. `-views`). Omit for the usual order.");
      s.order = z.enum(["asc", "desc"]).optional().describe("Overrides the `-` prefix of `sort`.");
      s.date_field = z
        .enum(["captured_at", "published_at"])
        .optional()
        .describe("What `since` / `until` filter on: the day of the reading (default) or the day the post was published (posts published with Upload-Post).");
      s.origin = z
        .enum(["external", "all"])
        .optional()
        .describe("`external`: posts not published with Upload-Post, listed by account reads. `all`: both. Omit for posts read through get_post_analytics.");
    },
    undefined,
    () => CACHED_POST_ANALYTICS_DESCRIPTION
  );
}
