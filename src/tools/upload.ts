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
  genericResultOutputSchema,
  safe,
  schedulingFields,
} from "../schemas.js";

/**
 * Max decoded size accepted for inline (base64) video bytes, in MB.
 * Caps memory use of the MCP process; override with UPLOAD_POST_MAX_INLINE_MB.
 * Big videos should still be passed as a public URL, not inlined.
 */
const MAX_INLINE_MB = Number(process.env.UPLOAD_POST_MAX_INLINE_MB ?? 100);

/** Keys shared by video, photo and text posts. */
const commonPlatformOptionFields = {
  facebookPageId: z.string().optional().describe("Facebook Page ID to publish to (see get_facebook_pages)."),
  linkedinPageId: z
    .string()
    .optional()
    .describe("Alias of targetLinkedinPageId: LinkedIn organization/page ID to publish to."),
  targetLinkedinPageId: z
    .string()
    .optional()
    .describe("LinkedIn organization/page ID to publish to (see get_linkedin_pages)."),
  linkedinVisibility: z
    .enum(["PUBLIC", "CONNECTIONS", "LOGGED_IN", "CONTAINER"])
    .optional()
    .describe("LinkedIn post visibility."),
  googleBusinessLocationId: z
    .string()
    .optional()
    .describe(
      "Google Business location ID (see get_google_business_locations). Selected on the profile before publishing."
    ),
  xReplySettings: z
    .enum(["everyone", "following", "mentionedUsers", "subscribers", "verified"])
    .optional()
    .describe("Who can reply on X."),
  xCommunityId: z.string().optional().describe("X community ID to post into."),
  xLongTextAsPost: z.boolean().optional().describe("Post long X text as a single post instead of a thread."),
  threadsLongTextAsPost: z.boolean().optional().describe("Post long Threads text as a single post instead of a thread."),
  threadsTopicTag: z.string().optional().describe("Threads topic tag."),
  brandContentToggle: z.boolean().optional().describe("TikTok branded content disclosure."),
  brandOrganicToggle: z.boolean().optional().describe("TikTok brand organic disclosure."),
};

