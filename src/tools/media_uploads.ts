import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { genericResultOutputSchema, safe } from "../schemas.js";

const MediaType = z.enum(["video", "image", "document"]);

export function registerMediaUploadTools(server: McpServer, client: UploadPostMcpClient): void {
  server.registerTool(
    "create_media_upload",
    {
      title: "Create media upload",
      description:
        "Internal/app staging helper for clients that can directly PUT file bytes to the returned upload_url. Do NOT use this directly from the ChatGPT/claude.ai model for attached files: the model/server environment cannot read or upload ChatGPT attachment bytes. For ChatGPT attached video uploads, call open_upload_studio first; the Studio browser component will call this tool after the user selects the file. Use this directly only in MCP clients that truly hold the file bytes and can perform the HTTP PUT themselves. Staging media is deleted after 24 hours; scheduled posts are safe because upload_video copies the media into durable scheduler storage.",
      inputSchema: {
        filename: z.string().describe("Original filename, e.g. clip.mp4."),
        contentType: z.string().describe("MIME type, e.g. video/mp4."),
        contentLength: z.number().int().positive().describe("File size in bytes."),
        mediaType: MediaType.default("video").describe("Kind of media being uploaded."),
        source: z.string().optional().describe("Optional source label, e.g. mcp_chatgpt or mcp_claude."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
      },
      _meta: {
        ui: {
          visibility: ["app"],
        },
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
        "Internal/app staging helper. Validate a media upload only after the browser/client has successfully PUT the actual file bytes to upload_url. Do NOT call this immediately after create_media_upload from the model; without the intervening PUT, completion will fail or produce no publishable media. Returns a temporary media_url that can be passed to upload_video/upload_photos immediately.",
      inputSchema: {
        uploadId: z.string().describe("upload_id returned by create_media_upload."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
      },
      _meta: {
        ui: {
          visibility: ["app"],
        },
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
      description:
        "Internal/app staging helper. Get status for a short-lived MCP media upload. Optionally returns a fresh temporary media_url for an already-uploaded staging object.",
      inputSchema: {
        uploadId: z.string(),
        includeUrl: z.boolean().optional(),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
      _meta: {
        ui: {
          visibility: ["app"],
        },
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
        "Internal/app staging helper. Delete a short-lived MCP staging media upload from R2. This does not delete scheduler durable copies created later by upload_video.",
      inputSchema: {
        uploadId: z.string(),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
      },
      _meta: {
        ui: {
          visibility: ["app"],
        },
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
