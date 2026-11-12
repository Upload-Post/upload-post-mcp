import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { genericResultOutputSchema, safe } from "../schemas.js";

export function registerPostTools(server: McpServer, client: UploadPostMcpClient): void {
  server.registerTool(
    "retry_post",
    {
      title: "Retry a failed upload",
      description:
        "Retry a failed upload. Identify it by either `requestId` (async upload) or `jobId` (scheduled/queued upload). Only the platforms that failed are sent again; the ones that already published are left alone and come back in `skipped_platforms`. A job that published everywhere answers 409 `nothing_to_retry`, and one that has not run yet 409 `job_not_finished` (use edit_scheduled or cancel_scheduled for those). The retry is a new upload with its own `request_id` / `job_id`: poll that one.",
      inputSchema: {
        requestId: z
          .string()
          .optional()
          .describe("Async upload request_id to retry."),
        jobId: z
          .string()
          .optional()
          .describe("Scheduled/queued job_id to retry."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Retry a failed upload",
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    safe(async (args) => {
      const a = args as { requestId?: string; jobId?: string };
      return client.request("POST", "/uploadposts/posts/retry", {
        body: compact({
          request_id: a.requestId,
          job_id: a.jobId,
        }),
      });
    })
  );

  server.registerTool(
    "unpublish_post",
    {
      title: "Delete a published post",
      description:
        "Delete a post already published to a platform. Supported: facebook, youtube, x, linkedin, pinterest, bluesky, google_business. Instagram, TikTok, Threads and Reddit posts cannot be deleted through the API; they have to be removed in the platform's own app.",
      inputSchema: {
        user: z.string().describe("Upload-Post profile name."),
        platform: z
          .enum(["facebook", "youtube", "x", "linkedin", "pinterest", "bluesky", "google_business"])
          .describe("Social platform the post lives on."),
        postId: z.string().describe("Platform post ID to delete (Bluesky: the post AT-URI; Google Business: the full accounts/.../locations/.../localPosts/... name returned on upload)."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Delete a published post",
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
      },
    },
    safe(async (args) => {
      const a = args as { user: string; platform: string; postId: string };
      return client.request("POST", "/uploadposts/posts/unpublish", {
        body: compact({
          platform: a.platform,
          user: a.user,
          post_id: a.postId,
        }),
      });
    })
  );
}
