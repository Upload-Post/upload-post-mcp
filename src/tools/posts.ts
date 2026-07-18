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
        "Retry a failed upload. Identify it by either `requestId` (async upload) or `jobId` (scheduled/queued upload).",
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
        "Delete a post already published to a platform. Instagram and TikTok are not supported.",
      inputSchema: {
        user: z.string().describe("Upload-Post profile name."),
        platform: z
          .enum(["facebook", "youtube", "x", "linkedin", "threads"])
          .describe("Social platform. One of facebook, youtube, x, linkedin, threads. Instagram and TikTok are unsupported."),
        postId: z.string().describe("Platform post ID to delete."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
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
