import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { AnalyticsPlatform, genericResultOutputSchema, safe } from "../schemas.js";

export function registerAnalyticsTools(server: McpServer, client: UploadPostMcpClient): void {
  server.registerTool(
    "get_analytics",
    {
      title: "Get profile analytics",
      description:
        "Aggregated analytics for a profile across selected platforms (followers, views, engagement). Instagram also returns two audience breakdowns with the same shape (age / gender / country / city): `follower_demographics` for the account's followers and `engaged_audience_demographics` for the accounts that engaged with its content.",
      inputSchema: {
        profileUsername: z.string(),
        platforms: z.array(AnalyticsPlatform).optional(),
        pageId: z.string().optional().describe("Facebook page ID, if filtering by page."),
        pageUrn: z.string().optional().describe("LinkedIn organization/company page URN or numeric ID. LinkedIn analytics are only available for pages you administer — personal profiles are not supported. Defaults to the first administered page."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Get profile analytics",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async (args) => {
      const { profileUsername, ...rest } = args as {
        profileUsername: string;
        [k: string]: unknown;
      };
      return client.sdk.getAnalytics(profileUsername, compact(rest) as never);
    })
  );

  server.registerTool(
    "get_total_impressions",
    {
      title: "Get total impressions",
      description:
        "Sum of impressions for a profile from daily snapshots. Use `period` for presets, or `startDate`/`endDate` for custom ranges.",
      inputSchema: {
        profileUsername: z.string(),
        period: z
          .enum(["last_day", "last_week", "last_month", "last_3months", "last_year"])
          .optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        date: z.string().optional(),
        platforms: z.array(AnalyticsPlatform).optional(),
        breakdown: z.boolean().optional(),
        metrics: z.array(z.string()).optional(),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Get total impressions",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async (args) => {
      const { profileUsername, ...rest } = args as {
        profileUsername: string;
        [k: string]: unknown;
      };
      return client.sdk.getTotalImpressions(profileUsername, compact(rest) as never);
    })
  );

  server.registerTool(
    "get_post_analytics",
    {
      title: "Get post analytics",
      description:
        "Per-platform metrics for one post. Identify it EITHER by `requestId` (a post published through Upload-Post, including TikTok drafts once they are published publicly from the TikTok app; add `platform` to read only that platform) OR by `platformPostId` + `platform` + `user` together (any post on the connected account, e.g. one returned by get_media, even if it was not published through Upload-Post). `post_metrics` carries whatever each platform reports, so its shape is not the same everywhere: on TikTok it adds `retention` (the curve, second by second), `impression_sources` (For You, following, search, profile…), `audience_types` (followers vs non-followers), `new_followers` won by the post, `reach` and the watch times (`average_time_watched`, `total_time_watched`, `full_video_watched_rate`) on top of the usual counters. " +
        "TikTok drafts: until the draft is published from the TikTok app, `post_metrics_error` says it is still in the inbox; a draft published as private has no per-post analytics; once published publicly the entry carries the real `platform_post_id`, `post_url`, `draft_published_at` and `original_publish_id` (the TikTok publish id the upload started with). A TikTok upload more than 30 days old that never got a post id is no longer looked up: read it by `platformPostId`. " +
        "It fetches the metrics live from the platform and changes nothing on the post or the account; Upload-Post keeps a copy of the result, which later reads of the same post can get from get_cached_post_analytics. Repeated calls for the same post within 5 minutes return the same result; live reads are limited to 100 per 5 minutes. When one platform cannot answer (for example, X's daily limit on live post reads), its entry carries `post_metrics_error` instead of `post_metrics` and the other platforms still answer.",
      inputSchema: {
        requestId: z
          .string()
          .optional()
          .describe("`request_id` of an upload made through Upload-Post. Use this OR platformPostId + platform + user."),
        platformPostId: z
          .string()
          .optional()
          .describe("The post's own id on the platform (e.g. Instagram media id, TikTok video id). Needs `platform` and `user` too."),
        platform: z
          .enum(["instagram", "tiktok", "youtube", "facebook", "linkedin", "x", "threads", "pinterest", "reddit", "bluesky"])
          .optional()
          .describe("Platform of the post. Required with platformPostId; with requestId it limits the answer to that platform."),
        user: z
          .string()
          .optional()
          .describe("Upload-Post profile name that owns the account. Required with platformPostId."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Get post analytics",
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    safe(async (args) => {
      const a = args as { requestId?: string; platformPostId?: string; platform?: string; user?: string };
      if (a.requestId && a.platformPostId) {
        throw new Error("Pass either requestId or platformPostId (with platform and user), not both.");
      }
      if (a.platformPostId || (!a.requestId && (a.platform || a.user))) {
        const missing = (["platformPostId", "platform", "user"] as const).filter((k) => !a[k]);
        if (missing.length) {
          throw new Error(
            `Reading a post by its platform id needs platformPostId, platform and user together; missing: ${missing.join(", ")}. Or pass requestId.`
          );
        }
        return client.sdk.getPostAnalyticsByPlatformId(a.platformPostId as string, a.platform as string, a.user as string);
      }
      if (!a.requestId) {
        throw new Error("Pass requestId, or platformPostId + platform + user.");
      }
      if (a.platform) {
        return client.request("GET", `/uploadposts/post-analytics/${encodeURIComponent(a.requestId)}`, {
          query: { platform: a.platform },
        });
      }
      return client.sdk.getPostAnalytics(a.requestId);
    })
  );

  server.registerTool(
    "get_cached_post_analytics",
    {
      title: "Get cached post analytics",
      description:
        "Replays per-post metrics Upload-Post already fetched, instead of calling the platforms again. ONLY contains posts previously fetched through `get_post_analytics`; there is no background refresh, so `captured_at` is the last time that post was read live and a post never queried live will be absent. Unlike `get_post_analytics` it never hits the platforms, so it is not subject to the live analytics rate limit (100 requests / 5 minutes) — prefer it when scanning many posts or paging through a profile's history. Paginated: pass `next_cursor` from the response back as `cursor` until `has_more` is false.",
      inputSchema: {
        user: z.string().describe("Profile username whose posts to read."),
        // Narrower than AnalyticsPlatform: the snapshot cache has no X/Twitter posts.
        platform: z
          .enum(["instagram", "tiktok", "youtube", "facebook", "linkedin", "threads", "pinterest", "reddit"])
          .optional()
          .describe("Restrict to one platform. Omit for all platforms."),
        limit: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .describe("Posts per page. Defaults to 50, max 200."),
        cursor: z.string().optional().describe("Opaque cursor from a previous response's `next_cursor`."),
        since: z.string().optional().describe("Start date, YYYY-MM-DD. Defaults to 30 days ago."),
        until: z.string().optional().describe("End date, YYYY-MM-DD. Defaults to today."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Get cached post analytics",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    // Raw HTTP rather than the SDK: this endpoint is newer than the `upload-post`
    // version pinned in package.json, same as `get_media` in status.ts.
    safe(async (args) =>
      client.request("GET", "/uploadposts/post-analytics/cached", {
        query: compact(args as Record<string, unknown>),
      })
    )
  );

  server.registerTool(
    "get_platform_metrics",
    {
      title: "List platform metrics",
      description:
        "Reference: which metrics are available per platform (impressions, likes, …) and their human labels.",
      inputSchema: {},
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "List platform metrics",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async () => client.sdk.getPlatformMetrics())
  );
}
