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
    },
    safe(async (args) =>
      client.request("GET", "/uploadposts/google-business/locations", {
        query: compact(args as Record<string, unknown>),
      })
    )
  );

  server.registerTool(
    "get_reddit_subreddits",
    {
      title: "List Reddit subreddits / flairs / post types",
      description:
        "Reddit metadata available to the profile. Use `kind` to choose which list: 'subreddits' (default), 'flairs', 'post-types'.",
      inputSchema: {
        profile: z.string().optional(),
        subreddit: z
          .string()
          .optional()
          .describe("Required when kind='flairs' (the subreddit whose flairs to fetch)."),
        kind: z.enum(["subreddits", "flairs", "post-types"]).optional(),
      },
    },
    safe(async (args) => {
      const { kind = "subreddits", ...rest } = args as { kind?: string; [k: string]: unknown };
      const path =
        kind === "flairs"
          ? "/uploadposts/reddit/flairs"
          : kind === "post-types"
            ? "/uploadposts/reddit/post-types"
            : "/uploadposts/reddit/subreddits";
      return client.request("GET", path, { query: compact(rest) });
    })
  );
}
