import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { safe } from "../schemas.js";

const MediaType = z.enum(["video", "image", "document"]);

export function registerMediaUploadTools(server: McpServer, client: UploadPostMcpClient): void {
  server.registerTool(
    "create_media_upload",
    {
      title: "Create media upload",
      description:
        "Create a short-lived signed R2 upload URL for a local media file. Use this before publishing files from ChatGPT/Claude that are not already available at a public URL. The returned upload_url accepts one HTTP PUT with the exact Content-Type header. Staging media is deleted after 24 hours; scheduled posts are safe because upload_video copies the media into durable scheduler storage.",
      inputSchema: {
        filename: z.string().describe("Original filename, e.g. clip.mp4."),
        contentType: z.string().describe("MIME type, e.g. video/mp4."),
        contentLength: z.number().int().positive().describe("File size in bytes."),
        mediaType: MediaType.default("video").describe("Kind of media being uploaded."),
        source: z.string().optional().describe("Optional source label, e.g. mcp_chatgpt or mcp_claude."),
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
      },
      _meta: {
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Creating upload URL…",
        "openai/toolInvocation/invoked": "Upload URL created",
      },
    },
    safe(async (args) => {
      const input = args as {
        filename: string;
        contentType: string;
        contentLength: number;
        mediaType?: z.infer<typeof MediaType>;
        source?: string;
      };
      return client.request("POST", "/uploadposts/media-uploads", {
        body: {
          filename: input.filename,
          content_type: input.contentType,
          content_length: input.contentLength,
          media_type: input.mediaType ?? "video",
          source: input.source ?? "mcp",
        },
      });
    })
  );

  server.registerTool(
    "complete_media_upload",
    {
      title: "Complete media upload",
      description:
        "Validate a previously-created media upload after the client PUTs the file to upload_url. Returns a temporary media_url that can be passed to upload_video/upload_photos immediately.",
      inputSchema: {
        uploadId: z.string().describe("upload_id returned by create_media_upload."),
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
      },
      _meta: {
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Completing media upload…",
        "openai/toolInvocation/invoked": "Media upload completed",
      },
    },
    safe(async ({ uploadId }) =>
      client.request("POST", `/uploadposts/media-uploads/${uploadId}/complete`)
    )
  );

  server.registerTool(
    "get_media_upload",
    {
      title: "Get media upload",
      description: "Get status for a short-lived MCP media upload. Optionally returns a fresh temporary media_url.",
      inputSchema: {
        uploadId: z.string(),
        includeUrl: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
      _meta: {
        "openai/widgetAccessible": true,
      },
    },
    safe(async ({ uploadId, includeUrl }) =>
      client.request("GET", `/uploadposts/media-uploads/${uploadId}`, {
        query: includeUrl ? { include_url: "true" } : undefined,
      })
    )
  );

  server.registerTool(
    "delete_media_upload",
    {
      title: "Delete media upload",
      description:
        "Delete a short-lived MCP staging media upload from R2. This does not delete scheduler durable copies created later by upload_video.",
      inputSchema: {
        uploadId: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
      },
      _meta: {
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Deleting media upload…",
        "openai/toolInvocation/invoked": "Media upload deleted",
      },
    },
    safe(async ({ uploadId }) =>
      client.request("DELETE", `/uploadposts/media-uploads/${uploadId}`)
    )
  );
}

