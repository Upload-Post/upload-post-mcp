import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { safe } from "../schemas.js";

export function registerUserTools(server: McpServer, client: UploadPostMcpClient): void {
  server.registerTool(
    "list_users",
    {
      title: "List profiles",
      description: "List all Upload-Post profiles in the account, with their connected social accounts.",
      inputSchema: {},
    },
    safe(async () => client.sdk.listUsers())
  );

  server.registerTool(
    "create_user",
    {
      title: "Create profile",
      description: "Create a new Upload-Post profile (logical container for connected socials).",
      inputSchema: {
        username: z.string(),
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
    },
    safe(async ({ username }) => client.sdk.deleteUser(username as string))
  );

  server.registerTool(
    "disconnect_social",
    {
      title: "Disconnect a social account",
      description:
        "Disconnect a single social platform from a profile, leaving the profile and its other accounts intact.",
      inputSchema: {
        username: z.string(),
        platform: z.string().describe("Platform key, e.g. 'tiktok', 'instagram', 'youtube'."),
      },
    },
    safe(async (args) =>
      client.request("DELETE", "/uploadposts/users/social", {
        body: compact(args as Record<string, unknown>),
      })
    )
  );

  server.registerTool(
    "generate_jwt",
    {
      title: "Generate platform-integration JWT",
      description:
        "Generate a JWT + connection URL so an end-user can connect socials inside an embedded Upload-Post flow (white-label integration).",
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
      description: "Verify a JWT previously issued by `generate_jwt`.",
      inputSchema: {
        jwt: z.string(),
      },
    },
    safe(async ({ jwt }) => client.sdk.validateJwt(jwt as string))
  );
}
