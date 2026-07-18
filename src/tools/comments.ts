import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { genericResultOutputSchema, safe } from "../schemas.js";

export function registerCommentTools(server: McpServer, client: UploadPostMcpClient): void {
  server.registerTool(
    "get_post_comments",
    {
      title: "Get post comments",
      description:
        "List comments on a post. Identify the post by either `postId` or `postUrl` (YouTube: postId=videoId; LinkedIn: postId=the post urn). TikTok is not supported.",
      inputSchema: {
        user: z.string().describe("Upload-Post profile name."),
        platform: z
          .enum(["instagram", "facebook", "youtube", "linkedin"])
          .default("instagram")
          .describe("Social platform. One of instagram, facebook, youtube, linkedin. TikTok is unsupported."),
        postId: z
          .string()
          .optional()
          .describe("Platform media/post ID. YouTube: the videoId. LinkedIn: the post urn."),
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
        buttons: z
          .array(z.object({ title: z.string(), url: z.string().url() }))
          .max(3)
          .optional()
          .describe(
            "Up to 3 web_url buttons rendered in the DM. Each item is { title, url }."
          ),
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
        buttons?: Array<{ title: string; url: string }>;
      };
      return client.request("POST", "/uploadposts/comments/reply", {
        body: compact({
          platform: a.platform ?? "instagram",
          user: a.user,
          comment_id: a.commentId,
          message: a.message,
          buttons: a.buttons,
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

  server.registerTool(
    "create_comment",
    {
      title: "Create a comment or reply",
      description:
        "Post a top-level comment or a reply on a post. Provide exactly ONE of `commentId` (reply to a comment), `postId`, or `postUrl` (top-level). LinkedIn: postId=the post urn. Instagram requires `commentId` (replies only).",
      inputSchema: {
        user: z.string().describe("Upload-Post profile name."),
        message: z.string().min(1).describe("Comment text to post."),
        platform: z
          .enum(["instagram", "facebook", "youtube", "linkedin"])
          .default("instagram")
          .describe("Social platform. One of instagram, facebook, youtube, linkedin."),
        commentId: z
          .string()
          .optional()
          .describe("Reply to this comment. Required by Instagram."),
        postId: z
          .string()
          .optional()
          .describe("Top-level comment on this post ID. LinkedIn: the post urn."),
        postUrl: z.string().optional().describe("Top-level comment on this post URL."),
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
        message: string;
        platform?: string;
        commentId?: string;
        postId?: string;
        postUrl?: string;
      };
      return client.request("POST", "/uploadposts/comments/create", {
        body: compact({
          platform: a.platform ?? "instagram",
          user: a.user,
          message: a.message,
          comment_id: a.commentId,
          post_id: a.postId,
          post_url: a.postUrl,
        }),
      });
    })
  );

  server.registerTool(
    "delete_comment",
    {
      title: "Delete a comment",
      description:
        "Delete a comment by `commentId`. LinkedIn also requires `postId` (the post urn).",
      inputSchema: {
        user: z.string().describe("Upload-Post profile name."),
        commentId: z.string().describe("ID of the comment to delete."),
        platform: z
          .enum(["instagram", "facebook", "youtube", "linkedin"])
          .default("instagram")
          .describe("Social platform. One of instagram, facebook, youtube, linkedin."),
        postId: z
          .string()
          .optional()
          .describe("LinkedIn only: the post urn the comment belongs to."),
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
        platform?: string;
        postId?: string;
      };
      return client.request("DELETE", "/uploadposts/comments/delete", {
        body: compact({
          platform: a.platform ?? "instagram",
          user: a.user,
          comment_id: a.commentId,
          post_id: a.postId,
        }),
      });
    })
  );
}
