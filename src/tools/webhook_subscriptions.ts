import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { genericResultOutputSchema, safe } from "../schemas.js";

/**
 * Where Upload-Post sends the account's events: extra webhook destinations
 * (subscriptions: n8n triggers, REST hooks…) and the account / per-profile
 * webhook settings. The account's signing secret is never handed to the model.
 *
 * Raw HTTP for now: upload-post 2.21.0 has the notification and profile
 * webhook methods (getNotificationConfig, updateNotificationConfig,
 * testNotifications, deleteNotificationWebhook, get/set/deleteProfileWebhook)
 * but not the subscriptions; all of them can move to the SDK once it ships
 * the subscription methods.
 */

const S = "/uploadposts/webhooks/subscriptions";

/** Events a subscription can carry today; the API also takes a few more while their features are on. */
export const SUBSCRIPTION_EVENTS = [
  "upload_completed",
  "social_account_connected",
  "social_account_disconnected",
  "social_account_reauth_required",
  "dm_received",
  "comment_received",
  "telegram_update",
  "review_received",
  "review_updated",
  "customer_media_received",
  "listing_google_update",
  "listing_duplicate",
  "listing_control_changed",
  "post_analytics_updated",
] as const;

const DISABLED_NOTE =
  "Not generally available yet: until webhook subscriptions are switched on for the account, every call answers 503 with reason webhook_subscriptions_disabled (the feature is off, not a temporary failure).";

const subscriptionIdField = z
  .string()
  .min(1)
  .describe("Subscription id (`whsub_...`) from list_webhook_subscriptions or create_webhook_subscription.");

/**
 * The account's webhook signing secret (and a Slack webhook URL, which embeds
 * its own token) are credentials: say whether they are set, never what they are.
 */
