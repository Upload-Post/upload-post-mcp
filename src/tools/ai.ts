import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { safe } from "../schemas.js";

export function registerAiTools(server: McpServer, client: UploadPostMcpClient): void {
  server.registerTool(
    "rewrite_captions",
    {
      title: "AI: rewrite captions",
      description:
        "Rewrite a caption optimized for one or more platforms. Useful before calling an `upload_*` tool.",
      inputSchema: {
        caption: z.string(),
        platforms: z.array(z.string()).optional(),
        tone: z
          .string()
          .optional()
          .describe("'professional', 'casual', 'humorous', 'salesy', …"),
        targetLanguage: z.string().optional(),
        maxLength: z.number().int().positive().optional(),
      },
    },
    safe(async (args) =>
      client.request("POST", "/uploadposts/rewrite-captions", {
        body: compact(args as Record<string, unknown>),
      })
    )
  );

  server.registerTool(
    "analyze_shorts",
    {
      title: "AI: analyze YouTube Shorts / video",
      description:
        "Run analysis on a video URL (YouTube Shorts–style) — transcripts, hooks, suggested captions, hashtags, …",
      inputSchema: {
        url: z.string(),
        prompt: z.string().optional().describe("Optional override / extra instructions."),
      },
    },
    safe(async (args) =>
      client.request("POST", "/uploadposts/analyze-shorts", {
        body: compact(args as Record<string, unknown>),
      })
    )
  );
}
