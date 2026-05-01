import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { safe } from "../schemas.js";

export function registerTeamTools(server: McpServer, client: UploadPostMcpClient): void {
  server.registerTool(
    "invite_team_member",
    {
      title: "Invite a teammate to a profile",
      description:
        "Share a profile with another Upload-Post account. The recipient must accept via `respond_team_invite` before they can publish.",
      inputSchema: {
        username: z.string().describe("Profile being shared."),
        inviteeEmail: z.string().email(),
        role: z.string().optional().describe("Role / permission level if your plan supports it."),
      },
    },
    safe(async (args) =>
      client.request("POST", "/uploadposts/teams/invite", {
        body: compact(args as Record<string, unknown>),
      })
    )
  );

  server.registerTool(
    "list_team_members",
    {
      title: "List team members",
      description: "Members of a profile (people it has been shared with).",
      inputSchema: {
        username: z.string().optional(),
      },
    },
    safe(async (args) =>
      client.request("GET", "/uploadposts/teams/members", {
        query: compact(args as Record<string, unknown>),
      })
    )
  );

  server.registerTool(
    "remove_team_member",
    {
      title: "Remove a team member",
      description: "Revoke a teammate's access to a profile.",
      inputSchema: {
        username: z.string(),
        memberEmail: z.string().email(),
      },
    },
    safe(async (args) =>
      client.request("POST", "/uploadposts/teams/remove", {
        body: compact(args as Record<string, unknown>),
      })
    )
  );

  server.registerTool(
    "list_shared_profiles",
    {
      title: "List profiles shared with me",
      description: "Profiles that other accounts have shared with this account.",
      inputSchema: {},
    },
    safe(async () => client.request("GET", "/uploadposts/teams/shared-with-me"))
  );

  server.registerTool(
    "respond_team_invite",
    {
      title: "Accept or reject a team invite",
      description:
        "Respond to an invitation to share a profile. Set `decision` to 'accept' or 'reject'.",
      inputSchema: {
        decision: z.enum(["accept", "reject"]),
        inviteId: z.string().optional(),
        username: z.string().optional(),
      },
    },
    safe(async (args) => {
      const { decision, ...rest } = args as { decision: string; [k: string]: unknown };
      return client.request("POST", `/uploadposts/teams/${decision}`, {
        body: compact(rest),
      });
    })
  );
}