const VideoPlatformOptions = z
  .object({
    ...commonPlatformOptionFields,
    // TikTok
    tiktokPrivacyLevel: z
      .string()
      .optional()
      .describe("TikTok privacy value, e.g. PUBLIC_TO_EVERYONE, MUTUAL_FOLLOW_FRIENDS, FOLLOWER_OF_CREATOR, SELF_ONLY."),
    tiktokDisableDuet: z.boolean().optional().describe("Disable duets on TikTok."),
    tiktokDisableComment: z.boolean().optional().describe("Disable comments on TikTok."),
    tiktokDisableStitch: z.boolean().optional().describe("Disable stitch on TikTok."),
    tiktokCoverTimestamp: z.number().optional().describe("Cover frame timestamp in ms."),
    tiktokIsAigc: z.boolean().optional().describe("TikTok AI-generated content flag."),
    tiktokPostMode: z.enum(["DIRECT_POST", "MEDIA_UPLOAD"]).optional().describe("TikTok post mode."),
    // Instagram
    instagramMediaType: z
      .enum(["REELS", "STORIES"])
      .optional()
      .describe("Instagram video placement. Use REELS for Reels, STORIES for Stories."),
    instagramShareToFeed: z.boolean().optional().describe("Also show the Reel in the feed."),
    instagramCoverUrl: z.string().optional().describe("Custom cover image URL for the Reel."),
    instagramThumbOffset: z.string().optional().describe("Frame offset for the auto-generated thumbnail."),
    instagramCollaborators: z.string().optional().describe("Comma-separated collaborator usernames."),
    instagramUserTags: z.string().optional().describe("Comma-separated user tags."),
    instagramLocationId: z.string().optional().describe("Instagram location ID."),
    instagramAudioName: z.string().optional().describe("Audio track name."),
    // YouTube
    youtubePrivacyStatus: z
      .enum(["public", "private", "unlisted"])
      .optional()
      .describe("YouTube visibility for the uploaded video."),
    youtubePlaylistId: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe("One YouTube playlist ID, or an array of playlist IDs, to add the uploaded video to."),
    youtubeThumbnailUrl: z.string().optional().describe("Custom thumbnail image URL for the YouTube video."),
    youtubeTags: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe("YouTube video tags, as an array or comma-separated string."),
    youtubeCategoryId: z.string().optional().describe("YouTube category ID, e.g. '22' for People & Blogs."),
    youtubeEmbeddable: z.boolean().optional().describe("Allow embedding the video on other sites."),
    youtubeLicense: z.enum(["youtube", "creativeCommon"]).optional().describe("YouTube video license."),
    youtubePublicStatsViewable: z.boolean().optional().describe("Show public view stats on the video."),
    youtubeSelfDeclaredMadeForKids: z.boolean().optional().describe("YouTube made-for-kids flag (COPPA)."),
    youtubeContainsSyntheticMedia: z.boolean().optional().describe("YouTube AI/synthetic content disclosure."),
    youtubeDefaultLanguage: z.string().optional().describe("BCP-47 language of title/description."),
    youtubeDefaultAudioLanguage: z.string().optional().describe("BCP-47 language of the audio."),
    youtubeAllowedCountries: z.string().optional().describe("Comma-separated allowed country codes."),
    youtubeBlockedCountries: z.string().optional().describe("Comma-separated blocked country codes."),
    youtubeHasPaidProductPlacement: z.boolean().optional().describe("Paid product placement flag."),
    youtubeRecordingDate: z.string().optional().describe("Recording date, ISO 8601."),
    youtubeSubtitles: z
      .array(
        z.object({
          language: z.string().describe("BCP-47 language code, e.g. 'en', 'es'."),
          name: z.string().optional().describe("Display name of the subtitle track."),
          url: z.string().optional().describe("URL of the subtitle file (SRT, VTT, SBV, SUB, ASS, SSA, TTML)."),
        })
      )
      .optional()
      .describe("Subtitle/caption tracks to attach to the YouTube video."),
    // Facebook
    facebookMediaType: z.enum(["REELS", "STORIES", "VIDEO"]).optional().describe("Facebook video placement."),
    facebookVideoState: z.enum(["PUBLISHED", "DRAFT"]).optional().describe("Facebook video state."),
    thumbnailUrl: z
      .string()
      .optional()
      .describe("Thumbnail URL for normal Facebook page videos (facebookMediaType VIDEO)."),
    // Pinterest
    pinterestBoardId: z.string().optional().describe("Pinterest board ID to publish to (see get_pinterest_boards)."),
    pinterestLink: z.string().optional().describe("Destination link for the pin."),
    pinterestCoverImageUrl: z.string().optional().describe("Cover image URL for the video pin."),
    pinterestCoverImageKeyFrameTime: z.number().optional().describe("Key frame time in ms for the cover."),
    // X
    xTaggedUserIds: z.union([z.string(), z.array(z.string())]).optional().describe("X user IDs to tag in the media."),
    xPlaceId: z.string().optional().describe("X location place ID."),
  })
  .passthrough()
  .describe(
    "Flat platform-specific override object with camelCase keys. Per-platform text overrides (youtubeTitle, tiktokTitle, youtubeDescription, instagramFirstComment, …) are also accepted. Keys the upload-post SDK does not support are silently ignored upstream."
  );

