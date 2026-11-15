import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { genericResultOutputSchema, safe } from "../schemas.js";
import { apiConfirmField, callRoute, mergeArgs, paramsField, type Route } from "./resource.js";

/**
 * Bluesky beyond publishing: reads (profiles, search, threads and feeds,
 * notifications) and the account's own profile, settings and drafts.
 * Posting, DMs and post actions live in their own tools.
 */

const B = "/uploadposts/bluesky";
const xrpc = (nsid: string): Route => ({ method: "GET", path: `${B}/xrpc/${nsid}` });

const READ_ROUTES: Record<string, Route> = {
  profiles: { method: "GET", path: `${B}/profile` },
  search_posts: { method: "GET", path: `${B}/search/posts` },
  search_accounts: { method: "GET", path: `${B}/search/actors` },
  followers: { method: "GET", path: `${B}/followers` },
  follows: { method: "GET", path: `${B}/follows` },
  post_thread: xrpc("app.bsky.feed.getPostThread"),
  author_feed: xrpc("app.bsky.feed.getAuthorFeed"),
  feed: xrpc("app.bsky.feed.getFeed"),
  post_engagement: { method: "GET", path: "/uploadposts/post-engagement", fixed: { platform: "bluesky" } },
  xrpc: { method: "GET", path: `${B}/xrpc/{nsid}` },
  notifications: { method: "GET", path: `${B}/notifications` },
  unread_count: { method: "GET", path: `${B}/notifications/unread-count` },
  notification_preferences: { method: "GET", path: `${B}/notification-preferences` },
  activity_subscriptions: { method: "GET", path: `${B}/activity-subscriptions` },
  labels: { method: "GET", path: `${B}/labels` },
  own_profile: { method: "GET", path: `${B}/profile/self` },
  status: { method: "GET", path: `${B}/status` },
  settings: { method: "GET", path: `${B}/settings` },
  preferences: { method: "GET", path: `${B}/preferences` },
  drafts: { method: "GET", path: `${B}/drafts` },
  chat_status: { method: "GET", path: "/uploadposts/dms/bluesky/status" },
  chat_preferences: { method: "GET", path: "/uploadposts/dms/bluesky/preferences" },
};

const WRITE_ROUTES: Record<string, Route> = {
  update_profile: { method: "POST", path: `${B}/profile/self` },
  set_status: { method: "POST", path: `${B}/status` },
  clear_status: { method: "DELETE", path: `${B}/status` },
  update_settings: { method: "POST", path: `${B}/settings` },
  update_preferences: { method: "PUT", path: `${B}/preferences` },
  mark_notifications_seen: { method: "POST", path: `${B}/notifications/seen` },
  update_notification_preferences: { method: "POST", path: `${B}/notification-preferences` },
  set_activity_subscription: { method: "POST", path: `${B}/activity-subscriptions` },
  create_draft: { method: "POST", path: `${B}/drafts` },
  update_draft: { method: "PATCH", path: `${B}/drafts/{draft_id}` },
  delete_draft: { method: "DELETE", path: `${B}/drafts/{draft_id}` },
  update_chat_preferences: { method: "POST", path: "/uploadposts/dms/bluesky/preferences" },
};

const actionEnum = (routes: Record<string, Route>) =>
  z.enum(Object.keys(routes) as [string, ...string[]]);

export function registerBlueskyTools(server: McpServer, client: UploadPostMcpClient): RegisteredTool[] {
  const read = server.registerTool(
    "bluesky_read",
    {
      title: "Read Bluesky",
      description:
        "Read-only Bluesky lookups. Fields go in `params` with the API's names; lists page with `limit` (1-100) and `cursor`. " +
        "profiles (actor: handles or DIDs, comma-separated, up to 25; without it the connected account); search_posts (q, sort latest|top, since, until, author, mentions, lang, domain, url, tag; needs `user`); search_accounts (q, typeahead); followers / follows (actor, or the connected account with `user`); " +
        "post_thread (uri, depth, parentHeight), author_feed (actor, filter), feed (feed: at:// URI of a feed generator): Bluesky's own answer, with Bluesky's camelCase parameter names; " +
        "post_engagement (post_id, type likes|reposts|quotes): who liked, reposted or quoted a post; xrpc (nsid plus its parameters): other public read methods such as app.bsky.feed.getPosts, app.bsky.feed.getQuotes, app.bsky.graph.getLists, app.bsky.actor.searchActorsTypeahead. " +
        "Of the connected account (need `user`): notifications (reasons: reply, mention, quote, like, repost, follow…), unread_count, notification_preferences, activity_subscriptions, labels (post_ids: up to 25 at:// URIs), own_profile, status, settings, preferences, drafts, chat_status, chat_preferences.",
      inputSchema: {
        action: actionEnum(READ_ROUTES),
        user: z.string().optional().describe("Upload-Post profile name with Bluesky connected. Required for account reads and search_posts; optional for public reads."),
        params: paramsField("See the description for each action's fields."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Read Bluesky",
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    safe(async (args) => {
      const a = args as { action: string };
      return callRoute(client, READ_ROUTES[a.action], mergeArgs(args as Record<string, unknown>));
    })
  );

  const manage = server.registerTool(
    "manage_bluesky_account",
    {
      title: "Manage the Bluesky account",
      description:
        "Change the connected Bluesky account. Fields go in `params` with the API's names; a field left out stays as it is, and `null` or `clear_fields` clears it. " +
        "update_profile (display_name, description, pronouns, website, avatar_url, banner_url, remove_avatar, remove_banner, pinned_post, links [{url, title}], labels); set_status (status live, url, title, description, duration_minutes) and clear_status; " +
        "update_settings (chat_allow_incoming all|following|none, chat_allow_group_invites, allow_subscriptions followers|mutuals|none, hide_from_algorithmic_recommendations); " +
        "update_preferences (preferences: Bluesky preference objects to add or replace; remove / remove_types; replacing a whole list such as muted words or saved feeds, or removing, needs `confirm`); " +
        "mark_notifications_seen (seen_at; needs `confirm`); update_notification_preferences (preferences); set_activity_subscription (subject, post, reply); update_chat_preferences (chat / chat_request: {include all|follows, push}); " +
        "drafts (text only, no media): create_draft (text, or posts [{text, link_url, quote_uri, labels}] for a thread; langs, reply_settings, quote_settings), update_draft (draft_id), delete_draft (draft_id, needs `confirm`).",
      inputSchema: {
        action: actionEnum(WRITE_ROUTES),
        user: z.string().describe("Upload-Post profile name with Bluesky connected."),
        draft_id: z.string().optional().describe("update_draft / delete_draft: the draft id from bluesky_read drafts."),
        params: paramsField("See the description for each action's fields."),
        confirm: apiConfirmField,
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Manage the Bluesky account",
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
      },
    },
    safe(async (args) => {
      const a = args as { action: string };
      return callRoute(client, WRITE_ROUTES[a.action], mergeArgs(args as Record<string, unknown>));
    })
  );

  return [read, manage];
}
