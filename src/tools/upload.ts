import { z } from "zod";
import { randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LOCAL_FILE_GUIDANCE, isChatGpt, type SessionContext } from "../client_profile.js";
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
  gbpPostType: z
    .enum(["MEDIA", "PHOTO", "GALLERY"])
    .optional()
    .describe(
      "Publish into the Google Business location's photo gallery instead of creating a Local Post. Omitting it keeps the Local Post behaviour."
    ),
  gbpMediaCategory: z
    .enum([
      "COVER",
      "PROFILE",
      "LOGO",
      "EXTERIOR",
      "INTERIOR",
      "PRODUCT",
      "AT_WORK",
      "FOOD_AND_DRINK",
      "MENU",
      "COMMON_AREA",
      "ROOMS",
      "TEAMS",
      "ADDITIONAL",
    ])
    .optional()
    .describe("Google Business gallery category for the uploaded photo. Only used with gbpPostType. Defaults to ADDITIONAL."),
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
  // NOTE: uploads go through the `upload-post` npm SDK, which appends form
  // fields from a fixed allowlist. `tiktok_first_comment` has to be added there
  // before this reaches the API; the generic `firstComment` already does.
  tiktokFirstComment: z
    .string()
    .optional()
    .describe(
      "First comment posted under the TikTok post, overriding the shared `firstComment` for TikTok only. Requires the 'comments' capability on the profile's TikTok account (see the `capabilities` array in list_users)."
    ),
};

// The location tag is identical on video and photo posts: TikTok wants the id
// and the name together, or neither.
const tiktokLocationFields = {
  tiktokLocationId: z
    .string()
    .optional()
    .describe(
      "Location to tag — pass a `location_id` from tiktok_location_search. Must be sent together with tiktokLocationName. Needs the `location` capability (see tiktokMusicId)."
    ),
  tiktokLocationName: z
    .string()
    .optional()
    .describe(
      "Name of the tagged location, from tiktok_location_search. TikTok requires it whenever tiktokLocationId is set."
    ),
};