const PhotoPlatformOptions = z
  .object({
    ...commonPlatformOptionFields,
    tiktokAutoAddMusic: z.boolean().optional().describe("Auto add music to TikTok photo posts."),
    tiktokDisableComment: z.boolean().optional().describe("Disable comments on TikTok."),
    tiktokPhotoCoverIndex: z.number().int().optional().describe("Index of the cover photo, 0-based."),
    instagramMediaType: z
      .enum(["IMAGE", "STORIES"])
      .optional()
      .describe("Instagram photo placement. Use IMAGE for feed, STORIES for Stories."),
    instagramCollaborators: z.string().optional().describe("Comma-separated collaborator usernames."),
    instagramUserTags: z.string().optional().describe("Comma-separated user tags."),
    instagramLocationId: z.string().optional().describe("Instagram location ID."),
    pinterestBoardId: z.string().optional().describe("Pinterest board ID to publish to (see get_pinterest_boards)."),
    pinterestLink: z.string().optional().describe("Destination link for the pin."),
    pinterestAltText: z.string().optional().describe("Pinterest-specific alt text."),
    xTaggedUserIds: z.union([z.string(), z.array(z.string())]).optional().describe("X user IDs to tag in the media."),
    xPlaceId: z.string().optional().describe("X location place ID."),
    xThreadImageLayout: z
      .string()
      .optional()
      .describe("Images per X thread post, e.g. '4,4' or '2,3,1'. Total must equal image count."),
    threadsThreadMediaLayout: z
      .string()
      .optional()
      .describe("Media items per Threads post, e.g. '5,5'. Total must equal file count."),
    redditSubreddit: z.string().optional().describe("Subreddit name, without r/."),
    redditFlairId: z.string().optional().describe("Reddit flair template ID."),
  })
  .passthrough()
  .describe(
    "Flat platform-specific override object with camelCase keys. Per-platform text overrides (instagramTitle, xFirstComment, …) are also accepted. Keys the upload-post SDK does not support are silently ignored upstream."
  );

const TextPlatformOptions = z
  .object({
    ...commonPlatformOptionFields,
    facebookLinkUrl: z.string().optional().describe("Link preview URL on Facebook."),
    linkedinLinkUrl: z.string().optional().describe("Link preview URL on LinkedIn."),
    blueskyLinkUrl: z.string().optional().describe("External embed link preview URL on Bluesky."),
    xPostUrl: z.string().optional().describe("URL to attach to the X post."),
    xQuoteTweetId: z.string().optional().describe("Tweet ID to quote."),
    xPollOptions: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe("X poll options (2-4)."),
    xPollDuration: z.number().int().optional().describe("X poll duration in minutes (5-10080)."),
    xPollReplySettings: z
      .enum(["everyone", "following", "mentionedUsers", "subscribers", "verified"])
      .optional()
      .describe("Who can reply to the X poll."),
    xCardUri: z.string().optional().describe("Card URI for Twitter Cards."),
    redditSubreddit: z.string().optional().describe("Subreddit name, without r/. Title is required for Reddit."),
    redditFlairId: z.string().optional().describe("Reddit flair template ID."),
    redditLinkUrl: z.string().optional().describe("Link to attach on Reddit."),
  })
  .passthrough()
  .describe(
    "Flat platform-specific override object with camelCase keys. Per-platform text overrides (xTitle, linkedinTitle, …) are also accepted. Keys the upload-post SDK does not support are silently ignored upstream."
  );

/**
 * Normalize option names the SDK does not know and resolve routing that is
 * profile state rather than an upload field:
 * - `linkedinPageId` is an MCP-level alias of the SDK's `targetLinkedinPageId`.
 * - `googleBusinessLocationId` is applied by selecting the location on the
 *   profile (same call as the select_google_business_location tool) before
 *   uploading, because /api/upload has no per-request location field.
 */
async function resolvePlatformRouting(
  client: UploadPostMcpClient,
  options: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const opts = { ...options };
  if (opts.linkedinPageId && !opts.targetLinkedinPageId) {
    opts.targetLinkedinPageId = opts.linkedinPageId;
  }
  delete opts.linkedinPageId;

  const locationId = opts.googleBusinessLocationId;
  delete opts.googleBusinessLocationId;
  const platforms = Array.isArray(opts.platforms) ? (opts.platforms as string[]) : [];
  if (locationId && platforms.includes("google_business")) {
    await client.request("POST", "/uploadposts/google-business/locations/select", {
      body: { location_id: String(locationId), profile: String(opts.user) },
    });
  }
  return opts;
}

/** Strip a leading `data:<mime>;base64,` prefix if present. */
function stripDataUri(input: string): string {
  const match = /^data:[^;,]*;base64,/i.exec(input);
  return match ? input.slice(match[0].length) : input;
}

