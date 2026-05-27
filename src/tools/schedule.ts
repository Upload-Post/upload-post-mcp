import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { safe } from "../schemas.js";

export function registerScheduleTools(server: McpServer, client: UploadPostMcpClient): void {
  server.registerTool(
    "list_scheduled",
    {
      title: "List scheduled posts",
      description: "List all currently scheduled (not-yet-published) posts.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe(async () => client.sdk.listScheduled())
  );

  server.registerTool(
    "cancel_scheduled",
    {
      title: "Cancel scheduled post",
      description: "Cancel a scheduled post by its `job_id`.",
      inputSchema: {
        jobId: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    safe(async ({ jobId }) => client.sdk.cancelScheduled(jobId as string))
  );

  server.registerTool(
    "edit_scheduled",
    {
      title: "Edit scheduled post",
      description: "Reschedule a post: change date and/or timezone.",
      inputSchema: {
        jobId: z.string(),
        scheduledDate: z.string().optional(),
        timezone: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    safe(async (args) => {
      const { jobId, ...rest } = args as { jobId: string; [k: string]: unknown };
      return client.sdk.editScheduled(
        jobId,
        compact(rest) as { scheduledDate?: string; timezone?: string }
      );
    })
  );
}
