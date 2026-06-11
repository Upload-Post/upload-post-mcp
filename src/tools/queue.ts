import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { genericResultOutputSchema, safe } from "../schemas.js";

export function registerQueueTools(server: McpServer, client: UploadPostMcpClient): void {
  server.registerTool(
    "get_queue_settings",
    {
      title: "Get queue settings",
      description: "Posting queue configuration (slots per day, time windows, timezone).",
      inputSchema: {
        profile_username: z.string().optional(),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
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
        "Update posting queue configuration for a profile. Fields are flat, not nested: timezone, slots, days_of_week, and max_posts_per_slot.",
      inputSchema: {
        profile_username: z.string().describe("Upload-Post profile name to update."),
        timezone: z
          .string()
          .optional()
          .describe("IANA timezone, e.g. Europe/Madrid or America/New_York."),
        slots: z
          .array(
            z.object({
              hour: z.number().int().min(0).max(23).describe("Hour in 24-hour local time."),
              minute: z.number().int().min(0).max(59).optional().describe("Minute. Defaults to 0."),
            })
          )
          .max(24)
          .optional()
          .describe("Posting slots sorted by local time, e.g. [{hour: 10, minute: 0}, {hour: 16, minute: 0}]."),
        days_of_week: z
          .array(z.number().int().min(0).max(6))
          .optional()
          .describe("Allowed posting days where 0=Monday and 6=Sunday."),
        max_posts_per_slot: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum posts allowed in the same queue slot."),
      },
      outputSchema: genericResultOutputSchema,
      // Replaces the existing config wholesale → mark as destructive so callers
      // confirm before overwriting.
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
      },
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
      outputSchema: genericResultOutputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async (args) => {
      const { nextSlot, ...rest } = args as { nextSlot?: boolean; [k: string]: unknown };
      const path = nextSlot ? "/uploadposts/queue/next-slot" : "/uploadposts/queue/preview";
      return client.request("GET", path, { query: compact(rest) });
    })
  );
}
