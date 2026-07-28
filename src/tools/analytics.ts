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
      description: "Per-platform metrics for a specific post identified by `request_id`.",
      inputSchema: {
        requestId: z.string(),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async ({ requestId }) => client.sdk.getPostAnalytics(requestId as string))
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
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async () => client.sdk.getPlatformMetrics())
  );
}
