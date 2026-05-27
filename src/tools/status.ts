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
      annotations: { readOnlyHint: true },
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
      annotations: { readOnlyHint: true },
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
      annotations: { readOnlyHint: true },
    },
    safe(async (args) =>
      client.sdk.getHistory(compact(args as Record<string, unknown>) as { page?: number; limit?: number })
    )
  );

  server.registerTool(
    "get_media",
    {
      title: "Get recent media from connected accounts",
      description:
        "Retrieve recent media (videos, photos, text posts) pulled directly from a profile's connected social accounts. Supports instagram, tiktok, youtube, linkedin, facebook, x, threads, pinterest, bluesky, reddit. Useful for browsing what already exists on a platform before posting more.",
      inputSchema: {
        user: z.string().optional().describe("Profile username to scope the query to."),
        platform: z.string().optional().describe("Restrict to a single platform key."),
        page_urn: z
          .string()
          .optional()
          .describe(
            "LinkedIn only. Numeric organization ID (e.g. '12345'), full URN ('urn:li:organization:12345'), or 'me' to force the personal profile. When omitted, accounts linked as an organization admin auto-resolve to the first administered organization; otherwise the personal profile is used.",
          ),
        limit: z.number().int().positive().max(200).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async (args) =>
      client.request("GET", "/uploadposts/media", {
        query: compact(args as Record<string, unknown>),
      })
    )
  );
}
