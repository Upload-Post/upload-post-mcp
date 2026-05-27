import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { safe } from "../schemas.js";

export function registerQueueTools(server: McpServer, client: UploadPostMcpClient): void {
  server.registerTool(
    "get_queue_settings",
    {
      title: "Get queue settings",
      description: "Posting queue configuration (slots per day, time windows, timezone).",
      inputSchema: {
        profile_username: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async (args) =>
      client.request("GET", "/uploadposts/queue/settings", {
        query: compact(args as Record<string, unknown>),
      })
    )
  );

  server.registerTool(
    "update_queue_settings",
    {
      title: "Update queue settings",
      description:
        "Replace the posting-queue configuration. Pass the full desired settings object under `settings`.",
      inputSchema: {
        profile_username: z.string().optional(),
        settings: z.record(z.unknown()),
      },
      // Replaces the existing config wholesale → mark as destructive so callers
      // confirm before overwriting.
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    safe(async (args) =>
      client.request("POST", "/uploadposts/queue/settings", {
        body: compact(args as Record<string, unknown>),
      })
    )
  );

  server.registerTool(
    "preview_queue",
    {
      title: "Preview queue",
      description:
        "Preview the upcoming queue slots and what would land in them. Optionally `nextSlot=true` returns just the next available slot timestamp.",
      inputSchema: {
        profile_username: z.string().optional(),
        nextSlot: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async (args) => {
      const { nextSlot, ...rest } = args as { nextSlot?: boolean; [k: string]: unknown };
      const path = nextSlot ? "/uploadposts/queue/next-slot" : "/uploadposts/queue/preview";
      return client.request("GET", path, { query: compact(rest) });
    })
  );
}
