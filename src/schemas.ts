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

/**
 * Fragments shared by the TikTok capability tools.
 *
 * Every one of those endpoints is scoped to a single Upload-Post profile and
 * most of them paginate with an opaque cursor, so the shape lives here instead
 * of being re-typed (and drifting) in each tool.
 */
export const tiktokProfileField = {
  profile: z
    .string()
    .describe("Upload-Post profile name whose connected TikTok account answers the request."),
};

export const cursorField = {
  cursor: z
    .string()
    .optional()
    .describe("Opaque pagination cursor: pass back the `pagination.next_cursor` of a previous call."),
};

/** `limit` differs per endpoint only in its ceiling, so build it from one place. */
export function limitField(max: number, what: string) {
  return z
    .number()
    .int()
    .min(1)
    .max(max)
    .optional()
    .describe(`${what} to return (1-${max}).`);
}

/**
 * How a tool tells the model which TikTok capability it needs. `capabilities`
 * is the array on the TikTok account returned by list_users; the wording is
 * identical everywhere so the model can learn the check once.
 */
export function requiresTiktokCapability(capability: string, reconnect = false): string {
  const base = `Requires the '${capability}' capability on the profile's TikTok account (see the \`capabilities\` array in list_users).`;
  return reconnect
    ? `${base} It is granted at connection time, so an account connected earlier has to reconnect TikTok before this works.`
    : base;
}
