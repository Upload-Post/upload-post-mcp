import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { safe } from "../schemas.js";

export function registerDmTools(server: McpServer, client: UploadPostMcpClient): void {
  server.registerTool(
    "send_dm",
    {
      title: "Send a direct message",
      description:
        "Send a DM to a recipient on a connected platform. The exact required fields depend on the platform (e.g. Instagram needs `recipientId`).",
      inputSchema: {
        user: z.string(),
        platform: z.string().describe("'instagram', 'x', 'tiktok', …"),
        recipientId: z.string().optional(),
        recipientUsername: z.string().optional(),
        message: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
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
      annotations: { readOnlyHint: true },
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
        "Control the autoDMs background worker for a profile. Choose `action` from: 'start', 'stop', 'pause', 'resume', 'delete', 'status', 'logs'. The body fields you need depend on the action — pass any extra config under `config`. For `status`, pass `include_inactive: true` in `config` to also return stopped and expired monitors.",
      inputSchema: {
        action: z.enum(["start", "stop", "pause", "resume", "delete", "status", "logs"]),
        user: z.string().optional(),
        config: z
          .record(z.unknown())
          .optional()
          .describe(
            "Free-form config / filters. For 'start' typically includes triggers, reply templates, target accounts. For 'status'/'logs' (GET actions) the fields are passed as query params — e.g. {include_inactive: true} to list stopped monitors."
          ),
      },
      // `action` can be read-only (status/logs) or destructive (stop/delete). We
      // report the worst case (destructive) so callers default to confirmation.
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    safe(async (args) => {
      const { action, user, config } = args as {
        action: string;
        user?: string;
        config?: Record<string, unknown>;
      };
      const isGet = action === "status" || action === "logs";
      const path = `/uploadposts/autodms/${action}`;
      if (isGet) {
        return client.request("GET", path, {
          query: compact({ user, ...(config ?? {}) }),
        });
      }
      return client.request("POST", path, {
        body: compact({ user, ...(config ?? {}) }),
      });
    })
  );
}
