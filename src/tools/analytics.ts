import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { AnalyticsPlatform, safe } from "../schemas.js";

export function registerAnalyticsTools(server: McpServer, client: UploadPostMcpClient): void {
  server.registerTool(
    "get_analytics",
    {
      title: "Get profile analytics",
      description:
        "Aggregated analytics for a profile across selected platforms (followers, views, engagement).",
      inputSchema: {
        profileUsername: z.string(),
        platforms: z.array(AnalyticsPlatform).optional(),
        pageId: z.string().optional().describe("Facebook page ID, if filtering by page."),
        pageUrn: z.string().optional().describe("LinkedIn page URN, if filtering by company page."),
      },
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
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async ({ requestId }) => client.sdk.getPostAnalytics(requestId as string))
  );

  server.registerTool(
    "get_platform_metrics",
    {
      title: "List platform metrics",
      description:
        "Reference: which metrics are available per platform (impressions, likes, …) and their human labels.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async () => client.sdk.getPlatformMetrics())
  );
}
