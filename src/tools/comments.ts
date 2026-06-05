import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { genericResultOutputSchema, safe } from "../schemas.js";

export function registerCommentTools(server: McpServer, client: UploadPostMcpClient): void {
  server.registerTool(
    "get_post_comments",
    {
      title: "Get Instagram post comments",
      description:
        "List comments on an Instagram post. Identify the post by either `postId` or `postUrl`.",
      inputSchema: {
        user: z.string().describe("Upload-Post profile name."),
        platform: z
          .string()
          .default("instagram")
          .describe("Social platform. Only 'instagram' is currently supported."),
        postId: z.string().optional().describe("Platform media/post ID."),
        postUrl: z.string().optional().describe("Public URL of the post."),
        after: z
          .string()
          .optional()
          .describe("Pagination cursor returned by a previous call."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Comments to return (1-50, Meta's cap)."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async (args) => {
      const a = args as {
        user: string;
        platform?: string;
        postId?: string;
        postUrl?: string;
        after?: string;
        limit?: number;
      };
      // The API reads snake_case query params and requires `platform`; the
      // tool surface stays camelCase, so map explicitly here.
      return client.request("GET", "/uploadposts/comments", {
        query: compact({
          platform: a.platform ?? "instagram",
          user: a.user,
          post_id: a.postId,
          post_url: a.postUrl,
          after: a.after,
          limit: a.limit,
        }),
      });
    })
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
        platform: z
          .string()
          .default("instagram")
          .describe("Social platform. Only 'instagram' is currently supported."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
      },
    },
    safe(async (args) => {
      const a = args as {
        user: string;
        commentId: string;
        message: string;
        platform?: string;
      };
      return client.request("POST", "/uploadposts/comments/reply", {
        body: compact({
          platform: a.platform ?? "instagram",
          user: a.user,
          comment_id: a.commentId,
          message: a.message,
        }),
      });
    })
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
        platform: z
          .string()
          .default("instagram")
          .describe("Social platform. Only 'instagram' is currently supported."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
      },
    },
    safe(async (args) => {
      const a = args as {
        user: string;
        commentId: string;
        message: string;
        platform?: string;
      };
      return client.request("POST", "/uploadposts/comments/public-reply", {
        body: compact({
          platform: a.platform ?? "instagram",
          user: a.user,
          comment_id: a.commentId,
          message: a.message,
        }),
      });
    })
  );
}
