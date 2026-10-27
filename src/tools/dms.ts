import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { genericResultOutputSchema, safe } from "../schemas.js";

export function registerDmTools(server: McpServer, client: UploadPostMcpClient): { manageAutodms: RegisteredTool } {
  server.registerTool(
    "send_dm",
    {
      title: "Send a direct message",
      description:
        "Send an Instagram DM to a recipient from a connected Upload-Post profile. Use a recipient_id returned by Instagram comments or DM conversation tools.",
      inputSchema: {
        user: z.string().describe("Upload-Post profile name that owns the connected Instagram account."),
        platform: z.literal("instagram").describe("DM platform. Currently only Instagram DMs are supported."),
        recipient_id: z
          .string()
          .describe("Instagram recipient/commenter ID. Required by the Upload-Post API."),
        message: z.string().min(1).describe("DM body to send."),
        buttons: z
          .array(z.object({ title: z.string(), url: z.string().url() }))
          .max(3)
          .optional()
          .describe("Up to 3 web_url buttons rendered in the DM. Each item is { title, url }."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Send a direct message",
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
      },
    },
    safe(async (args) =>
      client.request("POST", "/uploadposts/dms/send", {
        body: compact(args as Record<string, unknown>),
      })
    )
  );

  server.registerTool(
    "list_dm_conversations",
    {
      title: "List DM conversations",
      description: "Recent DM conversations for a profile on a given platform.",
      inputSchema: {
        user: z.string(),
        platform: z.string().optional(),
        limit: z.number().int().positive().max(200).optional(),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "List DM conversations",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async (args) =>
      client.request("GET", "/uploadposts/dms/conversations", {
        query: compact(args as Record<string, unknown>),
      })
    )
  );

  const manageAutodms = server.registerTool(
    "manage_autodms",
    {
      title: "Manage automatic DM monitoring",
      description:
        "Control AutoDM monitors, which answer every comment on a post (or only those containing `trigger_keywords`). Instagram answers with a private DM; TikTok, YouTube, Facebook, Threads and Bluesky answer with a public reply under the comment. For action='start', provide profile_username, reply_message and the post (post_url on Instagram; post_id or post_url elsewhere, plus `platform`). For stop/pause/resume/delete/logs, provide monitor_id. For status, optionally set include_inactive=true.",
      inputSchema: {
        action: z.enum(["start", "stop", "pause", "resume", "delete", "status", "logs"]),
        profile_username: z
          .string()
          .optional()
          .describe("Upload-Post profile name. Required when action='start'."),
        platform: autodmPlatformField,
        post_url: z
          .string()
          .optional()
          .describe("Post URL to monitor. Required on Instagram when action='start'."),
        post_id: autodmPostIdField,
        reply_message: z
          .string()
          .optional()
          .describe("Text sent to matching commenters (a DM on Instagram, a public reply elsewhere). Required when action='start'."),
        reply_messages: autodmReplyMessagesField,
        buttons: z
          .array(z.object({ title: z.string(), url: z.string().url() }))
          .max(3)
          .optional()
          .describe("Instagram only, for action='start': up to 3 web_url buttons ({ title, url }) added to each auto-DM."),
        monitoring_interval: z
          .number()
          .int()
          .min(15)
          .optional()
          .describe("Minutes between comment checks for action='start'. Minimum is 15. Instagram and TikTok answer within seconds, so there it only paces a backup check."),
        trigger_keywords: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe("Optional keyword or keywords; only comments containing these terms are answered (case and accents ignored)."),
        monitor_id: z
          .string()
          .optional()
          .describe("AutoDM monitor ID. Required for stop, pause, resume, delete, and logs."),
        include_inactive: z
          .boolean()
          .optional()
          .describe("For action='status', include stopped and expired monitors when true."),
      },
      outputSchema: genericResultOutputSchema,
      // `action` can be read-only (status/logs) or destructive (stop/delete). We
      // report the worst case (destructive) so callers default to confirmation.
      annotations: {
        title: "Manage automatic DM monitoring",
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
      },
    },
    safe(async (args) => {
      const { action, ...rest } = args as {
        action: string;
        [key: string]: unknown;
      };
      return runAutodm(client, action, rest);
    })
  );

  registerAutodmOperationTools(server, client);
  return { manageAutodms };
}

/** /uploadposts/autodms/<action>: status and logs are GETs, the rest POSTs. */
async function runAutodm(
  client: UploadPostMcpClient,
  action: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const path = `/uploadposts/autodms/${action}`;
  if (action === "status" || action === "logs") {
    return client.request("GET", path, { query: compact(params) });
  }
  return client.request("POST", path, { body: compact(params) });
}

const monitorIdField = z.string().describe("AutoDM monitor ID (from list_autodms or start_autodm).");

const autodmPlatformField = z
  .enum(["instagram", "tiktok", "youtube", "facebook", "threads", "bluesky"])
  .optional()
  .describe(
    "Network of the post. Default instagram, which answers with a private DM. tiktok, youtube, facebook, threads and bluesky have no private reply to a comment, so matching comments get a PUBLIC reply under the comment instead."
  );
const autodmPostIdField = z
  .string()
  .optional()
  .describe(
    "Post to watch on tiktok/youtube/facebook/threads/bluesky (instead of post_url): TikTok video id, YouTube video id, Facebook post id ('{pageId}_{postId}'), Threads post id, Bluesky at:// URI. A TikTok or YouTube URL is also accepted."
  );
const autodmReplyMessagesField = z
  .array(z.string().min(1))
  .max(5)
  .optional()
  .describe(
    "Public replies only: up to 5 alternative texts, rotated across comments so TikTok and YouTube do not see the same reply over and over."
  );

/**
 * One tool per AutoDM operation, each with its own schema and annotations.
 * manage_autodms stays registered alongside them for clients that already call it,
 * except ChatGPT, whose review rejects multi-action tools (see server.ts).
 */
function registerAutodmOperationTools(server: McpServer, client: UploadPostMcpClient): void {
  server.registerTool(
    "start_autodm",
    {
      title: "Start an AutoDM or comment auto-reply",
      description:
        "Watch one of the profile's posts and automatically answer everyone who comments on it (optionally only comments containing `trigger_keywords`, e.g. 'comment POST'). On Instagram (default) the answer is a private DM with `reply_message` and up to 3 link buttons. On tiktok, youtube, facebook, threads and bluesky it is a PUBLIC reply under each matching comment; links in TikTok replies are not clickable, so point people to the bio. Instagram and TikTok answer new comments within seconds; youtube, facebook, threads and bluesky check for them every `monitoring_interval` minutes (15 minimum). At most 25 replies per interval (10 on YouTube), and the monitor stops after 15 days. Returns the monitor ID used by the other AutoDM tools.",
      inputSchema: {
        profile_username: z.string().describe("Upload-Post profile name that owns the connected account."),
        platform: autodmPlatformField,
        post_url: z
          .string()
          .optional()
          .describe("Post URL to watch. Required on Instagram; on the other networks post_id is preferred."),
        post_id: autodmPostIdField,
        reply_message: z.string().min(1).describe("Text sent to matching commenters: a DM on Instagram, a public reply elsewhere."),
        reply_messages: autodmReplyMessagesField,
        buttons: z
          .array(z.object({ title: z.string(), url: z.string().url() }))
          .max(3)
          .optional()
          .describe("Instagram only: up to 3 web_url buttons ({ title, url }) added to each DM."),
        monitoring_interval: z
          .number()
          .int()
          .min(15)
          .optional()
          .describe("Minutes between comment checks. Minimum is 15. Instagram and TikTok answer within seconds, so there it only paces a backup check."),
        trigger_keywords: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe("Keyword or keywords; when set, only comments containing them are answered (case and accents ignored)."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Start an AutoDM or comment auto-reply",
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    safe(async (args) => runAutodm(client, "start", args as Record<string, unknown>))
  );

  server.registerTool(
    "list_autodms",
    {
      title: "List AutoDMs and comment auto-replies",
      description:
        "List the account's AutoDM and comment auto-reply monitors with their `platform`, state and counters. Active ones only, unless `include_inactive` is true.",
      inputSchema: {
        include_inactive: z
          .boolean()
          .optional()
          .describe("Also list stopped and expired monitors."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "List AutoDMs and comment auto-replies",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async (args) => runAutodm(client, "status", args as Record<string, unknown>))
  );

  server.registerTool(
    "get_autodm_logs",
    {
      title: "Get AutoDM logs",
      description: "Read the activity log of one AutoDM monitor: comments seen and DMs sent or failed.",
      inputSchema: { monitor_id: monitorIdField },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Get AutoDM logs",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async (args) => runAutodm(client, "logs", args as Record<string, unknown>))
  );

  server.registerTool(
    "pause_autodm",
    {
      title: "Pause an AutoDM",
      description: "Pause an AutoDM monitor: no DMs are sent until resume_autodm.",
      inputSchema: { monitor_id: monitorIdField },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Pause an AutoDM",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async (args) => runAutodm(client, "pause", args as Record<string, unknown>))
  );

  server.registerTool(
    "resume_autodm",
    {
      title: "Resume an AutoDM",
      description: "Resume a paused AutoDM monitor, so it sends DMs to new matching comments again.",
      inputSchema: { monitor_id: monitorIdField },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Resume an AutoDM",
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    safe(async (args) => runAutodm(client, "resume", args as Record<string, unknown>))
  );

  server.registerTool(
    "stop_autodm",
    {
      title: "Stop an AutoDM",
      description:
        "Stop an AutoDM monitor: it stops sending DMs and shows as stopped in list_autodms (with `include_inactive`). For a temporary break use pause_autodm; to remove it entirely use delete_autodm.",
      inputSchema: { monitor_id: monitorIdField },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Stop an AutoDM",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
      },
    },
    safe(async (args) => runAutodm(client, "stop", args as Record<string, unknown>))
  );

  server.registerTool(
    "delete_autodm",
    {
      title: "Delete an AutoDM",
      description: "Permanently delete an AutoDM monitor with its stats and logs. Cannot be undone.",
      inputSchema: { monitor_id: monitorIdField },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Delete an AutoDM",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
      },
    },
    safe(async (args) => runAutodm(client, "delete", args as Record<string, unknown>))
  );
}
