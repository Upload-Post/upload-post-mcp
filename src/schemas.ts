import { z } from "zod";

export const VideoPlatform = z.enum([
  "tiktok",
  "instagram",
  "youtube",
  "linkedin",
  "facebook",
  "pinterest",
  "threads",
  "reddit",
  "bluesky",
  "x",
  "google_business",
  "discord",
  "telegram",
  "mastodon",
  "wordpress",
]);

export const PhotoPlatform = z.enum([
  "tiktok",
  "instagram",
  "linkedin",
  "facebook",
  "pinterest",
  "threads",
  "reddit",
  "bluesky",
  "x",
  "google_business",
  "discord",
  "telegram",
  "mastodon",
  "lemmy",
  "wordpress",
]);

export const TextPlatform = z.enum([
  "x",
  "linkedin",
  "facebook",
  "threads",
  "reddit",
  "bluesky",
  "google_business",
  "discord",
  "telegram",
  "slack",
  "mastodon",
  "nostr",
  "lemmy",
  "devto",
  "hashnode",
  "wordpress",
  "whop",
  "listmonk",
]);

export const AnalyticsPlatform = z.enum([
  "tiktok",
  "instagram",
  "youtube",
  "linkedin",
  "facebook",
  "pinterest",
  "threads",
  "x",
  "reddit",
]);

/**
 * Common scheduling/queue fields shared by every upload tool.
 */
export const schedulingFields = {
  scheduledDate: z
    .string()
    .optional()
    .describe(
      "ISO 8601 date for scheduled publishing, e.g. '2026-12-25T10:00:00Z'. Omit for immediate post."
    ),
  timezone: z
    .string()
    .optional()
    .describe("IANA timezone for scheduled date, e.g. 'Europe/Madrid'."),
  addToQueue: z
    .boolean()
    .optional()
    .describe("Insert into the user's posting queue instead of publishing now."),
  maxPostsPerSlot: z.number().int().positive().optional(),
  asyncUpload: z
    .boolean()
    .optional()
    .describe("Return immediately with request_id (default true)."),
    .describe(
      "If true, AI generates native per-platform title/description from the media and fills any field left empty."
    ),
    .describe("Force the AI output language (ISO code); omit to auto-detect from the media."),
};

export const genericResultOutputSchema = {
  result: z.unknown(),
};

/** Standard MCP-style content envelope. */
export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: { result: unknown };
  isError?: boolean;
};

export function ok(payload: unknown): ToolResult {
  return {
    content: [
      {
        type: "text",
        text:
          typeof payload === "string"
            ? payload
            : JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: { result: payload },
  };
}

export function fail(err: unknown): ToolResult {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

/** Wrap any tool handler so SDK/HTTP errors bubble up as MCP isError results. */
export function safe<TArgs>(
  handler: (args: TArgs) => Promise<unknown>
): (args: TArgs) => Promise<ToolResult> {
  return async (args) => {
    try {
      const result = await handler(args);
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  };
}
