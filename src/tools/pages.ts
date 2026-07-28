import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { genericResultOutputSchema, safe } from "../schemas.js";

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
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async ({ profile }) => client.sdk.getPinterestBoards(profile as string | undefined))
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
        "Recent Reddit posts published from a profile, with the platform-side metadata (subreddit, flair, score, …).",
      inputSchema: {
        profile: z
          .string()
          .describe("Upload-Post profile name. Required by the API."),
        limit: z.number().int().positive().max(200).optional(),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
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
