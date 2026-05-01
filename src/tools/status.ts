import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { safe } from "../schemas.js";

export function registerStatusTools(server: McpServer, client: UploadPostMcpClient): void {
  server.registerTool(
    "get_status",
    {
      title: "Get async upload status",
      description:
        "Check the status of an async upload by `request_id`. Poll this until `status` is 'success' or 'failed'.",
      inputSchema: {
        requestId: z.string(),
      },
    },
    safe(async ({ requestId }) => client.sdk.getStatus(requestId as string))
  );

  server.registerTool(
    "get_job_status",
    {
      title: "Get scheduled job status",
      description:
        "Check the status of a scheduled or queued upload by `job_id`. Use this for posts created with `addToQueue` or `scheduledDate`.",
      inputSchema: {
        jobId: z.string(),
      },
    },
    safe(async ({ jobId }) => client.sdk.getJobStatus(jobId as string))
  );

  server.registerTool(
    "get_history",
    {
      title: "Get upload history",
      description: "Paginated history of uploads across all profiles.",
      inputSchema: {
        page: z.number().int().positive().optional(),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    safe(async (args) =>
      client.sdk.getHistory(compact(args as Record<string, unknown>) as { page?: number; limit?: number })
    )
  );

  server.registerTool(
    "get_daily_limits",
    {
      title: "Get daily upload limits",
      description: "Current daily upload quota usage for the account.",
      inputSchema: {},
    },
    safe(async () => client.request("GET", "/uploadposts/limits/daily"))
  );
}
