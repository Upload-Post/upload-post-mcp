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
    "select_google_business_location",
    {
      title: "Select Google Business location",
      description:
        "Pick the active Google Business location for a profile. Subsequent posts to `google_business` will publish there.",
      inputSchema: {
        profile: z.string(),
        locationId: z.string(),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async (args) => {
      const { profile, locationId } = args as { profile: string; locationId: string };
      return client.request("POST", "/uploadposts/google-business/locations/select", {
        body: compact({ profile, location_id: locationId }),
      });
    })
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