function looksLikeHostedAttachmentPath(input: string): boolean {
  const value = input.trim().toLowerCase();
  return (
    value.startsWith("/mnt/data/") ||
    value.includes("/mnt/data/") ||
    value.startsWith("sandbox:/") ||
    value.startsWith("attachment:") ||
    value.startsWith("openai-file:")
  );
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
        "Publish a video to one or more platforms. Use `videoPathOrUrl` only for public/signed HTTPS URLs, or for absolute local paths when the MCP server runs on the same machine as the file. Hosted clients such as ChatGPT and claude.ai cannot publish attached files by passing `/mnt/data`, sandbox, or mounted local paths; for those files, ALWAYS call `open_upload_studio` first so the browser stages the video to Upload-Post/R2, then publishes it. `videoBase64` is only for clients that can provide raw bytes directly and is capped by UPLOAD_POST_MAX_INLINE_MB (default 100). Returns a `request_id` you can poll with `get_status`. Supports per-platform overrides (tiktokPrivacyLevel, youtubePrivacyStatus, youtubePlaylistId, youtubeThumbnailUrl, youtubeTags, facebookPageId, instagramMediaType, etc.).",
      inputSchema: {
        videoPathOrUrl: z
          .string()
          .optional()
          .describe(
            "Public/signed HTTPS URL of the video. Absolute local paths are supported only for local/self-hosted MCP clients sharing the same filesystem. Do not pass ChatGPT `/mnt/data` or sandbox paths; use open_upload_studio instead."
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
        platforms: z
          .array(VideoPlatform)
          .min(1)
          .describe("Required array of platform identifiers, e.g. ['instagram']. Never pass a single string."),
        title: z.string().optional().describe("Caption / title."),
        description: z.string().optional(),
        firstComment: z.string().optional(),
        ...schedulingFields,
        platformOptions: VideoPlatformOptions
          .optional()
          .describe(
            "Platform-specific overrides as a flat object (camelCase keys), e.g. { tiktokPrivacyLevel: 'PUBLIC_TO_EVERYONE', youtubePrivacyStatus: 'public', youtubePlaylistId: 'PLxxxxxxxxxxxx', facebookPageId: '123' }. `youtubePlaylistId` may also be an array or a comma-separated list of playlist IDs to add the uploaded video to."
          ),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
      },
      _meta: {
        ui: {
          visibility: ["model", "app"],
        },
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Uploading video…",
        "openai/toolInvocation/invoked": "Upload started",
      },
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
      if (videoPathOrUrl && looksLikeHostedAttachmentPath(videoPathOrUrl)) {
        throw new Error(
          "This looks like a hosted ChatGPT/Claude attachment path. The MCP server cannot read mounted paths such as /mnt/data. Use open_upload_studio so the user can select the file in the browser and stage it through Upload-Post/R2, then publish from the returned media URL."
        );
      }

      const options = (await resolvePlatformRouting(client, {
        ...(rest as Record<string, unknown>),
        ...(platformOptions ?? {}),
      })) as never;

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
        platformOptions: PhotoPlatformOptions.optional(),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    safe(async (args) => {
      const { photosPathsOrUrls, platformOptions, ...rest } = args as {
        photosPathsOrUrls: string[];
        platformOptions?: Record<string, unknown>;
        [k: string]: unknown;
      };
      const options = (await resolvePlatformRouting(client, {
        ...(rest as Record<string, unknown>),
        ...(platformOptions ?? {}),
      })) as never;
      return client.sdk.uploadPhotos(photosPathsOrUrls, options);
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
        platformOptions: TextPlatformOptions.optional(),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    safe(async (args) => {
      const { platformOptions, ...rest } = args as {
        platformOptions?: Record<string, unknown>;
        [k: string]: unknown;
      };
      const options = (await resolvePlatformRouting(client, {
        ...(rest as Record<string, unknown>),
        ...(platformOptions ?? {}),
      })) as never;
      return client.sdk.uploadText(options);
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
      outputSchema: genericResultOutputSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
      },
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
