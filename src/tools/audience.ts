import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { genericResultOutputSchema, requiresTiktokCapability, safe } from "../schemas.js";

/**
 * "Who is the audience" and "what should I write about" are two questions the
 * API answers for whichever network is named in `platform`, exactly like
 * get_post_comments or get_post_analytics. They are not per-network endpoints,
 * so they do not live in a per-network module either.
 */

/** Platforms that can answer these questions today. */
const AudiencePlatform = z
  .enum(["tiktok"])
  .describe(
    "Which connected network answers the question. Any other value comes back as a 400 `platform_not_supported` listing the ones that do."
  );

export function registerAudienceTools(server: McpServer, client: UploadPostMcpClient): void {
  server.registerTool(
    "get_audience",
    {
      title: "Get audience insights",
      description:
        "Who follows the profile, when they are online and what they tap on it. One endpoint for every network, chosen with `platform`. Returns `audience.countries` / `.cities` / `.ages` / `.genders`, `activity_by_hour` (followers online per hour of the day — use it to pick posting times), `followers_daily` (total / new / lost), `profile_actions` and `bio_description`. It always returns `benchmark_categories` (the 25 values `benchmark_category` accepts), and when `benchmark_category` is set it adds a `benchmark` object with that niche's averages (engagement rate, likes, views, follower growth…) to compare the account against. The window is clamped by the server — at most 60 days, always ending before today — so a wider range is trimmed, not rejected; `range` in the response says which window was actually used. " +
        requiresTiktokCapability("profile_analytics"),
      inputSchema: {
        user: z.string().describe("Upload-Post profile name."),
        platform: AudiencePlatform,
        startDate: z
          .string()
          .optional()
          .describe("First day of the window, ISO date, e.g. '2026-07-01'. Sent as `start_date`."),
        endDate: z
          .string()
          .optional()
          .describe(
            "Last day of the window, ISO date. Sent as `end_date`. Clamped to before today: platforms have no data for the current day."
          ),
        benchmarkCategory: z
          .string()
          .optional()
          .describe(
            "Compare the account against this niche's averages. Must be one of the `benchmark_categories` the response lists; omit it on the first call to read them."
          ),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Get audience insights",
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    safe(async (args) => {
      const a = args as {
        user: string;
        platform: string;
        startDate?: string;
        endDate?: string;
        benchmarkCategory?: string;
      };
      // The API reads snake_case query params; the tool surface stays camelCase
      // like the rest of the server, so map explicitly here.
      return client.request("GET", "/uploadposts/audience", {
        query: compact({
          user: a.user,
          platform: a.platform,
          start_date: a.startDate,
          end_date: a.endDate,
          benchmark_category: a.benchmarkCategory,
        }),
      });
    })
  );

  server.registerTool(
    "get_suggestions",
    {
      title: "Get hashtag or keyword suggestions",
      description:
        "What to write about: the hashtags or the searches a network suggests around a word. One endpoint for both questions, told apart by `type`, and one endpoint for every network, chosen with `platform`. `type: 'hashtags'` returns `{ hashtags: [{ name, view_count }] }` — pick tags that actually have reach for a caption; `type: 'keywords'` returns `{ keywords: [...] }`, what people really search around `q`, useful for the next video topic. " +
        requiresTiktokCapability("profile_analytics") +
        " Keyword suggestions need 'trend_search' instead, granted the same way.",
      inputSchema: {
        user: z.string().describe("Upload-Post profile name."),
        platform: AudiencePlatform,
        type: z
          .enum(["hashtags", "keywords"])
          .describe("Which suggestions to ask for: 'hashtags' (with view counts) or 'keywords' (related searches)."),
        q: z.string().optional().describe("Seed word to get suggestions around, e.g. 'coffee recipe'. Without the '#'."),
        countryCode: z
          .string()
          .optional()
          .describe("ISO 3166-1 alpha-2 country to rank the suggestions for, e.g. 'ES' or 'US'. Sent as `country_code`."),
        language: z.string().optional().describe("Language code for the results, e.g. 'es' or 'en'."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Get hashtag or keyword suggestions",
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    safe(async (args) => {
      const a = args as {
        user: string;
        platform: string;
        type: "hashtags" | "keywords";
        q?: string;
        countryCode?: string;
        language?: string;
      };
      return client.request("GET", "/uploadposts/suggestions", {
        query: compact({
          user: a.user,
          platform: a.platform,
          type: a.type,
          q: a.q,
          country_code: a.countryCode,
          language: a.language,
        }),
      });
    })
  );
}
