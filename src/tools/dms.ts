import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { genericResultOutputSchema, safe } from "../schemas.js";

export function registerDmTools(server: McpServer, client: UploadPostMcpClient): void {
  server.registerTool(
    "send_dm",
    {
      title: "Send a direct message",
      description:
        "Send an Instagram DM to a recipient from a connected Upload-Post profile. Use a recipient_id returned by Instagram comments or DM conversation tools.",
      inputSchema: {
        user: z.string().describe("Upload-Post profile name that owns the connected Instagram account."),
        platform: z.literal("instagram").describe("DM platform. Currently only Instagram DMs are supported."),
        recipient_id: z
          .string()
          .describe("Instagram recipient/commenter ID. Required by the Upload-Post API."),
        message: z.string().min(1).describe("DM body to send."),
        buttons: z
          .array(z.object({ title: z.string(), url: z.string().url() }))
          .max(3)
          .optional()
          .describe("Up to 3 web_url buttons rendered in the DM. Each item is { title, url }."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
      },
    },
    safe(async (args) =>
      client.request("POST", "/uploadposts/dms/send", {
        body: compact(args as Record<string, unknown>),
      })
    )
  );

  server.registerTool(
    "list_dm_conversations",
    {
      title: "List DM conversations",
      description: "Recent DM conversations for a profile on a given platform.",
      inputSchema: {
        user: z.string(),
        platform: z.string().optional(),
        limit: z.number().int().positive().max(200).optional(),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async (args) =>
      client.request("GET", "/uploadposts/dms/conversations", {
        query: compact(args as Record<string, unknown>),
      })
    )
  );

  server.registerTool(
    "manage_autodms",
    {
      title: "Manage automatic DM monitoring",
      description:
        "Control Instagram AutoDM monitors. For action='start', provide post_url, reply_message, and profile_username. For stop/pause/resume/delete/logs, provide monitor_id. For status, optionally set include_inactive=true.",
      inputSchema: {
        action: z.enum(["start", "stop", "pause", "resume", "delete", "status", "logs"]),
        profile_username: z
          .string()
          .optional()
          .describe("Upload-Post profile name. Required when action='start'."),
        post_url: z
          .string()
          .optional()
          .describe("Instagram post URL to monitor. Required when action='start'."),
        reply_message: z
          .string()
          .optional()
          .describe("DM text sent to matching commenters. Required when action='start'."),
        buttons: z
          .array(z.object({ title: z.string(), url: z.string().url() }))
          .max(3)
          .optional()
          .describe("For action='start': up to 3 web_url buttons ({ title, url }) added to each auto-DM."),
        monitoring_interval: z
          .number()
          .int()
          .min(15)
          .optional()
          .describe("Polling interval in minutes for action='start'. Minimum is 15."),
        trigger_keywords: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe("Optional keyword or keywords; only comments containing these terms receive a DM."),
        monitor_id: z
          .string()
          .optional()
          .describe("AutoDM monitor ID. Required for stop, pause, resume, delete, and logs."),
        include_inactive: z
          .boolean()
          .optional()
          .describe("For action='status', include stopped and expired monitors when true."),
      },
      outputSchema: genericResultOutputSchema,
      // `action` can be read-only (status/logs) or destructive (stop/delete). We
      // report the worst case (destructive) so callers default to confirmation.
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
      },
    },
    safe(async (args) => {
      const { action, ...rest } = args as {
        action: string;
        [key: string]: unknown;
      };
      const isGet = action === "status" || action === "logs";
      const path = `/uploadposts/autodms/${action}`;
      if (isGet) {
        return client.request("GET", path, {
          query: compact(rest),
        });
      }
      return client.request("POST", path, {
        body: compact(rest),
      });
    })
  );
}
