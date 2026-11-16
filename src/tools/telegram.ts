import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { genericResultOutputSchema, safe } from "../schemas.js";
import { apiConfirmField, callRoute, mergeArgs, paramsField, type Route } from "./resource.js";

/**
 * The customer's own Telegram bot and the chat it posts to (channel or group):
 * chat details and administration, invite links, forum topics, and the bot's
 * profile and commands. Every call acts on the chat connected to `user`.
 */

const T = "/uploadposts/telegram";

const CHAT_ROUTES: Record<string, Route> = {
  get_info: { method: "GET", path: `${T}/chat-info` },
  update_info: { method: "PATCH", path: `${T}/chat-info` },
  get_boosts: { method: "GET", path: `${T}/boosts` },
  get_member: { method: "GET", path: `${T}/members` },
  moderate_member: { method: "POST", path: `${T}/members` },
  create_invite_link: { method: "POST", path: `${T}/invite-links` },
  edit_invite_link: { method: "PATCH", path: `${T}/invite-links` },
  revoke_invite_link: { method: "DELETE", path: `${T}/invite-links` },
  new_primary_invite_link: { method: "POST", path: `${T}/invite-links/primary` },
  answer_join_request: { method: "POST", path: `${T}/join-requests` },
  list_topic_icons: { method: "GET", path: `${T}/topics/icons` },
  create_topic: { method: "POST", path: `${T}/topics` },
  edit_topic: { method: "PATCH", path: `${T}/topics` },
  delete_topic: { method: "DELETE", path: `${T}/topics` },
  unpin_all: { method: "POST", path: `${T}/unpin-all` },
  leave_chat: { method: "POST", path: `${T}/leave` },
  answer_suggested_post: { method: "POST", path: `${T}/suggested-posts` },
  personal_chat_messages: { method: "GET", path: `${T}/users/{user_id}/personal-chat-messages` },
  profile_audios: { method: "GET", path: `${T}/users/{user_id}/profile-audios` },
};

const BOT_ROUTES: Record<string, Route> = {
  get_profile: { method: "GET", path: `${T}/bot-profile` },
  update_profile: { method: "PATCH", path: `${T}/bot-profile` },
  get_commands: { method: "GET", path: `${T}/bot-commands` },
  set_commands: { method: "POST", path: `${T}/bot-commands` },
  delete_commands: { method: "DELETE", path: `${T}/bot-commands` },
  updates_status: { method: "GET", path: `${T}/updates` },
  set_updates: { method: "POST", path: `${T}/updates` },
  answer_query: { method: "POST", path: `${T}/answer` },
  get_sticker_set: { method: "GET", path: `${T}/sticker-sets` },
  create_sticker_set: { method: "POST", path: `${T}/sticker-sets` },
  edit_sticker_set: { method: "PATCH", path: `${T}/sticker-sets` },
  delete_sticker_set: { method: "DELETE", path: `${T}/sticker-sets` },
  upload_sticker_file: { method: "POST", path: `${T}/sticker-sets/upload` },
  share_theme_backdrops: { method: "GET", path: `${T}/share-theme-backdrops` },
};

/** Telegram Stars, invoices and gifts of the bot: some of these spend the bot's Stars. */
const PAYMENT_ROUTES: Record<string, Route> = {
  stars_balance: { method: "GET", path: `${T}/stars` },
  star_transactions: { method: "GET", path: `${T}/stars/transactions` },
  send_invoice: { method: "POST", path: `${T}/invoices` },
  create_invoice_link: { method: "POST", path: `${T}/invoice-links` },
  refund_star_payment: { method: "POST", path: `${T}/stars/refund` },
  edit_star_subscription: { method: "POST", path: `${T}/stars/subscription` },
  get_payment_settings: { method: "GET", path: `${T}/payments/settings` },
  set_payment_settings: { method: "PUT", path: `${T}/payments/settings` },
  unanswered_payments: { method: "GET", path: `${T}/payments/unanswered` },
  available_gifts: { method: "GET", path: `${T}/gifts` },
  owned_gifts: { method: "GET", path: `${T}/gifts/owned` },
  unique_gift: { method: "GET", path: `${T}/gifts/unique` },
  send_gift: { method: "POST", path: `${T}/gifts` },
  gift_premium: { method: "POST", path: `${T}/gifts/premium` },
};

