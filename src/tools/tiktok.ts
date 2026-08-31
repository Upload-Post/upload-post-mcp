import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import {
  cursorField,
  genericResultOutputSchema,
  limitField,
  requiresTiktokCapability,
  safe,
  tiktokProfileField,
} from "../schemas.js";

/** hide/pin act on a comment inside a video, so they need the video too. */
const ACTIONS_BY_TYPE: Record<string, { allowed: string[]; needsPost: boolean }> = {
  hide: { allowed: ["HIDE", "UNHIDE"], needsPost: true },
  like: { allowed: ["LIKE", "UNLIKE"], needsPost: false },
  pin: { allowed: ["PIN", "UNPIN"], needsPost: true },
};

const MAX_INSIGHTS_WINDOW_DAYS = 60;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse an ISO date as UTC midnight so the window maths never shifts a day. */
function parseIsoDate(value: string, field: string): number {
  const day = value.slice(0, 10);
  if (!ISO_DATE.test(day)) {
    throw new Error(`${field} must be an ISO date such as '2026-08-01'.`);
  }
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(ms)) {
    throw new Error(`${field} is not a valid date: ${value}`);
  }
  return ms;
}

export function registerTiktokTools(server: McpServer, client: UploadPostMcpClient): void {
  server.registerTool(
    "get_tiktok_comment_replies",
    {
      title: "Get TikTok comment replies",
      description:
        "List the replies hanging off one TikTok comment. Top-level comments come from get_post_comments with platform='tiktok'; this returns the thread underneath a single one of them, plus a `pagination.next_cursor` to page through it. " +
        requiresTiktokCapability("comments", true),
      inputSchema: {
        ...tiktokProfileField,
        post_id: z.string().describe("TikTok video ID the comment belongs to."),
        comment_id: z.string().describe("Comment whose replies you want (from get_post_comments)."),
        limit: limitField(50, "Replies"),
        ...cursorField,
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Get TikTok comment replies",
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    safe(async (args) =>
      client.request("GET", "/uploadposts/tiktok/comments/replies", {
        query: compact(args as Record<string, unknown>),
      })
    )
  );

  server.registerTool(
    "manage_tiktok_comment",
    {
      title: "Hide, like or pin a TikTok comment",
      description:
        "Moderate or react to a comment on one of the profile's own TikTok videos: hide it from other viewers, like it as the account, or pin it to the top. Every action has an inverse (HIDE/UNHIDE, LIKE/UNLIKE, PIN/UNPIN), so nothing here is permanent. `post_id` is required for hide and pin and ignored for like. " +
        requiresTiktokCapability("comments", true),
      inputSchema: {
        ...tiktokProfileField,
        type: z
          .enum(["hide", "like", "pin"])
          .describe("What to do: hide (visibility), like (react as the account) or pin (top of the thread)."),
        comment_id: z.string().describe("Comment to act on (from get_post_comments or get_tiktok_comment_replies)."),
        action: z
          .enum(["HIDE", "UNHIDE", "LIKE", "UNLIKE", "PIN", "UNPIN"])
          .describe("Direction of the action. Must match `type`: hide -> HIDE/UNHIDE, like -> LIKE/UNLIKE, pin -> PIN/UNPIN."),
        post_id: z
          .string()
          .optional()
          .describe("TikTok video ID the comment belongs to. Required for type=hide and type=pin; not used by type=like."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Hide, like or pin a TikTok comment",
        readOnlyHint: false,
        openWorldHint: true,
        // Every action is a toggle with an explicit inverse, so nothing is lost.
        destructiveHint: false,
      },
    },
    safe(async (args) => {
      const a = args as {
        profile: string;
        type: "hide" | "like" | "pin";
        comment_id: string;
        action: string;
        post_id?: string;
      };
      const rules = ACTIONS_BY_TYPE[a.type];
      if (!rules.allowed.includes(a.action)) {
        throw new Error(
          `action must be one of ${rules.allowed.join(" / ")} when type is '${a.type}'.`
        );
      }
      if (rules.needsPost && !a.post_id) {
        throw new Error(`post_id (the TikTok video ID) is required to ${a.type} a comment.`);
      }
      return client.request("POST", "/uploadposts/tiktok/comments/action", {
        body: compact({
          profile: a.profile,
          type: a.type,
          comment_id: a.comment_id,
          action: a.action,
          // TikTok's like endpoint takes no video, so don't send one.
          post_id: rules.needsPost ? a.post_id : undefined,
        }),
      });
    })
  );

  server.registerTool(
    "search_tiktok_keywords",
    {
      title: "Search TikTok keywords",
      description:
        "Discover what people actually search on TikTok around a word: pass `q` and get back the related search terms, useful for picking a caption, a hashtag set or the next video topic. " +
        requiresTiktokCapability("trend_search", true),
      inputSchema: {
        ...tiktokProfileField,
        q: z.string().min(1).describe("Seed keyword to explore, e.g. 'coffee recipe'."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Search TikTok keywords",
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    safe(async (args) =>
      client.request("GET", "/uploadposts/tiktok/search/keywords", {
        query: compact(args as Record<string, unknown>),
      })
    )
  );

  server.registerTool(
    "get_tiktok_profile_insights",
    {
      title: "Get TikTok profile insights",
      description:
        "Account-level TikTok insights for a date range: audience demographics (`audience.countries`, `.cities`, `.ages`, `.genders`), `activity_by_hour` (how many followers are online each hour — use it to pick posting times), `followers_daily`, `profile_actions` and `bio_description`. The window is at most 60 days and `end_date` must be before today. " +
        requiresTiktokCapability("profile_analytics"),
      inputSchema: {
        ...tiktokProfileField,
        start_date: z.string().describe("First day of the window, ISO date, e.g. '2026-07-01'."),
        end_date: z
          .string()
          .describe("Last day of the window, ISO date. Must be before today; TikTok has no data for the current day."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Get TikTok profile insights",
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    safe(async (args) => {
      const a = args as { profile: string; start_date: string; end_date: string };
      const start = parseIsoDate(a.start_date, "start_date");
      const end = parseIsoDate(a.end_date, "end_date");
      if (end < start) {
        throw new Error("end_date must be on or after start_date.");
      }
      const days = Math.round((end - start) / 86_400_000) + 1;
      if (days > MAX_INSIGHTS_WINDOW_DAYS) {
        throw new Error(
          `The window is ${days} days; TikTok returns at most ${MAX_INSIGHTS_WINDOW_DAYS}. Split the range into shorter calls.`
        );
      }
      const todayUtc = parseIsoDate(new Date().toISOString(), "today");
      if (end >= todayUtc) {
        throw new Error("end_date must be before today — TikTok has no insights for the current day.");
      }
      return client.request("GET", "/uploadposts/tiktok/insights", {
        query: compact({ profile: a.profile, start_date: a.start_date, end_date: a.end_date }),
      });
    })
  );

  server.registerTool(
    "get_tiktok_video_insights",
    {
      title: "Get TikTok video insights",
      description:
        "Per-video TikTok insights for the profile's recent posts: the retention curve, `impression_sources` (where the views came from — For You, following, search, profile…), `audience_types` (followers vs non-followers), `new_followers` won by the video, and watch-time figures. Cursor-paginated: feed `pagination.next_cursor` back as `cursor`. " +
        requiresTiktokCapability("profile_analytics"),
      inputSchema: {
        ...tiktokProfileField,
        limit: limitField(20, "Videos"),
        ...cursorField,
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Get TikTok video insights",
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    safe(async (args) =>
      client.request("GET", "/uploadposts/tiktok/videos/insights", {
        query: compact(args as Record<string, unknown>),
      })
    )
  );

  server.registerTool(
    "search_tiktok_hashtags",
    {
      title: "Search TikTok hashtags",
      description:
        "Find TikTok hashtags related to a word, each with its `view_count`, so a caption can be built from tags that actually have reach. Returns `{ hashtags: [{ name, view_count }] }`. " +
        requiresTiktokCapability("profile_analytics"),
      inputSchema: {
        ...tiktokProfileField,
        q: z.string().min(1).describe("Seed word or hashtag to explore, without the '#'."),
        country_code: z
          .string()
          .optional()
          .describe("ISO 3166-1 alpha-2 country to rank the hashtags for, e.g. 'ES' or 'US'."),
        language: z.string().optional().describe("Language code for the results, e.g. 'es' or 'en'."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Search TikTok hashtags",
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    safe(async (args) =>
      client.request("GET", "/uploadposts/tiktok/hashtags", {
        query: compact(args as Record<string, unknown>),
      })
    )
  );

  server.registerTool(
    "get_tiktok_benchmark",
    {
      title: "Get TikTok category benchmark",
      description:
        "Compare an account against its niche. Called without `category` it returns the 25 valid categories; called with one it returns that category's averages (engagement, views and the rest of the reference metrics) to benchmark the profile against. " +
        requiresTiktokCapability("profile_analytics"),
      inputSchema: {
        ...tiktokProfileField,
        category: z
          .string()
          .optional()
          .describe("Category to benchmark against. Omit to list the 25 categories the API accepts."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Get TikTok category benchmark",
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    safe(async (args) =>
      client.request("GET", "/uploadposts/tiktok/benchmark", {
        query: compact(args as Record<string, unknown>),
      })
    )
  );
}
