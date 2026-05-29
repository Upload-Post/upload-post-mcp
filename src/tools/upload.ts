import { z } from "zod";
import { randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
 * Max decoded size accepted for inline (base64) video bytes, in MB.
 * Caps memory use of the MCP process; override with UPLOAD_POST_MAX_INLINE_MB.
 * Big videos should still be passed as a public URL, not inlined.
 */
const MAX_INLINE_MB = Number(process.env.UPLOAD_POST_MAX_INLINE_MB ?? 100);

/** Strip a leading `data:<mime>;base64,` prefix if present. */
function stripDataUri(input: string): string {
  const match = /^data:[^;,]*;base64,/i.exec(input);
  return match ? input.slice(match[0].length) : input;
}

/**
 * Decode inline base64 video bytes to a uniquely-named temp file and return its
 * path. Throws before allocating the full buffer is impossible, so we decode
 * then enforce the size cap. Caller is responsible for unlinking the path.
 */
async function writeInlineVideo(
  videoBase64: string,
  filename?: string
): Promise<string> {
  const buf = Buffer.from(stripDataUri(videoBase64), "base64");
  if (buf.length === 0) {
    throw new Error("videoBase64 decoded to 0 bytes (not valid base64?).");
  }
  const maxBytes = MAX_INLINE_MB * 1024 * 1024;
  if (buf.length > maxBytes) {
    throw new Error(
      `Inline video is ${(buf.length / 1024 / 1024).toFixed(1)} MB, over the ${MAX_INLINE_MB} MB limit. Pass a public URL in videoPathOrUrl instead.`
    );
  }
  const ext = filename?.match(/\.[a-z0-9]+$/i)?.[0] ?? ".mp4";
  const tmpPath = join(tmpdir(), `uppost-${randomUUID()}${ext}`);
  await writeFile(tmpPath, buf);
  return tmpPath;
}

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
        "Publish a video to one or more platforms. Provide the video as EITHER `videoPathOrUrl` (a public URL or absolute local path) OR `videoBase64` (raw base64 or a data URI for clients that hold the bytes directly). Inline base64 is capped (default 100 MB) and is best for small/medium clips — prefer a public URL for large videos. Returns a `request_id` you can poll with `get_status`. Supports per-platform overrides (tiktokPrivacyLevel, youtubePrivacyStatus, youtubePlaylistId, facebookPageId, instagramMediaType, etc.).",
      inputSchema: {
        videoPathOrUrl: z
          .string()
          .optional()
          .describe(
            "Public URL of the video, or absolute local path. Provide this OR videoBase64."
          ),
        videoBase64: z
          .string()
          .optional()
          .describe(
            "Video bytes as base64 (or a data: URI). Provide this OR videoPathOrUrl. The server writes it to a temp file, uploads, then deletes it. Capped by UPLOAD_POST_MAX_INLINE_MB (default 100)."
          ),
        videoFilename: z
          .string()
          .optional()
          .describe(
            "Optional filename (e.g. 'clip.mp4') used only to pick the temp file extension when videoBase64 is given. Defaults to .mp4."
          ),
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
      const { videoPathOrUrl, videoBase64, videoFilename, platformOptions, ...rest } =
        args as {
          videoPathOrUrl?: string;
          videoBase64?: string;
          videoFilename?: string;
          platformOptions?: Record<string, unknown>;
          [k: string]: unknown;
        };
      if (!videoPathOrUrl && !videoBase64) {
        throw new Error("Provide either videoPathOrUrl or videoBase64.");
      }
      if (videoPathOrUrl && videoBase64) {
        throw new Error(
          "Provide only one of videoPathOrUrl or videoBase64, not both."
        );
      }

      const options = {
        ...(rest as Record<string, unknown>),
        ...(platformOptions ?? {}),
      } as never;

      if (videoBase64) {
        const tmpPath = await writeInlineVideo(videoBase64, videoFilename);
        try {
          return await client.sdk.upload(tmpPath, options);
        } finally {
          await unlink(tmpPath).catch(() => {});
        }
      }
      return client.sdk.upload(videoPathOrUrl as string, options);
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