export function redactSecrets(node: unknown, depth = 0): unknown {
  if (depth > 6 || node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((v) => redactSecrets(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === "webhook_secret" || k === "slack_webhook_url") {
      out[`${k}_set`] = typeof v === "string" ? v.length > 0 : Boolean(v);
      continue;
    }
    out[k] = redactSecrets(v, depth + 1);
  }
  return out;
}

export function registerWebhookSubscriptionTools(
  server: McpServer,
  client: UploadPostMcpClient
): RegisteredTool[] {
  const list = server.registerTool(
    "list_webhook_subscriptions",
    {
      title: "List webhook subscriptions",
      description:
        "The account's webhook subscriptions: extra destinations (an n8n trigger, a REST hook…) that receive the listed events besides the account webhook, newest first, active and disabled, with `limit` (at most 10 active) and `active_count`. " +
        "Each one has id, url, events, profile_username (null = every profile), source, name, status active|disabled, disabled_reason (endpoint_gone, failing_too_long, blocked_url, profile_removed), last_delivery_at and health (consecutive_failures, last_failure). " +
        "With `subscription_id` it returns just that one. To see what was sent to a subscription use list_webhook_deliveries. " +
        DISABLED_NOTE,
      inputSchema: {
        subscription_id: subscriptionIdField.optional(),
        status: z.enum(["active", "disabled"]).optional().describe("Only active or only disabled subscriptions."),
        source: z.string().optional().describe("Only subscriptions with this source label, e.g. 'n8n'."),
        url: z.string().optional().describe("Only subscriptions to exactly this URL."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "List webhook subscriptions",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async (args) => {
      const { subscription_id, ...filters } = args as { subscription_id?: string } & Record<string, unknown>;
      if (subscription_id) return client.request("GET", `${S}/${encodeURIComponent(subscription_id)}`);
      return client.request("GET", S, { query: compact(filters) });
    })
  );

  const create = server.registerTool(
    "create_webhook_subscription",
    {
      title: "Create a webhook subscription",
      description:
        "Add a destination that receives the listed events (besides the account webhook), signed like the account webhook (X-Upload-Post-Signature with the account's webhook secret, plus X-Upload-Post-Subscription: <id>). " +
        "Idempotent: the same url + events + profile_username returns the existing subscription (`created: false`) and reactivates it if it was disabled (`reactivated: true`); name and source are updated when sent. " +
        "The first delivery can take about a minute; failed deliveries are retried and show up in list_webhook_deliveries. At most 10 active subscriptions per account (409 subscription_limit_reached). Team members cannot create them (403 team_member_forbidden). " +
        "Events: " + SUBSCRIPTION_EVENTS.join(", ") + "; also youtube_video_published / youtube_video_updated and the post approval events (post_approval_requested, post_approved, post_rejected, post_approval_expired) while those features are on. " +
        DISABLED_NOTE,
      inputSchema: {
        url: z.string().url().max(2048).describe("Public https URL that will receive the events."),
        events: z
          .array(z.string().min(1))
          .min(1)
          .describe("Event names, e.g. ['upload_completed', 'comment_received']."),
        profile_username: z.string().optional().describe("Only events of this Upload-Post profile. Without it: every profile of the account."),
        source: z
          .string()
          .max(40)
          .regex(/^[a-z0-9_.-]+$/)
          .optional()
          .describe("Label of the integration creating it (a-z, 0-9, _ . -), e.g. 'n8n'."),
        name: z.string().max(100).optional().describe("Free label shown in the dashboard."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Create a webhook subscription",
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    safe(async (args) => client.request("POST", S, { body: compact(args as Record<string, unknown>) }))
  );

  const remove = server.registerTool(
    "delete_webhook_subscription",
    {
      title: "Delete a webhook subscription",
      description:
        "Delete a webhook subscription: Upload-Post stops sending to it right away. The account webhook and other subscriptions are not touched. A second delete answers 404 not_found. " +
        DISABLED_NOTE,
      inputSchema: { subscription_id: subscriptionIdField },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Delete a webhook subscription",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    safe(async (args) => {
      const { subscription_id } = args as { subscription_id: string };
      return client.request("DELETE", `${S}/${encodeURIComponent(subscription_id)}`);
    })
  );

  const test = server.registerTool(
    "test_webhook_subscription",
    {
      title: "Test a webhook subscription",
      description:
        "Send one signed sample event to a subscription now, with the keys of the real event and `test: true`. `ok` is true when the destination answered with a status below 400 (a redirect counts as delivered). Logged as a test delivery: never retried and never counted towards disabling the subscription. " +
        "409 subscription_disabled or blocked_url; 400 invalid_event when `event` is not one of the subscription's events. " +
        DISABLED_NOTE,
      inputSchema: {
        subscription_id: subscriptionIdField,
        event: z.string().optional().describe("Which of the subscription's events to sample. Default: its first event."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Test a webhook subscription",
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    safe(async (args) => {
      const { subscription_id, event } = args as { subscription_id: string; event?: string };
      return client.request("POST", `${S}/${encodeURIComponent(subscription_id)}/test`, {
        body: event ? { event } : {},
      });
    })
  );

  const settings = server.registerTool(
    "manage_webhook_settings",
    {
      title: "Manage webhook settings",
      description:
        "The account webhook (one URL that gets the account's events) and per-profile webhooks (a profile sending its events to its own URL instead). The signing secret is never returned: responses only say `webhook_secret_set`, and the user sees or rotates it in the dashboard. " +
        "get_account: current notification settings (channels {webhook, telegram}, webhook_url, webhook_events, telegram_chat_id). " +
        "set_account: change only the fields sent (webhook_url, webhook_events, channels, telegram_chat_id); the first URL saved creates the signing secret. " +
        "remove_account: clears webhook_url, webhook_events and the secret and turns the webhook channel off (webhook subscriptions keep working). " +
        "test_account: sends a sample upload_completed through the configured channels (params: platform, media_type, title, caption, profile_username), logged as a test delivery. " +
        "get_profile / set_profile (webhook_url; webhook_events {event: true|false}, omitted = every event, null = back to every event) / remove_profile (its events go back to the account webhook): need `profile_username`. " +
        "webhook_events names: upload_completed, social_account_connected, social_account_disconnected, social_account_reauth_required, dm_received, comment_received and the others listed in create_webhook_subscription. " +
        "Team members cannot change where the owner's events go (403).",
      inputSchema: {
        action: z.enum([
          "get_account",
          "set_account",
          "remove_account",
          "test_account",
          "get_profile",
          "set_profile",
          "remove_profile",
        ]),
        profile_username: z.string().optional().describe("get_profile / set_profile / remove_profile: the Upload-Post profile."),
        webhook_url: z.string().url().optional().describe("set_account / set_profile: public https URL that receives the events."),
        webhook_events: z
          .union([z.array(z.string()), z.record(z.boolean())])
          .nullable()
          .optional()
          .describe("set_account: list of event names (omitted = every event). set_profile: {event: true|false}, or null to go back to every event."),
        params: z
          .record(z.unknown())
          .optional()
          .describe("Other fields with the API's names: set_account channels {webhook: bool, telegram: bool} and telegram_chat_id; test_account platform, media_type, title, caption, profile_username."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Manage webhook settings",
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
      },
    },
    safe(async (args) => {
      const { action, params, ...named } = args as {
        action: string;
        params?: Record<string, unknown>;
        profile_username?: string;
        webhook_url?: string;
        webhook_events?: unknown;
      };
      const fields: Record<string, unknown> = { ...(params ?? {}) };
      for (const [k, v] of Object.entries(named)) if (v !== undefined) fields[k] = v;
      const needProfile = (): string => {
        if (!fields.profile_username) throw new Error("`profile_username` is required for this action.");
        return String(fields.profile_username);
      };
      let result: unknown;
      switch (action) {
        case "get_account":
          result = await client.request("GET", "/uploadposts/users/notifications");
          break;
        case "set_account": {
          const { profile_username: _p, ...body } = fields;
          result = await client.request("POST", "/uploadposts/users/notifications", { body });
          break;
        }
        case "remove_account":
          result = await client.request("DELETE", "/uploadposts/users/notifications");
          break;
        case "test_account":
          result = await client.request("POST", "/uploadposts/users/notifications/test", { body: fields });
          break;
        case "get_profile":
          result = await client.request("GET", "/uploadposts/users/profile-webhook", {
            query: { profile_username: needProfile() },
          });
          break;
        case "set_profile":
          needProfile();
          if (!fields.webhook_url) throw new Error("`webhook_url` is required for set_profile.");
          result = await client.request("POST", "/uploadposts/users/profile-webhook", { body: fields });
          break;
        case "remove_profile":
          result = await client.request("DELETE", "/uploadposts/users/profile-webhook", {
            body: { profile_username: needProfile() },
          });
          break;
        default:
          throw new Error(`Unknown action ${action}.`);
      }
      return redactSecrets(result);
    })
  );

  return [list, create, remove, test, settings];
}
