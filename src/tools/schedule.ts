import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { genericResultOutputSchema, safe } from "../schemas.js";

export function registerScheduleTools(server: McpServer, client: UploadPostMcpClient): void {
  server.registerTool(
    "list_scheduled",
    {
      title: "List scheduled posts",
      description: "List all currently scheduled (not-yet-published) posts.",
      inputSchema: {},
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "List scheduled posts",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
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
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Cancel scheduled post",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
      },
    },
    safe(async ({ jobId }) => client.sdk.cancelScheduled(jobId as string))
  );

  server.registerTool(
    "edit_scheduled",
    {
      title: "Edit scheduled post",
      description:
        "Edit a pending scheduled post in place, keeping its job ID and media: reschedule it (scheduledDate/timezone) and/or fix its text. `title` and `caption` rewrite the text for EVERY platform of the post; to change only some platforms, send `platformContent` instead, e.g. {\"instagram\":{\"caption\":\"...\"},\"tiktok\":{\"caption\":\"...\"}} — platforms not listed keep their text. First comments cannot be edited on a pending post.",
      inputSchema: {
        jobId: z.string(),
        scheduledDate: z.string().optional().describe("New date, ISO 8601."),
        timezone: z.string().optional().describe("IANA timezone for scheduledDate."),
        title: z.string().optional().describe("New title for every platform of the post."),
        caption: z.string().optional().describe("New caption/description for every platform of the post."),
        platformContent: z
          .record(
            z.string(),
            z.object({ title: z.string().optional(), caption: z.string().optional() })
          )
          .optional()
          .describe("Per-platform text, keyed by platform (instagram, tiktok, youtube, facebook, linkedin, x, threads…). Only the platforms listed are changed."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Edit scheduled post",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
      },
    },
    safe(async (args) => {
      const a = args as {
        jobId: string;
        scheduledDate?: string;
        timezone?: string;
        title?: string;
        caption?: string;
        platformContent?: Record<string, { title?: string; caption?: string }>;
      };
      return client.request("PATCH", `/uploadposts/schedule/${encodeURIComponent(a.jobId)}`, {
        body: compact({
          scheduled_date: a.scheduledDate,
          timezone: a.timezone,
          title: a.title,
          caption: a.caption,
          platform_content: a.platformContent,
        }),
      });
    })
  );
}
