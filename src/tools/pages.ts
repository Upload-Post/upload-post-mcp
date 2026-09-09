import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { genericResultOutputSchema, REDDIT_UNAVAILABLE, safe } from "../schemas.js";

export function registerPagesTools(server: McpServer, client: UploadPostMcpClient): void {
  server.registerTool(
    "get_facebook_pages",
    {
      title: "List Facebook pages",
      description: "Facebook pages connected to a profile.",
      inputSchema: {
        profile: z.string().optional(),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "List Facebook pages",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async ({ profile }) => client.sdk.getFacebookPages(profile as string | undefined))
  );

  server.registerTool(
    "get_linkedin_pages",
    {
      title: "List LinkedIn pages",
      description: "LinkedIn company pages connected to a profile.",
      inputSchema: {
        profile: z.string().optional(),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "List LinkedIn pages",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async ({ profile }) => client.sdk.getLinkedinPages(profile as string | undefined))
  );

  server.registerTool(
    "get_pinterest_boards",
    {
      title: "List Pinterest boards",
      description: "Pinterest boards available to a profile.",
      inputSchema: {
        profile: z.string().optional(),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "List Pinterest boards",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async ({ profile }) => client.sdk.getPinterestBoards(profile as string | undefined))
  );

  // Shared by the two music tools: same filters, same cached chart slice.
  const tiktokProfile = z
    .string()
    .describe("Upload-Post profile name with a TikTok account connected.");
  const musicGenre = z
    .string()
    .optional()
    .describe("Genre filter, e.g. 'ALL' or 'POP'. Defaults to ALL.");
  const musicDateRange = z
    .enum(["1DAY", "7DAY", "30DAY", "90DAY"])
    .optional()
    .describe("Chart window. Defaults to 7DAY.");
  const readOnlyTikTokAnnotations = (title: string) => ({
    title,
    readOnlyHint: true,
    openWorldHint: true,
    destructiveHint: false,
  });

  server.registerTool(
    "tiktok_music_trending",
    {
      title: "List trending TikTok music",
      description:
        "Trending tracks from the TikTok Commercial Music Library, to soundtrack a TikTok video. Pass the returned track `id` as `tiktokMusicId` in upload_video's platformOptions (not `commercial_music_id`, which TikTok rejects on public posts). Available on TikTok connections that declare the `music` capability (see `capabilities` on the TikTok account in list_users).",
      inputSchema: {
        profile: tiktokProfile,
        genre: musicGenre,
        countryCode: z.string().optional().describe("ISO country code, e.g. 'US' or 'ES'. Defaults to US."),
        dateRange: musicDateRange,
      },
      outputSchema: genericResultOutputSchema,
      annotations: readOnlyTikTokAnnotations("List trending TikTok music"),
    },
    safe(async (args) => {
      const { profile, genre, countryCode, dateRange } = args as {
        profile: string;
        genre?: string;
        countryCode?: string;
        dateRange?: "1DAY" | "7DAY" | "30DAY" | "90DAY";
      };
      return client.sdk.getTiktokTrendingMusic(profile, { genre, countryCode, dateRange });
    })
  );

  server.registerTool(
    "tiktok_music_search",
    {
      title: "Search TikTok music",
      description:
        "Find a TikTok Commercial Music Library track by song title or artist, to soundtrack a TikTok video. Pass the returned track `id` as `tiktokMusicId` in upload_video's platformOptions (not `commercial_music_id`, which TikTok rejects on public posts). IMPORTANT: TikTok has no music search endpoint, so this searches the trending charts Upload-Post caches per genre/country/period, NOT TikTok's whole catalogue — a song that is not trending in the chart you query will not be found; widening the search means trying another genre, country or period. Matching is case- and accent-insensitive and every word must match. Available on TikTok connections that declare the `music` capability (see `capabilities` on the TikTok account in list_users).",
      inputSchema: {
        profile: tiktokProfile,
        q: z
          .string()
          .max(80)
          .optional()
          .describe("Song title or artist to look for, e.g. 'bad bunny'. Omit to get the chart in trending order."),
        genre: musicGenre,
        countryCode: z
          .string()
          .optional()
          .describe("ISO country code choosing WHICH country's chart is searched, e.g. 'US' or 'ES'. Defaults to US."),
        dateRange: musicDateRange,
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum tracks to return. Defaults to 50."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: readOnlyTikTokAnnotations("Search TikTok music"),
    },
    safe(async (args) => {
      const { profile, q, genre, countryCode, dateRange, limit } = args as {
        profile: string;
        q?: string;
        genre?: string;
        countryCode?: string;
        dateRange?: "1DAY" | "7DAY" | "30DAY" | "90DAY";
        limit?: number;
      };
      return client.sdk.searchTiktokMusic(profile, { q, genre, countryCode, dateRange, limit });
    })
  );

  server.registerTool(
    "tiktok_location_search",
    {
      title: "Search TikTok locations",
      description:
        "Search TikTok places to tag on a post. TikTok needs both parts, so pass the returned `location_id` as `tiktokLocationId` and `location_name` as `tiktokLocationName` in upload_video's platformOptions. Available on TikTok connections that declare the `location` capability (see `capabilities` on the TikTok account in list_users).",
      inputSchema: {
        profile: tiktokProfile,
        query: z.string().min(1).max(100).describe("Place to search for, e.g. 'Madrid'. Max 100 characters."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: readOnlyTikTokAnnotations("Search TikTok locations"),
    },
    safe(async (args) => {
      const { profile, query } = args as { profile: string; query: string };
      return client.sdk.getTiktokLocations(profile, query);
    })
  );

  server.registerTool(
    "tiktok_publishing_settings",
    {
      title: "Get TikTok publishing settings",
      description:
        "What the connected TikTok account is allowed to publish. Call this before setting `tiktokPrivacyLevel`: TikTok narrows the four privacy values per account (a private account has no PUBLIC_TO_EVERYONE), and sending one the account does not have fails the upload with error_code tiktok_privacy_unavailable. Returns `privacy_level_options` plus the account's max video duration and its comment/duet/stitch switches.",
      inputSchema: {
        profile: tiktokProfile,
      },
      outputSchema: genericResultOutputSchema,
      annotations: readOnlyTikTokAnnotations("Get TikTok publishing settings"),
    },
    safe(async (args) => {
      const { profile } = args as { profile: string };
      return client.sdk.getTiktokPublishingSettings(profile);
    })
  );

  server.registerTool(
    "get_google_business_locations",
    {
      title: "List Google Business locations",
      description: "Google Business Profile locations the profile can post to.",
      inputSchema: {
        profile: z.string().optional(),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "List Google Business locations",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async (args) =>
      client.request("GET", "/uploadposts/google-business/locations", {
        query: compact(args as Record<string, unknown>),
      })
    )
  );

  server.registerTool(
    "get_google_business_reviews",
    {
      title: "List Google Business reviews",
      description:
        "List reviews for a Google Business Profile location. Pass the profile that owns the connected Google Business account; location_id defaults to the account's selected location.",
      inputSchema: {
        user: z.string().describe("Upload-Post profile name that owns the connected Google Business account."),
        location_id: z
          .string()
          .optional()
          .describe("Location, e.g. 'locations/123' or a full 'accounts/.../locations/...'. Defaults to the account's location."),
        pageSize: z.number().int().positive().max(50).optional(),
        pageToken: z.string().optional(),
        orderBy: z.string().optional().describe("e.g. 'updateTime desc' or 'rating desc'."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "List Google Business reviews",
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    safe(async (args) =>
      client.request("GET", "/uploadposts/google-business/reviews", {
        query: compact(args as Record<string, unknown>),
      })
    )
  );

  server.registerTool(
    "reply_to_google_business_review",
    {
      title: "Reply to a Google Business review",
      description:
        "Create or update the owner reply to a Google Business review. Provide review_name (the full resource path from get_google_business_reviews) or review_id + location_id.",
      inputSchema: {
        user: z.string().describe("Upload-Post profile name that owns the connected Google Business account."),
        comment: z.string().min(1).describe("The reply text posted publicly under the review."),
        review_name: z
          .string()
          .optional()
          .describe("Full review resource path 'accounts/.../locations/.../reviews/{id}' (from get_google_business_reviews)."),
        review_id: z.string().optional().describe("Review ID; requires location_id to build the resource path."),
        location_id: z.string().optional().describe("Location for the review when using review_id."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Reply to a Google Business review",
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
      },
    },
    safe(async (args) =>
      client.request("PUT", "/uploadposts/google-business/reviews/reply", {
        body: compact(args as Record<string, unknown>),
      })
    )
  );

  server.registerTool(
    "get_reddit_detailed_posts",
    {
      title: "Get detailed Reddit posts",
      description:
        `${REDDIT_UNAVAILABLE} Recent Reddit posts published from a profile, with the platform-side metadata (subreddit, flair, score, …).`,
      inputSchema: {
        profile: z
          .string()
          .describe("Upload-Post profile name. Required by the API."),
        limit: z.number().int().positive().max(200).optional(),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Get detailed Reddit posts",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async (args) => {
      const { profile, ...rest } = args as { profile?: string; [k: string]: unknown };
      // The API requires the param to be named `profile_username`, not `profile`.
      return client.request("GET", "/uploadposts/reddit/detailed-posts/", {
        query: compact({ ...rest, profile_username: profile }),
      });
    })
  );
}
