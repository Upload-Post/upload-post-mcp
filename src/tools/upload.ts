import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import {
  PhotoPlatform,
  TextPlatform,
  VideoPlatform,
  safe,
  schedulingFields,
} from "../schemas.js";

/**
 * The 4 publish endpoints exposed by the official SDK. We deliberately keep
 * the schema "open" via passthrough so platform-specific overrides documented
 * in the Upload-Post docs (tiktokPrivacyLevel, youtubePrivacyStatus, …) flow
 * through unchanged, even when not strictly typed here.
 */
export function registerUploadTools(server: McpServer, client: UploadPostMcpClient): void {
  server.registerTool(
    "upload_video",
    {
      title: "Upload video",
      description:
        "Publish a video to one or more platforms. Pass either a public URL or a local path in `videoPathOrUrl`. Returns a `request_id` you can poll with `get_status`. Supports per-platform overrides (tiktokPrivacyLevel, youtubePrivacyStatus, youtubePlaylistId, facebookPageId, instagramMediaType, etc.).",
      inputSchema: {
        videoPathOrUrl: z
          .string()
          .describe("Public URL of the video, or absolute local path."),
        user: z.string().describe("Profile name (Upload-Post user)."),
        platforms: z.array(VideoPlatform).min(1),
        title: z.string().optional().describe("Caption / title."),
        description: z.string().optional(),
        firstComment: z.string().optional(),
        ...schedulingFields,
        platformOptions: z
          .record(z.unknown())
          .optional()
          .describe(
            "Platform-specific overrides as a flat object (camelCase keys), e.g. { tiktokPrivacyLevel: 'PUBLIC_TO_EVERYONE', youtubePrivacyStatus: 'public', youtubePlaylistId: 'PLxxxxxxxxxxxx', facebookPageId: '123' }. `youtubePlaylistId` may also be an array or a comma-separated list of playlist IDs to add the uploaded video to."
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    safe(async (args) => {
      const { videoPathOrUrl, platformOptions, ...rest } = args as {
        videoPathOrUrl: string;
        platformOptions?: Record<string, unknown>;
        [k: string]: unknown;
      };
      return client.sdk.upload(videoPathOrUrl, {
        ...(rest as Record<string, unknown>),
        ...(platformOptions ?? {}),
      } as never);
    })
  );

  server.registerTool(
    "upload_photos",
    {
      title: "Upload photos / carousel",
      description:
        "Publish one or more photos (single image or carousel). Each item in `photosPathsOrUrls` may be a public URL or a local path.",
      inputSchema: {
        photosPathsOrUrls: z.array(z.string()).min(1),
        user: z.string(),
        platforms: z.array(PhotoPlatform).min(1),
        title: z.string().optional(),
        description: z.string().optional(),
        firstComment: z.string().optional(),
        altText: z.string().optional(),
        ...schedulingFields,
        platformOptions: z.record(z.unknown()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    safe(async (args) => {
      const { photosPathsOrUrls, platformOptions, ...rest } = args as {
        photosPathsOrUrls: string[];
        platformOptions?: Record<string, unknown>;
        [k: string]: unknown;
      };
      return client.sdk.uploadPhotos(photosPathsOrUrls, {
        ...(rest as Record<string, unknown>),
        ...(platformOptions ?? {}),
      } as never);
    })
  );

  server.registerTool(
    "upload_text",
    {
      title: "Upload text post",
      description:
        "Publish a text-only post. Title is required for Reddit. `linkUrl` (or platform-specific *LinkUrl) attaches a link preview where supported.",
      inputSchema: {
        title: z.string().describe("Post text / caption."),
        user: z.string(),
        platforms: z.array(TextPlatform).min(1),
        linkUrl: z
          .string()
          .optional()
          .describe("Generic link preview URL (LinkedIn, Bluesky, Facebook)."),
        ...schedulingFields,
        platformOptions: z.record(z.unknown()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    safe(async (args) => {
      const { platformOptions, ...rest } = args as {
        platformOptions?: Record<string, unknown>;
        [k: string]: unknown;
      };
      return client.sdk.uploadText({
        ...(rest as Record<string, unknown>),
        ...(platformOptions ?? {}),
      } as never);
    })
  );

  server.registerTool(
    "upload_document",
    {
      title: "Upload document (LinkedIn)",
      description:
        "Publish a document (PDF / PPT / PPTX / DOC / DOCX) to LinkedIn. Title is required.",
      inputSchema: {
        documentPathOrUrl: z.string(),
        title: z.string(),
        user: z.string(),
        description: z.string().optional(),
        linkedinVisibility: z
          .enum(["PUBLIC", "CONNECTIONS", "LOGGED_IN", "CONTAINER"])
          .optional(),
        targetLinkedinPageId: z.string().optional(),
        ...schedulingFields,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    safe(async (args) => {
      const { documentPathOrUrl, ...rest } = args as {
        documentPathOrUrl: string;
        [k: string]: unknown;
      };
      return client.sdk.uploadDocument(documentPathOrUrl, rest as never);
    })
  );
}