const VideoPlatformOptions = z
  .object({
    ...commonPlatformOptionFields,
    // TikTok
    tiktokPrivacyLevel: z
      .string()
      .optional()
      .describe(
        "TikTok privacy value: PUBLIC_TO_EVERYONE, MUTUAL_FOLLOW_FRIENDS, FOLLOWER_OF_CREATOR, SELF_ONLY. TikTok decides per account which of these are available (a private account has no PUBLIC_TO_EVERYONE); asking for another one fails with error_code tiktok_privacy_unavailable listing the allowed ones. Omit it to keep the account's own default."
      ),
    tiktokDisableDuet: z.boolean().optional().describe("Disable duets on TikTok."),
    tiktokDisableComment: z.boolean().optional().describe("Disable comments on TikTok."),
    tiktokDisableStitch: z.boolean().optional().describe("Disable stitch on TikTok."),
    tiktokCoverTimestamp: z.number().optional().describe("Cover frame timestamp in ms."),
    tiktokIsAigc: z.boolean().optional().describe("TikTok AI-generated content flag."),
    tiktokPostMode: z
      .enum(["DIRECT_POST", "MEDIA_UPLOAD"])
      .optional()
      .describe(
        "TikTok post mode. DIRECT_POST publishes straight to the account. MEDIA_UPLOAD (Draft) sends the video to the user's TikTok inbox/drafts to publish from the app — RECOMMENDED for TikTok, as publishing natively from the app tends to get more organic reach. Note: in Draft mode TikTok ignores the title/caption and other metadata sent via API; the user adds them in the app before publishing. Defaults to DIRECT_POST."
      ),
    // Capability-gated TikTok keys. The TikTok account object returned by
    // list_users carries a `capabilities` array (music, location, cover_image,
    // cover_timestamp, draft, photo_privacy, video_privacy, inbox_fallback,
    // profile_analytics). When the connection lacks the capability the
    // field is ignored, the post still publishes and the response includes a
    // per-field warning; reconnecting the TikTok account enables it.
    tiktokMusicId: z
      .string()
      .optional()
      .describe(
        "Commercial Music Library track to add to the video — pass a track `id` from tiktok_music_trending (the `id` field, not `commercial_music_id`). Available on connections that declare the `music` capability (see `capabilities` on the TikTok account in list_users); otherwise the field is ignored, the post still publishes and the response includes a per-field warning — reconnect the TikTok account to enable it."
      ),
    tiktokMusicVolume: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe("Volume of the added music track, 0-100. Defaults to 50 when music is set."),
    tiktokMusicStart: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Start offset of the music track, in milliseconds."),
    tiktokMusicEnd: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("End offset of the music track, in milliseconds."),
    tiktokOriginalSoundVolume: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe(
        "Volume of the video's own audio when music is added, 0-100. Defaults to 50 so the original audio is not muted."
      ),
    ...tiktokLocationFields,
    tiktokCoverImageUrl: z
      .string()
      .optional()
      .describe(
        "Custom cover image URL. Takes priority over tiktokCoverTimestamp. Needs the `cover_image` capability (see tiktokMusicId)."
      ),
    tiktokIsAiGenerated: z
      .boolean()
      .optional()
      .describe("Disclose the video as AI-generated content."),
    tiktokUploadToDraft: z
      .boolean()
      .optional()
      .describe(
        "Send the video to TikTok drafts instead of publishing it. When true TikTok ignores the rest of the post settings. Needs the `draft` capability (see tiktokMusicId)."
      ),
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
    tiktokPrivacyLevel: z
      .string()
      .optional()
      .describe(
        "TikTok privacy value: PUBLIC_TO_EVERYONE, MUTUAL_FOLLOW_FRIENDS, FOLLOWER_OF_CREATOR, SELF_ONLY. TikTok requires one on photo posts (defaults to PUBLIC_TO_EVERYONE) and decides per account which values are available."
      ),
    tiktokPhotoCoverIndex: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Index of the cover photo, 0-based. Sent as `photo_cover_index`; picks the cover of a TikTok photo post."),
    // TikTok photo posts accept the music track id, the location pair and the AI
    // disclosure. They do NOT accept the volume/trim, custom cover or draft
    // fields — those are video-only, which is why they are absent here.
    tiktokMusicId: z
      .string()
      .optional()
      .describe(
        "Commercial Music Library track to add to the photo post — pass a track `id` from tiktok_music_trending or tiktok_music_search (the `id` field, not `commercial_music_id`). TikTok's photo posts take the id alone: there is no volume or trim. Available on connections that declare the `music` capability (see `capabilities` on the TikTok account in list_users); otherwise the field is ignored, the post still publishes and the response includes a per-field warning."
      ),
    ...tiktokLocationFields,
    tiktokIsAiGenerated: z
      .boolean()
      .optional()
      .describe("Disclose the photo post as AI-generated content."),
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
 * - `googleBusinessLocationId` is an alias of the SDK's `gbpLocationId`, which
 *   the API reads from the upload form. There is no persistent location
 *   selection: /uploadposts/google-business/locations/select does not exist.
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
  if (locationId && !opts.gbpLocationId) {
    opts.gbpLocationId = String(locationId);
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
export interface UploadToolHandles {
  /** Re-shape upload_video guidance for hosts that do not get the Studio widget. */
  applyClientProfile(ctx: SessionContext): void;
}

const UPLOAD_VIDEO_DESCRIPTION_BASE =
  "Publish a video to one or more platforms. Use `videoPathOrUrl` only for public/signed HTTPS URLs, or for absolute local paths when the MCP server runs on the same machine as the file. `videoBase64` is only for clients that can provide raw bytes directly and is capped by UPLOAD_POST_MAX_INLINE_MB (default 100). Returns a `request_id` you can poll with `get_status`. Supports per-platform overrides (tiktokPrivacyLevel, youtubePrivacyStatus, youtubePlaylistId, youtubeThumbnailUrl, youtubeTags, facebookPageId, instagramMediaType, etc.).";

const UPLOAD_VIDEO_DESCRIPTION_CHATGPT =
  UPLOAD_VIDEO_DESCRIPTION_BASE +
  " A hosted MCP server cannot publish attached files passed as `/mnt/data`, sandbox, or other mounted local paths; for those files, ALWAYS call `open_upload_studio` first so the browser stages the video, then publishes it.";

const UPLOAD_VIDEO_DESCRIPTION_OTHER = UPLOAD_VIDEO_DESCRIPTION_BASE + " " + LOCAL_FILE_GUIDANCE;

export function registerUploadTools(
  server: McpServer,
  client: UploadPostMcpClient,
  ctx: SessionContext = {}
): UploadToolHandles {
  const uploadVideoTool = server.registerTool(
    "upload_video",
    {
      title: "Upload video",
      description: UPLOAD_VIDEO_DESCRIPTION_CHATGPT,
      inputSchema: {
        videoPathOrUrl: z
          .string()
          .optional()
          .describe(
            "Public/signed HTTPS URL of the video (a staged `media_url` from complete_media_upload also works). Absolute local paths are supported only for local/self-hosted MCP clients sharing the same filesystem. Never pass `/mnt/data`, sandbox, or other mounted attachment paths: the server cannot read them."
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
        firstComment: z
          .string()
          .optional()
          .describe(
            "Comment auto-posted under the post right after publishing. Supported on every platform that has comments, TikTok included. Use `platformOptions.<platform>FirstComment` to override it for one platform."
          ),
        ...schedulingFields,
        platformOptions: VideoPlatformOptions
          .optional()
          .describe(
            "Platform-specific overrides as a flat object (camelCase keys), e.g. { tiktokPrivacyLevel: 'PUBLIC_TO_EVERYONE', youtubePrivacyStatus: 'public', youtubePlaylistId: 'PLxxxxxxxxxxxx', facebookPageId: '123' }. `youtubePlaylistId` may also be an array or a comma-separated list of playlist IDs to add the uploaded video to. The `tiktokMusic*`, `tiktokLocation*`, `tiktokCoverImageUrl` and `tiktokUploadToDraft` keys depend on the TikTok connection's `capabilities` (see list_users); discover valid values with tiktok_music_trending and tiktok_location_search."
          ),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Upload video",
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
          isChatGpt(ctx)
            ? "This looks like a hosted attachment path. The MCP server cannot read mounted paths such as /mnt/data. Use open_upload_studio so the user can select the file in the browser and stage it through Upload-Post, then publish from the returned media URL."
            : "This looks like a hosted attachment path. The MCP server cannot read mounted paths such as /mnt/data. " + LOCAL_FILE_GUIDANCE
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
        firstComment: z
          .string()
          .optional()
          .describe(
            "Comment auto-posted under the post right after publishing. Supported on every platform that has comments, TikTok included. Use `platformOptions.<platform>FirstComment` to override it for one platform."
          ),
        altText: z.string().optional(),
        ...schedulingFields,
        platformOptions: PhotoPlatformOptions.optional(),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Upload photos / carousel",
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
        title: "Upload text post",
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
        title: "Upload document (LinkedIn)",
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

  return {
    applyClientProfile(profileCtx) {
      if (isChatGpt(profileCtx)) return;
      uploadVideoTool.update({ description: UPLOAD_VIDEO_DESCRIPTION_OTHER });
    },
  };
}
