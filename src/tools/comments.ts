import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { genericResultOutputSchema, requiresTiktokCapability, safe } from "../schemas.js";

export function registerCommentTools(server: McpServer, client: UploadPostMcpClient): void {
  server.registerTool(
    "get_post_comments",
    {
      title: "Get post comments",
      description:
        "List comments on a post. Identify the post by either `postId` or `postUrl` (YouTube: postId=videoId; LinkedIn: postId=the post urn; TikTok: postId=the video id, `postUrl` is not accepted). Replies under a TikTok comment come from get_tiktok_comment_replies. TikTok: " +
        requiresTiktokCapability("comments", true),
      inputSchema: {
        user: z.string().describe("Upload-Post profile name."),
        platform: z
          .enum(["instagram", "facebook", "youtube", "linkedin", "tiktok"])
          .default("instagram")
          .describe("Social platform. One of instagram, facebook, youtube, linkedin, tiktok."),
        postId: z
          .string()
          .optional()
          .describe("Platform media/post ID. YouTube: the videoId. LinkedIn: the post urn. TikTok: the video id (required — TikTok has no URL lookup)."),
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
          .describe("Comments to return (1-50; that ceiling is both Meta's and TikTok's)."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Get post comments",
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
        title: "Private reply (DM) to commenter",
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
        title: "Public reply to comment",
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
        "Post a top-level comment or a reply on a post. Provide exactly ONE of `commentId` (reply to a comment), `postId`, or `postUrl` (top-level). LinkedIn: postId=the post urn. Instagram requires `commentId` (replies only). TikTok always needs `postId` (the video id); add `commentId` on top of it to reply inside that thread. TikTok: " +
        requiresTiktokCapability("comments", true),
      inputSchema: {
        user: z.string().describe("Upload-Post profile name."),
        message: z.string().min(1).describe("Comment text to post."),
        platform: z
          .enum(["instagram", "facebook", "youtube", "linkedin", "tiktok"])
          .default("instagram")
          .describe("Social platform. One of instagram, facebook, youtube, linkedin, tiktok."),
        commentId: z
          .string()
          .optional()
          .describe("Reply to this comment. Required by Instagram. TikTok: pass it together with postId to reply inside a thread."),
        postId: z
          .string()
          .optional()
          .describe("Top-level comment on this post ID. LinkedIn: the post urn. TikTok: the video id, always required."),
        postUrl: z.string().optional().describe("Top-level comment on this post URL."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Create a comment or reply",
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
        "Delete a comment by `commentId`. LinkedIn also requires `postId` (the post urn); TikTok needs only the `commentId`. TikTok: " +
        requiresTiktokCapability("comments", true),
      inputSchema: {
        user: z.string().describe("Upload-Post profile name."),
        commentId: z.string().describe("ID of the comment to delete."),
        platform: z
          .enum(["instagram", "facebook", "youtube", "linkedin", "tiktok"])
          .default("instagram")
          .describe("Social platform. One of instagram, facebook, youtube, linkedin, tiktok."),
        postId: z
          .string()
          .optional()
          .describe("LinkedIn only: the post urn the comment belongs to."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Delete a comment",
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
