import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { safe } from "../schemas.js";

export function registerStatusPageTools(server: McpServer, client: UploadPostMcpClient): void {
  server.registerTool(
    "get_status_page",
    {
      title: "Get platform status",
      description:
        "Public Upload-Post status page summary, plus optional per-platform uptime. Set `platform` to scope to one platform's uptime, or omit for the global summary.",
      inputSchema: {
        platform: z.string().optional(),
        includeUptime: z.boolean().optional(),
      },
    },
    safe(async (args) => {
      const { platform, includeUptime } = args as {
        platform?: string;
        includeUptime?: boolean;
      };
      if (platform) {
        return client.request(
          "GET",
          `/uploadposts/status-page/uptime/${encodeURIComponent(platform)}`
        );
      }
      if (includeUptime) {
        return client.request("GET", "/uploadposts/status-page/uptime");
      }
      return client.request("GET", "/uploadposts/status-page");
    })
  );

  server.registerTool(
    "list_incidents",
    {
      title: "List status-page incidents",
      description: "Recent incidents reported on the Upload-Post status page.",
      inputSchema: {
        limit: z.number().int().positive().max(200).optional(),
        platform: z.string().optional(),
      },
    },
    safe(async (args) =>
      client.request("GET", "/uploadposts/status-page/incidents", {
        query: compact(args as Record<string, unknown>),
      })
    )
  );
}
