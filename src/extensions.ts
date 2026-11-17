import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AnalyticsPlatform } from "./schemas.js";
import { sdkOptionKeys } from "./sdk-options.js";

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

/**
 * Options the API takes but only a newer upload-post SDK sends (2.22.0: uploads
 * and generate-jwt are built from a fixed field list, AGENTS rule 6). Offered
 * only when the installed SDK reads the key, so no client is shown an option
 * that would be dropped.
 */
const TELEGRAM_PAID_BROADCAST: Shape = {
  telegramAllowPaidBroadcast: z
    .boolean()
    .optional()
    .describe(
      "Telegram: send faster than the free 30 messages per second by paying 0.1 Stars per message above it, from the bot's balance. Telegram only allows it to bots with at least 100,000 Stars and 100,000 monthly active users; otherwise the Telegram result fails (send it again without this option)."
    ),
};

function whenSdkSends(shape: Shape): Shape {
  const known = sdkOptionKeys();
  return Object.fromEntries(Object.entries(shape).filter(([key]) => known.has(key)));
}

export function applySecondWaveParameters(server: McpServer): void {
  const tools = registered(server);
  const widen = (name: string, edit: (shape: Shape) => void, descriptionSuffix?: string): void => {
    const tool = tools[name];
    if (!tool) return;
    const shape = shapeOf(tool);
    edit(shape);
    tool.update({
      paramsSchema: shape,
      ...(descriptionSuffix ? { description: `${tool.description ?? ""} ${descriptionSuffix}` } : {}),
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
  const paidBroadcast = whenSdkSends(TELEGRAM_PAID_BROADCAST);
  if (Object.keys(paidBroadcast).length) {
    for (const name of ["upload_video", "upload_photos", "upload_text"]) {
      widen(name, (s) => widenObjectField(s, "platformOptions", paidBroadcast));
    }
  }

  // Fields the API added to answers of existing tools, and the errors it gives.
  widen(
    "create_user",
    () => undefined,
    'A name already used in the account (capitals ignored) answers 409 "Username already in use": pick another or use the existing profile (list_users). 403 PROFILE_LIMIT_REACHED when the plan has no profile left (current_profiles, profile_limit).'
  );
  widen(
    "get_account_info",
    () => undefined,
    "`analyze_shorts` {limit, used, remaining, resets_at} is the AI Shorts analysis allowance of the current 30-day window (reading it uses none)."
  );
  widen(
    "get_queue_settings",
    () => undefined,
    "`configured: false` means the profile never saved queue settings and the answer shows the defaults."
  );
  const clientApproval = whenSdkSends({
    clientApproval: z
      .boolean()
      .optional()
      .describe(
        "Not generally available yet (post approvals). true lets the end client approve or reject this profile's pending posts from the connect page; generate again with false to turn it off."
      ),
  });
  if (Object.keys(clientApproval).length) widen("generate_jwt", (s) => Object.assign(s, clientApproval));

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
