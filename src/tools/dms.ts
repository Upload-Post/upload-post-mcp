import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { genericResultOutputSchema, safe } from "../schemas.js";

export function registerDmTools(
  server: McpServer,
  client: UploadPostMcpClient
): { manageAutodms: RegisteredTool; autodmRuleTools: RegisteredTool[] } {
  server.registerTool(
    "send_dm",
    {
      title: "Send a direct message",
      description:
        "Send a DM as a connected Upload-Post profile, on Instagram or Bluesky. " +
        "Instagram: `recipient_id` (from Instagram comments or the DM conversation tools) and `message`, optionally up to 3 link `buttons`. " +
        "Bluesky: `recipient_id` is the person's handle (e.g. 'alice.bsky.social'), DID or profile link, or pass `conversation_id` (also for group chats) instead. The text may carry links, @mentions (up to 10) and #hashtags, which become clickable; at most 1000 characters. Optional `reply_to` (a message id) and one shared Bluesky post in `attachments`; Bluesky chat takes no images, files or buttons. " +
        "With `sender_action` (Bluesky only) nothing is written: mark_seen/mark_read, react/unreact (`message_id` + one emoji in `reaction`), delete (`message_id`; removes it only for this account), accept (a message request), mute, unmute, leave. Sender actions do not count toward the daily DM allowance. " +
        "Bluesky DMs need the account connected with an app password created with 'Allow access to your direct messages'; otherwise the call returns 403 `bluesky_dm_scope_missing` and the user has to create such an app password and reconnect Bluesky. Other Bluesky errors: 403 `bluesky_recipient_unavailable` (the person does not accept DMs from this account, with `reason`), 404 `bluesky_recipient_not_found`, 400 `bluesky_message_too_long`, 504 `bluesky_send_unconfirmed` (the DM may have gone out: list the conversation before retrying).",
      inputSchema: {
        user: z.string().describe("Upload-Post profile name that owns the connected account."),
        platform: z
          .enum(["instagram", "bluesky"])
          .describe("DM platform: 'instagram' or 'bluesky'."),
        recipient_id: z
          .string()
          .optional()
          .describe(
            "Who receives the DM. Instagram (required): the recipient/commenter ID. Bluesky: handle, @handle, DID or bsky.app profile link; optional when `conversation_id` is given."
          ),
        message: z
          .string()
          .min(1)
          .optional()
          .describe("DM text. Required on Instagram. On Bluesky optional when sharing a post in `attachments` or using `sender_action`."),
        buttons: z
          .array(z.object({ title: z.string(), url: z.string().url() }))
          .max(3)
          .optional()
          .describe("Instagram only: up to 3 web_url buttons rendered in the DM. Each item is { title, url }."),
        conversation_id: z
          .string()
          .optional()
          .describe("Bluesky only: send to (or act on) this conversation, from list_dm_conversations. Works for group chats."),
        attachments: z
          .object({
            type: z.literal("post").optional().describe("Always 'post'."),
            url: z.string().describe("bsky.app post link or at:// URI of the post to share."),
          })
          .optional()
          .describe("Bluesky only: one Bluesky post to share in the DM, { type: 'post', url }."),
        reply_to: z
          .string()
          .optional()
          .describe("Bluesky only: id of the message this DM replies to."),
        sender_action: z
          .enum(["mark_seen", "mark_read", "react", "unreact", "delete", "accept", "mute", "unmute", "leave"])
          .optional()
          .describe(
            "Bluesky only: act on the conversation instead of sending text. react/unreact and delete need `message_id`; mark_read is the same as mark_seen."
          ),
        message_id: z
          .string()
          .optional()
          .describe("Bluesky only: message the sender_action applies to (react, unreact, delete, and optionally mark_seen)."),
        reaction: z
          .string()
          .optional()
          .describe("Bluesky only: a single emoji for sender_action react/unreact."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Send a direct message",
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
      },
    },
    safe(async (args) => {
      const a = compact(args as Record<string, unknown>);
      if (a.platform === "bluesky") {
        if (!a.recipient_id && !a.conversation_id) {
          throw new Error("Bluesky DMs need `recipient_id` (handle, DID or profile link) or `conversation_id`.");
        }
        if (!a.message && !a.attachments && !a.sender_action) {
          throw new Error("Bluesky DMs need `message`, a shared post in `attachments`, or a `sender_action`.");
        }
        if (a.buttons) {
          throw new Error("Bluesky DMs do not support `buttons`: put the link in `message`, where it becomes clickable.");
        }
      } else {
        const blueskyOnly = BLUESKY_ONLY_DM_FIELDS.filter((k) => a[k] !== undefined);
        if (blueskyOnly.length) {
          throw new Error(`${blueskyOnly.join(", ")}: Bluesky only in this tool. On Instagram send recipient_id, message and optional buttons.`);
        }
        if (!a.recipient_id || !a.message) {
          throw new Error("Instagram DMs need `recipient_id` and `message`.");
        }
      }
      return client.request("POST", "/uploadposts/dms/send", { body: a });
    })
  );

  server.registerTool(
    "list_dm_conversations",
    {
      title: "List DM conversations",
      description:
        "DM conversations for a profile on a given platform, newest first, each with its latest messages. " +
        "The response carries `pagination` { next_cursor, has_more }: to read older conversations, call again with `cursor` set to " +
        "`next_cursor` (and the same `since` / `participant_id`) until `has_more` is false. " +
        "Media a message carries comes back in `attachments` (`type`, `url`, plus size and preview fields when the platform gives them); " +
        "content the platform flags `is_unsupported` cannot be retrieved. " +
        "Bluesky (read live, up to 25 conversations per page) adds per conversation `status` (request / accepted), `unread_count`, `muted`, `kind` (direct / group) and per message `direction`, `reactions`, `reply_to` and shared posts in `attachments`; " +
        "use `conversation_id` (+ `messages_cursor`) to page back through one conversation's history, and `status` / `read_state` to filter. " +
        "Bluesky needs the account connected with an app password that allows direct messages, otherwise 403 `bluesky_dm_scope_missing`.",
      inputSchema: {
        user: z.string().describe("Upload-Post profile name that owns the connected account."),
        platform: z
          .string()
          .optional()
          .describe("'instagram', 'whatsapp', 'facebook' (Messenger) or 'bluesky'. Required by the Upload-Post API. Messenger is in a limited rollout: an account without access gets 403 `messenger_not_enabled`, and no plan, setting or reconnect changes that (the user can ask Upload-Post support for access)."),
        limit: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .describe("Conversations per page. Default 20; the API returns at most 50 per page (25 on Bluesky)."),
        cursor: z
          .string()
          .optional()
          .describe("`pagination.next_cursor` from the previous call, to get the next (older) page. Omit for the first page."),
        since: z
          .union([z.string(), z.number()])
          .optional()
          .describe(
            "Only conversations with activity after this moment: Unix timestamp (seconds) or ISO 8601 date, e.g. '2026-11-01T00:00:00Z'."
          ),
        participant_id: z
          .string()
          .optional()
          .describe(
            "Return only the conversation with this person: the other participant's `id` from a previous listing " +
              "(on Instagram, the same id send_dm takes as recipient_id; on WhatsApp, their phone number; on Bluesky, their handle or DID). " +
              "On Bluesky this never opens a new conversation."
          ),
        messages_limit: z
          .number()
          .int()
          .positive()
          .max(25)
          .optional()
          .describe(
            "Latest messages returned per conversation, 1-25. Default 10. When raising it, lower `limit` (10-20 conversations): " +
              "a large page with many messages is slow, and Instagram may then answer with text only, without attachments."
          ),
        conversation_id: z
          .string()
          .optional()
          .describe("Bluesky only: return just this conversation (direct or group), with its messages."),
        messages_cursor: z
          .string()
          .optional()
          .describe("Bluesky only, with `conversation_id`: the conversation's `messages.paging.next_cursor` from the previous answer, to read its older messages."),
        status: z
          .enum(["request", "accepted"])
          .optional()
          .describe("Bluesky only: 'request' = message requests not accepted yet, 'accepted' = regular conversations."),
        read_state: z
          .literal("unread")
          .optional()
          .describe("Bluesky only: 'unread' returns only conversations with unread messages."),
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
  const autodmRuleTools = registerAutodmRuleTools(server, client);
  return { manageAutodms, autodmRuleTools };
}

const BLUESKY_ONLY_DM_FIELDS = ["conversation_id", "attachments", "reply_to", "sender_action", "message_id", "reaction"];

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
        "Watch one of the profile's posts and automatically answer everyone who comments on it (optionally only comments containing `trigger_keywords`, e.g. 'comment POST'). On Instagram (default) the answer is a private DM with `reply_message` and up to 3 link buttons. On tiktok, youtube, facebook, threads and bluesky it is a PUBLIC reply under each matching comment; links in TikTok replies are not clickable, so point people to the bio. Instagram and TikTok answer new comments within seconds; youtube, facebook, threads and bluesky check for them every `monitoring_interval` minutes (15 minimum). At most 25 replies per interval (10 on YouTube), and the monitor stops after 15 days. Returns the monitor ID used by the other AutoDM tools. For Instagram DMs on EVERY post of the account, story replies, story mentions or DM keywords, use create_autodm_rule instead: rules cover the whole account, never expire and work only through Instagram webhooks.",
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
        "List the account's AutoDM and comment auto-reply monitors (one post each) with their `platform`, state and counters. Active ones only, unless `include_inactive` is true. Account-wide Instagram rules (every post, stories, DM keywords; no expiry) are listed by list_autodm_rules.",
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

const ruleIdField = z.string().min(1).describe("AutoDM rule ID (`rule_id` from list_autodm_rules or create_autodm_rule).");

/** /uploadposts/autodms/rules[/<action>]: list is a GET, create and the actions POSTs. */
function runAutodmRule(
  client: UploadPostMcpClient,
  action: "create" | "list" | "pause" | "resume" | "delete",
  params: Record<string, unknown>
): Promise<unknown> {
  if (action === "list") {
    return client.request("GET", "/uploadposts/autodms/rules", { query: compact(params) });
  }
  const path = action === "create" ? "/uploadposts/autodms/rules" : `/uploadposts/autodms/rules/${action}`;
  return client.request("POST", path, { body: compact(params) });
}

/**
 * Account-wide Instagram AutoDM rules: one rule answers comments on every post
 * and reel of the account (present and future), story replies, story mentions
 * and DMs with a keyword. They never expire and run only on Instagram webhooks.
 */
function registerAutodmRuleTools(server: McpServer, client: UploadPostMcpClient): RegisteredTool[] {
  const create = server.registerTool(
    "create_autodm_rule",
    {
      title: "Create an account-wide Instagram AutoDM rule",
      description:
        "Create a rule that AUTOMATICALLY sends private Instagram DMs as the user, with nobody reviewing each message, to everyone who triggers it on the whole Instagram account: comments on ANY post or reel (present and future), and optionally replies to the account's stories, mentions of the account in other people's stories, and DMs containing a keyword. " +
        "Unlike start_autodm (one post, stops after 15 days), a rule never expires: it runs until paused or deleted. Use it when the user wants 'every post', stories or DM keywords; use start_autodm for a single post. " +
        "`triggers`: 'comment' (default), 'story_reply', 'story_mention', 'dm_keyword' (needs `trigger_keywords`, otherwise every DM would be answered). `trigger_keywords` limit comment, story-reply and DM triggers to messages containing them (case and accents ignored); a story mention has no text, so keywords do not apply to it. " +
        "Limits: up to 10 rules per Instagram account; at most 25 DMs per account every 15 minutes and the plan's daily DM allowance (what does not fit is queued and sent later, within Instagram's reply windows); one DM per comment; each person gets at most one DM per rule every `per_user_cooldown_hours` (default 24; story and DM triggers never less than 24). Replies inside a thread, the account's own comments and live-video comments are not answered. A post with its own active start_autodm monitor is handled by that monitor, not by the rule. " +
        "Works only through Instagram webhooks (no polling): creating a rule subscribes the account to them, and if Instagram refuses, no rule is created and the call returns 502 `webhook_subscription_failed` (the user must reconnect Instagram). Other errors: 409 `duplicate_rule`, `rule_limit_reached` or `rule_creation_in_progress`; 503 `account_rules_disabled`. Instagram only.",
      inputSchema: {
        profile_username: z.string().describe("Upload-Post profile name that owns the connected Instagram account."),
        reply_message: z
          .string()
          .min(1)
          .max(1000)
          .describe("DM text sent to whoever triggers the rule. Up to 1000 characters, or 640 when `buttons` are set."),
        triggers: z
          .array(z.enum(["comment", "story_reply", "story_mention", "dm_keyword"]))
          .min(1)
          .optional()
          .describe("What starts a DM. Default ['comment']. 'dm_keyword' requires trigger_keywords."),
        trigger_keywords: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe("Keyword or keywords (up to 20). When set, only comments, story replies and DMs containing one of them are answered."),
        buttons: z
          .array(z.object({ title: z.string(), url: z.string().url() }))
          .max(3)
          .optional()
          .describe("Up to 3 web_url buttons ({ title, url }) added to each DM."),
        per_user_cooldown_hours: z
          .number()
          .int()
          .min(0)
          .max(720)
          .optional()
          .describe("Whole hours before the same person can get this rule's DM again, 0-720. Default 24. Story and DM triggers always wait at least 24."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Create an account-wide Instagram AutoDM rule",
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    safe(async (args) => runAutodmRule(client, "create", args as Record<string, unknown>))
  );

  const list = server.registerTool(
    "list_autodm_rules",
    {
      title: "List account-wide AutoDM rules",
      description:
        "List the account's Instagram AutoDM rules (the account-wide ones from create_autodm_rule; per-post monitors are in list_autodms). Each rule carries `status` (active, paused, reconnect_required, disabled, or stopped with a `stop_reason` such as account_disconnected), its triggers and keywords, `stats` per trigger (replies sent, skipped by cooldown, failed), DMs still `pending` in the queue, and a `webhook` block: `subscribed`, `receiving_events`, `last_event_at`, `error` and a `hint`. If `receiving_events` is false or `error` is set, Instagram is not delivering events and the rule cannot answer: tell the user, usually to reconnect Instagram.",
      inputSchema: {
        profile_username: z.string().optional().describe("Only the rules of this Upload-Post profile."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "List account-wide AutoDM rules",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async (args) => runAutodmRule(client, "list", args as Record<string, unknown>))
  );

  const pause = server.registerTool(
    "pause_autodm_rule",
    {
      title: "Pause an AutoDM rule",
      description: "Pause an account-wide AutoDM rule: it sends no DMs until resume_autodm_rule. Its settings and stats are kept.",
      inputSchema: { rule_id: ruleIdField },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Pause an AutoDM rule",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    safe(async (args) => runAutodmRule(client, "pause", args as Record<string, unknown>))
  );

  const resume = server.registerTool(
    "resume_autodm_rule",
    {
      title: "Resume an AutoDM rule",
      description:
        "Resume a paused account-wide AutoDM rule, so it AUTOMATICALLY sends Instagram DMs as the user again to everyone who triggers it. Re-checks the Instagram webhook subscription: 502 `webhook_subscription_failed` means the user must reconnect Instagram; 409 `rule_stopped` (with `stop_reason`) means the Instagram account is no longer on that profile, so create a new rule instead.",
      inputSchema: { rule_id: ruleIdField },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Resume an AutoDM rule",
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    safe(async (args) => runAutodmRule(client, "resume", args as Record<string, unknown>))
  );

  const remove = server.registerTool(
    "delete_autodm_rule",
    {
      title: "Delete an AutoDM rule",
      description: "Permanently delete an account-wide AutoDM rule with its stats and queued DMs. Cannot be undone; use pause_autodm_rule for a break.",
      inputSchema: { rule_id: ruleIdField },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Delete an AutoDM rule",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
      },
    },
    safe(async (args) => runAutodmRule(client, "delete", args as Record<string, unknown>))
  );

  return [create, list, pause, resume, remove];
}
