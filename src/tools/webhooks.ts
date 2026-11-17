import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { genericResultOutputSchema, safe } from "../schemas.js";

/**
 * Outgoing webhook deliveries: the 7-day log of every event Upload-Post sent
 * (or tried to send) to the account's and profiles' webhook URLs, and manual
 * redelivery of one of them.
 */

const deliveryIdField = z
  .string()
  .min(1)
  .describe("`delivery_id` from list_webhook_deliveries (the same value the receiver got in the X-Upload-Post-Delivery header).");

export function registerWebhookTools(
  server: McpServer,
  client: UploadPostMcpClient
): RegisteredTool[] {
  const list = server.registerTool(
    "list_webhook_deliveries",
    {
      title: "List webhook deliveries",
      description:
        "History of the webhook events Upload-Post sent to the user's own webhook URLs over the last 7 days, newest first: account and profile webhooks, every event (upload_completed, social_account_connected / _disconnected / _reauth_required, dm_received, comment_received). " +
        "Use it to find out whether an event reached the user's server: each delivery has `status` (pending = waiting for a retry, delivered, failed, cancelled), `attempt_count` / `max_attempts`, `last_status_code` or `last_error` (timeout, connection_error, HTTP nnn), every attempt in `attempts`, and `next_attempt_at`. " +
        "Failed deliveries (timeout, connection error, 5xx, 408, 429) are retried automatically up to 6 attempts in about 8.5 hours; other 4xx answers are final. Test sends are marked `test: true` and never retried. " +
        "The event body is left out unless `include_payload` is true; get_webhook_delivery returns one delivery with its body. Paginated with `page` (up to 50) and `limit`; the response carries `total` and `has_more`.",
      inputSchema: {
        status: z
          .enum(["pending", "delivered", "failed", "cancelled"])
          .optional()
          .describe("Only deliveries in this state."),
        event: z
          .string()
          .optional()
          .describe("Only this event, e.g. 'upload_completed', 'dm_received', 'comment_received'."),
        request_id: z
          .string()
          .optional()
          .describe("Only deliveries about this upload `request_id`."),
        job_id: z
          .string()
          .optional()
          .describe("Only deliveries about this scheduled/queued `job_id`."),
        profile_username: z
          .string()
          .optional()
          .describe("Only deliveries about this Upload-Post profile."),
        include_payload: z
          .boolean()
          .optional()
          .describe("Include each delivery's exact JSON body in `payload`. Default false."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Deliveries per page, 1-100. Default 20."),
        page: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Page number, 1-50. Default 1. To look further back, narrow the list with status, event or request_id."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "List webhook deliveries",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async (args) =>
      client.request("GET", "/uploadposts/webhooks/deliveries", {
        query: compact(args as Record<string, unknown>),
      })
    )
  );

  const get = server.registerTool(
    "get_webhook_delivery",
    {
      title: "Get a webhook delivery",
      description:
        "One outgoing webhook delivery with all its attempts and the exact JSON body (`payload`) that was signed and sent. 404 when the id is unknown, older than 7 days or belongs to another account.",
      inputSchema: { delivery_id: deliveryIdField },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Get a webhook delivery",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async (args) => {
      const { delivery_id } = args as { delivery_id: string };
      return client.request("GET", `/uploadposts/webhooks/deliveries/${encodeURIComponent(delivery_id)}`);
    })
  );

  const redeliver = server.registerTool(
    "redeliver_webhook",
    {
      title: "Redeliver a webhook",
      description:
        "Send a past webhook delivery again, now, with the same body, to the webhook URL configured TODAY for that account or profile. It goes out as a new delivery with its own `delivery_id` (its `redelivery_of` and the X-Upload-Post-Redelivery-Of header name the original), and is retried like any other if it fails. The receiver gets the event a second time, so only redeliver events it missed. " +
        "409 when there is nowhere to send it (`reason`: webhook_removed, event_unsubscribed, blocked_url); 404 when the delivery is unknown or older than 7 days.",
      inputSchema: { delivery_id: deliveryIdField },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Redeliver a webhook",
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    safe(async (args) => {
      const { delivery_id } = args as { delivery_id: string };
      return client.request(
        "POST",
        `/uploadposts/webhooks/deliveries/${encodeURIComponent(delivery_id)}/redeliver`
      );
    })
  );

  return [list, get, redeliver];
}
