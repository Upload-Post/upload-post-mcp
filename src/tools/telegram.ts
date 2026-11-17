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
};

const BOT_ROUTES: Record<string, Route> = {
  get_profile: { method: "GET", path: `${T}/bot-profile` },
  update_profile: { method: "PATCH", path: `${T}/bot-profile` },
  get_commands: { method: "GET", path: `${T}/bot-commands` },
  set_commands: { method: "POST", path: `${T}/bot-commands` },
  delete_commands: { method: "DELETE", path: `${T}/bot-commands` },
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
        "unpin_all (every pinned message, needs `confirm`); leave_chat (the bot leaves: publishing there stops working, needs `confirm`).",
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
        "get_commands and delete_commands (scope, language_code; delete needs `confirm`); set_commands (commands: [{command, description}], 1-100, plus scope and language_code).",
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

  return [chat, bot];
}