/** A Telegram Business account connected to the bot (the user's own Telegram account). */
const BUSINESS_ROUTES: Record<string, Route> = {
  connections: { method: "GET", path: `${T}/business-connections` },
  get_profile: { method: "GET", path: `${T}/business-profile` },
  update_profile: { method: "PATCH", path: `${T}/business-profile` },
  post_story: { method: "POST", path: `${T}/business-stories` },
  edit_story: { method: "PATCH", path: `${T}/business-stories` },
  delete_story: { method: "DELETE", path: `${T}/business-stories` },
  repost_story: { method: "POST", path: `${T}/business-stories/repost` },
  gifts: { method: "GET", path: `${T}/business-gifts` },
  manage_gift: { method: "POST", path: `${T}/business-gifts` },
  stars_balance: { method: "GET", path: `${T}/business-stars` },
  transfer_stars: { method: "POST", path: `${T}/business-stars/transfer` },
};

const actionEnum = (routes: Record<string, Route>) =>
  z.enum(Object.keys(routes) as [string, ...string[]]);

const userField = z.string().describe("Upload-Post profile name with Telegram connected.");

export function registerTelegramTools(server: McpServer, client: UploadPostMcpClient): RegisteredTool[] {
  const chat = server.registerTool(
    "manage_telegram_chat",
    {
      title: "Manage the Telegram chat",
      description:
        "Read and administer the Telegram channel or group the profile publishes to, through the profile's own bot (it needs the matching admin rights). Fields go in `params`, with the API's names: " +
        "get_info (include_administrators, return_bots: title, members count, admins); get_boosts (user_id); get_member (user_id; without it, the administrators); " +
        "update_info (title, description, clear_description, photo_url, delete_photo, permissions, sticker_set_name; deleting the photo or changing permissions needs `confirm`); " +
        "moderate_member (action: ban, unban, restrict, promote, demote, set_title, ban_sender_chat, unban_sender_chat, delete_all_reactions; user_id or sender_chat_id, until_date, revoke_messages, permissions, rights, custom_title; ban, restrict, promote, demote and delete_all_reactions need `confirm`); " +
        "create_invite_link / edit_invite_link (invite_link, name, expire_date as Unix time, member_limit, creates_join_request); revoke_invite_link (invite_link) and new_primary_invite_link (the old primary link stops working) need `confirm`; " +
        "answer_join_request (user_id, action approve or decline); forum topics: list_topic_icons, create_topic (name, icon_color, icon_custom_emoji_id), edit_topic (message_thread_id or general: true, action edit, close, reopen, hide, unhide, unpin_all), delete_topic (message_thread_id, needs `confirm`); " +
        "unpin_all (every pinned message, needs `confirm`); leave_chat (the bot leaves: publishing there stops working, needs `confirm`); " +
          "answer_suggested_post (message_id, action approve|decline, send_date, comment: a post suggested in the channel's direct messages chat); personal_chat_messages (user_id, limit: last messages of a user's personal channel); profile_audios (user_id, offset, limit).",
      inputSchema: {
        action: actionEnum(CHAT_ROUTES),
        user: userField,
        params: paramsField("See the description for each action's fields."),
        confirm: apiConfirmField,
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Manage the Telegram chat",
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
      },
    },
    safe(async (args) => {
      const a = args as { action: string };
      return callRoute(client, CHAT_ROUTES[a.action], mergeArgs(args as Record<string, unknown>));
    })
  );

  const bot = server.registerTool(
    "manage_telegram_bot",
    {
      title: "Manage the Telegram bot",
      description:
        "Profile and commands of the profile's own Telegram bot. Fields go in `params`: " +
        "get_profile (language_code); update_profile (name, description, short_description, language_code, photo_url or animation_url, remove_photo with `confirm`, menu_button, default_administrator_rights, for_channels; clear_name / clear_description / clear_short_description); " +
        "get_commands and delete_commands (scope, language_code; delete needs `confirm`); set_commands (commands: [{command, description}], 1-100, plus scope and language_code); " +
          "updates_status (whether the bot sends its updates to Upload-Post, and the webhook health Telegram reports); set_updates (Not generally available yet: until it is switched on it answers 503 telegram_updates_unavailable, the feature is off, not a temporary failure; enabled; replace_existing_webhook to replace another service's webhook, otherwise 409 telegram_webhook_in_use; forward_url, business_chats, auto_answer_callbacks, extra_updates: the updates then arrive as telegram_update webhook events); " +
          "answer_query (type callback|inline|join_request|join_request_web_app|guest|widget|shipping|pre_checkout, query_id and the answer fields: text, show_alert, url, results, ok, error_message…, for a query received as a telegram_update event; 410 telegram_query_expired when Telegram's time is up); " +
          "sticker sets: get_sticker_set (name, or custom_emoji_ids), create_sticker_set (owner_user_id, name ending in _by_<bot username>, title, stickers, sticker_type), edit_sticker_set (action add_sticker|replace_sticker|delete_sticker|set_position|set_emoji_list|set_keywords|set_mask_position|set_title|set_thumbnail|set_custom_emoji_thumbnail, name, sticker…), delete_sticker_set (name, needs `confirm`), upload_sticker_file (owner_user_id, sticker_format static|animated|video, sticker_url: returns a file_id); share_theme_backdrops.",
      inputSchema: {
        action: actionEnum(BOT_ROUTES),
        user: userField,
        params: paramsField("See the description for each action's fields."),
        confirm: apiConfirmField,
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Manage the Telegram bot",
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
      },
    },
    safe(async (args) => {
      const a = args as { action: string };
      return callRoute(client, BOT_ROUTES[a.action], mergeArgs(args as Record<string, unknown>));
    })
  );

  const payments = server.registerTool(
    "manage_telegram_payments",
    {
      title: "Telegram Stars and payments",
      description:
        "Telegram Stars, invoices and gifts of the profile's own bot. Fields go in `params` with the API's names. Reads: stars_balance, star_transactions (offset, limit), get_payment_settings, unanswered_payments (limit: automatic payment answers that failed in the last 30 days), available_gifts, owned_gifts (user_id or chat_id, filters), unique_gift (name). " +
        "send_invoice (title, description, payload, currency XTR for Stars or a provider currency with provider_token, prices [{label, amount}], photo_url, need_* fields, chat_id; it is posted in the chat) and create_invoice_link (same fields; subscription_period 2592000 makes a 30-day Stars subscription) ask other people to pay the bot. " +
        "refund_star_payment (user_id, telegram_payment_charge_id; needs `confirm`, never retried) and edit_star_subscription (user_id, telegram_payment_charge_id, is_canceled; needs `confirm`). " +
        "set_payment_settings: automatic pre-checkout answers (pre_checkout off|approve|reject, max_total_amount, allowed_payload_prefixes, error_message, shipping off|static, shipping_options, shipping_countries); they need the bot's updates on (manage_telegram_bot set_updates). " +
        "send_gift (user_id or chat_id, gift_id, max_star_count, text, idempotency_key; needs `confirm`) and gift_premium (user_id, month_count 3|6|12, star_count 1000|1500|2500, idempotency_key; needs `confirm`) SPEND the bot's Stars. Not generally available yet: send_gift and gift_premium answer 503 telegram_stars_spend_disabled until spending Stars is switched on (the feature is off, not a temporary failure).",
      inputSchema: {
        action: actionEnum(PAYMENT_ROUTES),
        user: userField,
        params: paramsField("See the description for each action's fields."),
        confirm: apiConfirmField,
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Telegram Stars and payments",
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
      },
    },
    safe(async (args) => {
      const a = args as { action: string };
      return callRoute(client, PAYMENT_ROUTES[a.action], mergeArgs(args as Record<string, unknown>));
    })
  );

  const business = server.registerTool(
    "manage_telegram_business",
    {
      title: "Manage the Telegram Business account",
      description:
        "Not generally available yet: until Telegram Business is switched on, every action answers 503 telegram_business_unavailable (the feature is off, not a temporary failure). " +
          "A Telegram Business account (the user's own Telegram account) connected to the profile's bot. Fields go in `params` with the API's names; business_connection_id picks the connection when the bot has several. " +
        "connections (rights and whether each is enabled); get_profile; update_profile (first_name, last_name, username, bio, media_url for the photo with is_public, remove_photo, gift_settings); " +
        "stories posted as the account: post_story (media_url: photo 1080x1920 up to 10 MB or video 720x1280 up to 30 MB and 60 s; active_period, caption, areas, post_to_chat_page, protect_content), edit_story (story_id and the fields), delete_story (story_id), repost_story (from_chat_id, from_story_id, active_period); " +
        "gifts (the account's gifts), manage_gift (action convert|upgrade|transfer|delete, owned_gift_id, idempotency_key; irreversible, needs `confirm`); stars_balance, transfer_stars (star_count 1-10000 to the bot, idempotency_key; needs `confirm`).",
      inputSchema: {
        action: actionEnum(BUSINESS_ROUTES),
        user: userField,
        params: paramsField("See the description for each action's fields."),
        confirm: apiConfirmField,
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Manage the Telegram Business account",
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
      },
    },
    safe(async (args) => {
      const a = args as { action: string };
      return callRoute(client, BUSINESS_ROUTES[a.action], mergeArgs(args as Record<string, unknown>));
    })
  );

  return [chat, bot, payments, business];
}
