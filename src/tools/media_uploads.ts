import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { genericResultOutputSchema, safe } from "../schemas.js";
import { LOCAL_FILE_GUIDANCE, type SessionContext } from "../client_profile.js";

const MediaType = z.enum(["video", "image", "document"]);

export interface MediaUploadHandles {
  /** Re-shape descriptions/visibility for hosts that do not get the Studio widget. */
  applyClientProfile(ctx: SessionContext): void;
}

const CREATE_DESCRIPTION_CHATGPT =
  "Internal/app staging helper for clients that can directly PUT file bytes to the returned upload_url. Do NOT call this for files the user attached in a hosted chat client: the model and server environment cannot read those attachment bytes. For attached video uploads, call open_upload_studio first; the Studio browser component calls this tool after the user selects the file. Use this directly only in MCP clients that truly hold the file bytes and can perform the HTTP PUT themselves. Staging media is deleted after 24 hours; scheduled posts are safe because upload_video copies the media into durable scheduler storage.";

const CREATE_DESCRIPTION_OTHER =
  "Step 1 of staging a local file for publishing. Returns `upload_id` and a short-lived `upload_url`; the caller must then PUT the raw file bytes to `upload_url` (same Content-Type and size as declared here) and call `complete_media_upload`. Only useful when this client can perform the HTTP PUT itself (for example a coding agent with a shell); the model cannot read chat attachments or `/mnt/data` paths, so for those ask the user for a public HTTPS URL or send them to https://app.upload-post.com. Staging media is deleted after 24 hours; scheduled posts are safe because upload_video copies the media into durable scheduler storage.";

const COMPLETE_DESCRIPTION_CHATGPT =
  "Internal/app staging helper. Validate a media upload only after the browser/client has successfully PUT the actual file bytes to upload_url. Do NOT call this immediately after create_media_upload from the model; without the intervening PUT, completion will fail or produce no publishable media. Returns a temporary media_url that can be passed to upload_video/upload_photos immediately.";

const COMPLETE_DESCRIPTION_OTHER =
  "Step 2 of staging a local file. Call it only after the file bytes were actually PUT to the `upload_url` from create_media_upload; without that PUT it fails or yields no publishable media. Returns a temporary `media_url` to pass straight to upload_video / upload_photos / upload_document.";

export function registerMediaUploadTools(server: McpServer, client: UploadPostMcpClient): MediaUploadHandles {
  const createTool = server.registerTool(
    "create_media_upload",
    {
      title: "Create media upload",
      description: CREATE_DESCRIPTION_CHATGPT,
      inputSchema: {
        filename: z.string().describe("Original filename, e.g. clip.mp4."),
        contentType: z.string().describe("MIME type, e.g. video/mp4."),
        contentLength: z.number().int().positive().describe("File size in bytes."),
        mediaType: MediaType.default("video").describe("Kind of media being uploaded."),
        source: z.string().optional().describe("Optional source label identifying the calling client, e.g. mcp_studio."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Create media upload",
        readOnlyHint: false,
        openWorldHint: false,
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

  const completeTool = server.registerTool(
    "complete_media_upload",
    {
      title: "Complete media upload",
      description: COMPLETE_DESCRIPTION_CHATGPT,
      inputSchema: {
        uploadId: z.string().describe("upload_id returned by create_media_upload."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Complete media upload",
        readOnlyHint: false,
        openWorldHint: false,
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

  const getTool = server.registerTool(
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
        title: "Get media upload",
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
        title: "Delete media upload",
        readOnlyHint: false,
        openWorldHint: false,
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

  const modelVisible = (meta: Record<string, unknown> | undefined): Record<string, unknown> => ({
    ...(meta ?? {}),
    ui: { ...((meta?.ui as Record<string, unknown> | undefined) ?? {}), visibility: ["model", "app"] },
  });

  return {
    applyClientProfile(ctx) {
      if (ctx.profile?.kind === "chatgpt") return;
      createTool.update({ description: CREATE_DESCRIPTION_OTHER, _meta: modelVisible(createTool._meta) });
      completeTool.update({ description: COMPLETE_DESCRIPTION_OTHER, _meta: modelVisible(completeTool._meta) });
      getTool.update({ _meta: modelVisible(getTool._meta) });
    },
  };
}
