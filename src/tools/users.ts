import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { genericResultOutputSchema, safe } from "../schemas.js";
import {
  DEFAULT_PROFILE,
  connectInstruction,
  listUsersGuidance,
  resolveConnectLink,
} from "../connect.js";

export function registerUserTools(server: McpServer, client: UploadPostMcpClient): void {
  server.registerTool(
    "get_account_info",
    {
      title: "Validate API key & get account",
      description:
        "Validate the current API key and return account information. Useful as a first call to confirm credentials before doing real work.",
      inputSchema: {},
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Validate API key & get account",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async () => client.request("GET", "/uploadposts/me"))
  );

  server.registerTool(
    "list_users",
    {
      title: "List profiles",
      description:
        "List all Upload-Post profiles in the account, with their connected social accounts. Call this FIRST, before publishing, to get the exact profile name (`user`) and check that the target platforms are connected; never invent a profile name. When the account has no profile, or the requested platform is not connected or needs reconnecting, the response carries `next_step` and `connect_url`: give the user that link, ask them to tell you when they have connected, and wait — do not try to publish meanwhile. The TikTok account object carries a `capabilities` array (music, location, cover_image, cover_timestamp, draft, photo_privacy, video_privacy, inbox_fallback, profile_analytics) telling which optional TikTok fields that connection accepts.",
      inputSchema: {
        platforms: z
          .array(z.string())
          .optional()
          .describe(
            "Optional platforms the user wants to publish to (e.g. ['tiktok','instagram']). When given, the response says whether they are connected and, if not, how to connect them."
          ),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "List profiles",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async (args) => {
      const result = await client.sdk.listUsers();
      const guidance = listUsersGuidance(result, (args as { platforms?: string[] }).platforms);
      if (!guidance || !result || typeof result !== "object") return result;
      return { ...(result as Record<string, unknown>), ...guidance };
    })
  );

  server.registerTool(
    "get_connect_link",
    {
      title: "Get link to connect social accounts",
      description:
        "Get the link the user opens to connect (or reconnect) social accounts such as TikTok, Instagram or YouTube. Use it when list_users shows no profile, or the platform the user wants is not connected or needs reconnecting. " +
        `If the account has no profile yet, this creates one named "${DEFAULT_PROFILE}" and returns a one-click link to connect accounts to it (valid 48 h); otherwise it returns the dashboard link. ` +
        "Give the user `connect_url`, ask them to tell you when they are done, then call list_users to confirm before publishing.",
      inputSchema: {
        platforms: z
          .array(z.string())
          .optional()
          .describe("Platforms the user wants to connect, e.g. ['tiktok','instagram']."),
        profile: z
          .string()
          .optional()
          .describe("Existing profile to connect the accounts to, if the user already has one."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Get link to connect social accounts",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async (args) => {
      const { platforms, profile } = args as { platforms?: string[]; profile?: string };
      const link = await resolveConnectLink(client, { platforms, profile });
      return { ...link, next_step: connectInstruction(link, platforms) };
    })
  );

  server.registerTool(
    "create_user",
    {
      title: "Create profile",
      description: "Create a new Upload-Post profile (logical container for connected socials).",
      inputSchema: {
        username: z.string(),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Create profile",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async ({ username }) => client.sdk.createUser(username as string))
  );

  server.registerTool(
    "delete_user",
    {
      title: "Delete profile",
      description: "Permanently delete a profile and disconnect its socials.",
      inputSchema: {
        username: z.string(),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Delete profile",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
      },
    },
    safe(async ({ username }) => client.sdk.deleteUser(username as string))
  );

  server.registerTool(
    "generate_jwt",
    {
      title: "Generate platform-integration JWT",
      description:
        "Generate a JWT + connection URL so an end-user can connect socials inside an embedded Upload-Post flow (white-label integration). The profile must already exist. Each call resets the profile's connection-page settings to the values passed. To simply help the account owner connect their own socials, prefer get_connect_link.",
      inputSchema: {
        username: z.string(),
        redirectUrl: z.string().optional(),
        logoImage: z.string().optional(),
        redirectButtonText: z.string().optional(),
        platforms: z.array(z.string()).optional(),
        showCalendar: z.boolean().optional(),
        readonlyCalendar: z.boolean().optional(),
        connectTitle: z.string().optional(),
        connectDescription: z.string().optional(),
        language: z
          .enum(["en", "es", "de", "fr", "pt", "pl", "tr"])
          .optional()
          .describe(
            "Force the connection page language for this profile. When omitted, the page auto-detects the visitor's browser language and falls back to English."
          ),
        uiLabels: z
          .record(z.string().max(300))
          .optional()
          .describe(
            "Flat map of i18n dot-path keys to replacement strings for the connection page, e.g. { 'connect.title': 'Link your accounts' }. Max 100 entries; keys must match ^[a-zA-Z0-9_.]+$ and values are at most 300 characters. Echoed back in the `profile` object of validate_jwt."
          ),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Generate platform-integration JWT",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async (args) => {
      const { username, ...rest } = args as { username: string; [k: string]: unknown };
      return client.sdk.generateJwt(username, compact(rest) as never);
    })
  );

  server.registerTool(
    "validate_jwt",
    {
      title: "Validate platform-integration JWT",
      description:
        "Verify a JWT previously issued by `generate_jwt`. The returned `profile` object echoes the connection page settings, including `language` and any `ui_labels`.",
      inputSchema: {
        jwt: z.string(),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Validate platform-integration JWT",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async ({ jwt }) => client.sdk.validateJwt(jwt as string))
  );
}
