import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { safe } from "../schemas.js";

export function registerPagesTools(server: McpServer, client: UploadPostMcpClient): void {
  server.registerTool(
    "get_facebook_pages",
    {
      title: "List Facebook pages",
      description: "Facebook pages connected to a profile.",
      inputSchema: {
        profile: z.string().optional(),
      },
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
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    safe(async (args) =>
      client.request("POST", "/uploadposts/google-business/locations/select", {
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
        profile: z.string().optional(),
        limit: z.number().int().positive().max(200).optional(),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async (args) =>
      client.request("GET", "/uploadposts/reddit/detailed-posts/", {
        query: compact(args as Record<string, unknown>),
      })
    )
  );
}
