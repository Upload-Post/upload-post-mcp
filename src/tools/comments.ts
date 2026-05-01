import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { safe } from "../schemas.js";

export function registerCommentTools(server: McpServer, client: UploadPostMcpClient): void {
  server.registerTool(
    "get_post_comments",
    {
      title: "Get Instagram post comments",
      description:
        "List comments on an Instagram post. Identify the post by either `postId` or `postUrl`.",
      inputSchema: {
        user: z.string(),
        postId: z.string().optional(),
        postUrl: z.string().optional(),
      },
    },
    safe(async (args) =>
      client.request("GET", "/uploadposts/comments", {
        query: compact(args as Record<string, unknown>),
      })
    )
  );

  server.registerTool(
    "reply_to_comment",
    {
      title: "Private reply (DM) to commenter",
      description:
        "Send a private DM to the author of an Instagram comment (within Instagram's 7-day reply window).",
      inputSchema: {
        user: z.string(),
        commentId: z.string(),
        message: z.string(),
      },
    },
    safe(async (args) =>
      client.request("POST", "/uploadposts/comments/reply", {
        body: compact(args as Record<string, unknown>),
      })
    )
  );

  server.registerTool(
    "public_reply_to_comment",
    {
      title: "Public reply to comment",
      description: "Post a public reply visible under the original Instagram comment.",
      inputSchema: {
        user: z.string(),
        commentId: z.string(),
        message: z.string(),
      },
    },
    safe(async (args) =>
      client.request("POST", "/uploadposts/comments/public-reply", {
        body: compact(args as Record<string, unknown>),
      })
    )
  );
}
