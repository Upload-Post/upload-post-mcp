import { z } from "zod";
import FormData from "form-data";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { genericResultOutputSchema, safe } from "../schemas.js";
import { apiConfirmField, callRoute, mergeArgs, paramsField, type Route } from "./resource.js";

/**
 * Network reads and actions beyond publishing, switched on in the API on
 * 2026-11-25: Facebook Page reviews, tags, Insights and video captions; the
 * Pinterest API v5 gateway; Instagram stories and tagged posts; Threads ghost
 * posts; X mentions, reads and lists. Not in ChatGPT's reviewed surface
 * (server.ts lists them in notYetReviewedForChatGpt).
 */

const actionEnum = (routes: Record<string, Route>) => z.enum(Object.keys(routes) as [string, ...string[]]);

// ---- Facebook Pages -------------------------------------------------------------

const FB = "/uploadposts/facebook";
const FACEBOOK_READS: Record<string, Route> = {
  ratings: { method: "GET", path: `${FB}/ratings` },
  tagged: { method: "GET", path: `${FB}/tagged` },
  visitor_posts: { method: "GET", path: `${FB}/visitor-posts` },
  insights: { method: "GET", path: `${FB}/insights` },
  video_captions: { method: "GET", path: `${FB}/videos/{video_id}/captions` },
};

// ---- Pinterest API v5 gateway -----------------------------------------------------

/**
 * The Pinterest operations this server offers: the ones every Pinterest connection
 * can run (boards:read/write, pins:read/write, user_accounts:read). Catalogs,
 * Pinterest's beta endpoints, search, terms, product tags, follows and website
 * writes are left out.
 */
const PINTEREST_READ_PATHS = [
  /^boards$/,
  /^boards\/[^/]+$/,
  /^boards\/[^/]+\/pins$/,
  /^boards\/[^/]+\/sections$/,
  /^boards\/[^/]+\/sections\/[^/]+\/pins$/,
  /^pins$/,
  /^pins\/(?!analytics$)[^/]+$/,
  /^pins\/[^/]+\/analytics$/,
  /^media(\/[^/]+)?$/,
  /^user_account$/,
  /^user_account\/analytics(\/top_pins|\/top_video_pins)?$/,
  /^user_account\/(businesses|followers|following|following\/boards|websites|websites\/verification)$/,
  /^users\/[^/]+\/interests\/follow$/,
  /^trends\/keywords\/[^/]+\/top\/[^/]+$/,
  /^trends\/(topics\/featured|editorial_articles|product_categories\/trending|product_categories\/details)$/,
];
const PINTEREST_WRITE_PATHS: Record<string, RegExp[]> = {
  POST: [/^boards$/, /^boards\/[^/]+\/sections$/],
  PATCH: [/^boards\/[^/]+$/, /^boards\/[^/]+\/sections\/[^/]+$/],
  DELETE: [/^boards\/[^/]+$/, /^boards\/[^/]+\/sections\/[^/]+$/],
};

function pinterestEndpoint(raw: string): string {
  return String(raw ?? "").trim().replace(/^\/+/, "").replace(/^v5\//, "").split("?")[0].replace(/\/+$/, "");
}

const PINTEREST_OFFERED =
  "Reads: boards, boards/{board_id}, boards/{board_id}/pins, boards/{board_id}/sections, boards/{board_id}/sections/{section_id}/pins, pins, pins/{pin_id}, pins/{pin_id}/analytics, media, media/{media_id}, user_account, user_account/analytics, user_account/analytics/top_pins, user_account/analytics/top_video_pins, user_account/businesses, user_account/followers, user_account/following, user_account/following/boards, user_account/websites, user_account/websites/verification, users/{username}/interests/follow, trends/keywords/{region}/top/{trend_type}, trends/topics/featured, trends/editorial_articles, trends/product_categories/trending, trends/product_categories/details. " +
  "Writes: POST boards (create a board), POST boards/{board_id}/sections, PATCH boards/{board_id}, PATCH boards/{board_id}/sections/{section_id}, DELETE boards/{board_id}, DELETE boards/{board_id}/sections/{section_id}.";

// ---- Instagram, Threads ----------------------------------------------------------

const INSTAGRAM_READS: Record<string, Route> = {
  stories: { method: "GET", path: "/uploadposts/instagram/stories" },
  tagged: { method: "GET", path: "/uploadposts/instagram/tagged" },
};

// ---- X -------------------------------------------------------------------------------

const X_READ_KINDS = [
  "search_recent",
  "counts_recent",
  "liking_users",
  "reposted_by",
  "quote_posts",
  "reposts_of_me",
  "bookmarks",
  "followers",
  "following",
  "owned_lists",
  "followed_lists",
  "pinned_lists",
  "list",
  "list_posts",
  "list_members",
  "list_followers",
  "trends",
  "trend_locations",
  "personalized_trends",
  "post_analytics",
  "media_analytics",
] as const;

const X_PAID =
  "X bills every post, user or list it returns, so mentions and reads need a paid Upload-Post plan (403 x_read_plan_required on the Free plan) and count toward a daily X spend limit of the account (429 x_daily_read_budget); each answer carries `billing` with what X charges. Answers are cached for a few minutes (`cached: true` costs nothing). ";

export function registerNetworkExtraTools(server: McpServer, client: UploadPostMcpClient): RegisteredTool[] {
  const facebookRead = server.registerTool(
    "facebook_page_read",
    {
      title: "Read a Facebook Page: reviews, tags, Insights, captions",
      description:
        "Live reads of the Facebook Page connected to a profile. The Page is `page_id`, else the Page pinned to the profile, the account's default Page or its only Page (400 facebook_page_required when it cannot tell). " +
        "ratings: reviews and recommendations (created_time, recommendation_type, review_text, rating, reviewer) plus `summary` {overall_star_rating, rating_count} on the first page; read only. " +
        "tagged: posts in which others tagged the Page. visitor_posts (include_hidden): posts visitors left on the Page; Pages of Meta's New Pages Experience (most Pages today) have none and answer 410 facebook_feature_unavailable. " +
        "Lists page with limit (1-100, default 25) and `after` = the previous `next_cursor` while has_more. " +
        "insights: Meta's Insights on demand, metric (required, comma-separated current Meta metric names; an unknown one answers 400 invalid_metric with allowed_metrics), object_id (a post PAGEID_POSTID or a video of the Page; without it the Page), period (day, week, days_28, month, lifetime, total_over_range), since / until (Unix or YYYY-MM-DD), breakdown. " +
        "video_captions (video_id): the caption tracks of a video of the Page; change them with manage_facebook_video_captions. Reads are cached briefly (`cached: true`).",
      inputSchema: {
        action: actionEnum(FACEBOOK_READS),
        user: z.string().describe("Upload-Post profile name with Facebook connected."),
        page_id: z.string().optional().describe("The Facebook Page id, when the profile manages several."),
        video_id: z.string().optional().describe("video_captions: id of a video of the Page."),
        params: paramsField("limit, after, include_hidden, metric, object_id, period, since, until, breakdown."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: { title: "Read a Facebook Page", readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    },
    safe(async (args) => {
      const a = args as { action: string };
      return callRoute(client, FACEBOOK_READS[a.action], mergeArgs(args as Record<string, unknown>));
    })
  );

  const facebookCaptions = server.registerTool(
    "manage_facebook_video_captions",
    {
      title: "Manage the captions of a Facebook Page video",
      description:
        "Add, choose or delete the caption tracks of a video of the profile's Facebook Page. Send `srt` (the SubRip text, UTF-8, up to 200 KB) with `locale` (e.g. en_US) to add a track (Facebook refuses a locale the video already has: delete it first), `default_locale` (a locale or 'none') to pick the one shown by default, and/or `delete_locales` with confirm: true to remove tracks. The video must belong to the Page (403 facebook_video_not_owned). Read the tracks with facebook_page_read video_captions.",
      inputSchema: {
        user: z.string().describe("Upload-Post profile name with Facebook connected."),
        video_id: z.string().describe("Id of a video of the Page."),
        page_id: z.string().optional().describe("The Facebook Page id, when the profile manages several."),
        srt: z.string().max(200_000).optional().describe("Caption track to add, as SubRip (.srt) text. Needs `locale`."),
        locale: z.string().optional().describe("Locale of `srt`, e.g. en_US or es_ES."),
        default_locale: z.string().optional().describe("Locale shown by default, or 'none'."),
        delete_locales: z.array(z.string()).optional().describe("Locales to delete. Needs confirm: true."),
        confirm: apiConfirmField,
      },
      outputSchema: genericResultOutputSchema,
      annotations: { title: "Manage Facebook video captions", readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    },
    safe(async (args) => {
      const a = args as {
        user: string;
        video_id: string;
        page_id?: string;
        srt?: string;
        locale?: string;
        default_locale?: string;
        delete_locales?: string[];
        confirm?: boolean;
      };
      if (a.srt && !a.locale) throw new Error("`locale` is required with `srt`.");
      if (!a.srt && !a.default_locale && !a.delete_locales?.length) {
        throw new Error("Send `srt` + `locale`, `default_locale` or `delete_locales`.");
      }
      // The API reads this route as a form (multipart), like the file upload it takes.
      const form = new FormData();
      form.append("user", a.user);
      if (a.page_id) form.append("page_id", a.page_id);
      if (a.srt) {
        form.append("locale", a.locale as string);
        form.append("captions_file", Buffer.from(a.srt, "utf8"), { filename: "captions.srt", contentType: "application/x-subrip" });
      }
      if (a.default_locale) form.append("default_locale", a.default_locale);
      if (a.delete_locales?.length) form.append("delete_locales", JSON.stringify(a.delete_locales));
      if (a.confirm !== undefined) form.append("confirm", String(a.confirm));
      return client.request("POST", `${FB}/videos/${encodeURIComponent(a.video_id)}/captions`, { body: form });
    })
  );

  const pinterestRead = server.registerTool(
    "pinterest_api_read",
    {
      title: "Read the Pinterest API v5",
      description:
        "Pinterest's own API v5 read with the profile's Pinterest connection: `endpoint` is the path of Pinterest's reference without the leading slash (e.g. user_account/analytics, boards/{board_id}/pins, trends/keywords/US/top/growing) and `query` its own query parameters (checked against Pinterest's description: an unknown one answers 400 invalid_parameter). The answer is Pinterest's, in `data`. " +
        PINTEREST_OFFERED +
        " Reads are cached (analytics and trends 1 h, the rest 60 s; refresh: true skips it) and count toward a daily limit (429 pinterest_daily_limit_reached). 403 pinterest_reconnect_required: reconnect Pinterest. To publish, save or delete Pins use the upload tools, save_post and unpublish_post.",
      inputSchema: {
        user: z.string().describe("Upload-Post profile name with Pinterest connected."),
        endpoint: z.string().describe("Pinterest API v5 path without the leading slash, e.g. 'user_account/analytics'."),
        query: z.record(z.unknown()).optional().describe("Pinterest's query parameters, e.g. { start_date: '2026-11-01', end_date: '2026-11-24', metric_types: 'IMPRESSION,SAVE' }."),
        refresh: z.boolean().optional().describe("true: skip Upload-Post's cache."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: { title: "Read the Pinterest API v5", readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    },
    safe(async (args) => {
      const a = args as { user: string; endpoint: string; query?: Record<string, unknown>; refresh?: boolean };
      const endpoint = pinterestEndpoint(a.endpoint);
      if (!PINTEREST_READ_PATHS.some((re) => re.test(endpoint))) {
        throw new Error(`Pinterest read '${endpoint}' is not offered here. ${PINTEREST_OFFERED}`);
      }
      return client.request("GET", `/uploadposts/pinterest/api/${endpoint}`, {
        query: { ...(a.query ?? {}), user: a.user, ...(a.refresh ? { refresh: true } : {}) },
      });
    })
  );

  const pinterestWrite = server.registerTool(
    "manage_pinterest_api",
    {
      title: "Change Pinterest boards and sections (API v5)",
      description:
        "Pinterest's own API v5 writes with the profile's Pinterest connection: create, update or delete boards and board sections. `method` POST, PATCH or DELETE; `endpoint` the Pinterest path without the leading slash; `body` Pinterest's JSON (e.g. { name, description, privacy } for a board, { name } for a section), checked against Pinterest's description (400 invalid_body). DELETE needs confirm: true and cannot be undone. " +
        "Offered: POST boards, POST boards/{board_id}/sections, PATCH boards/{board_id}, PATCH boards/{board_id}/sections/{section_id}, DELETE boards/{board_id}, DELETE boards/{board_id}/sections/{section_id}. " +
        "A write that got no answer from Pinterest returns 502 pinterest_write_outcome_unknown and is never retried: read before sending it again.",
      inputSchema: {
        user: z.string().describe("Upload-Post profile name with Pinterest connected."),
        method: z.enum(["POST", "PATCH", "DELETE"]),
        endpoint: z.string().describe("Pinterest API v5 path without the leading slash, e.g. 'boards' or 'boards/123/sections'."),
        body: z.record(z.unknown()).optional().describe("Pinterest's JSON body (POST and PATCH)."),
        confirm: apiConfirmField,
      },
      outputSchema: genericResultOutputSchema,
      annotations: { title: "Change Pinterest boards and sections", readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    },
    safe(async (args) => {
      const a = args as { user: string; method: "POST" | "PATCH" | "DELETE"; endpoint: string; body?: Record<string, unknown>; confirm?: boolean };
      const endpoint = pinterestEndpoint(a.endpoint);
      if (!(PINTEREST_WRITE_PATHS[a.method] ?? []).some((re) => re.test(endpoint))) {
        throw new Error(`Pinterest ${a.method} '${endpoint}' is not offered here. See the tool description for the writes it takes.`);
      }
      // The API reads `user` and `confirm` from the query string; the body is Pinterest's own.
      const query: Record<string, unknown> = { user: a.user };
      if (a.method === "DELETE" && a.confirm !== undefined) query.confirm = a.confirm;
      return client.request(a.method, `/uploadposts/pinterest/api/${endpoint}`, {
        query,
        ...(a.method === "DELETE" ? {} : { body: a.body ?? {} }),
      });
    })
  );

  const instagramRead = server.registerTool(
    "instagram_account_read",
    {
      title: "Instagram stories and tagged posts",
      description:
        "Two reads of the Instagram account connected to a profile. stories: its stories of the last 24 hours (id, media_type, media_product_type, media_url, thumbnail_url, permalink, timestamp, caption; cached 2 minutes). tagged: public posts where other accounts tagged it (id, caption, media_type, media_url, permalink, timestamp, username, like_count, comments_count; limit 1-50, `after` = the previous next_cursor; cached 5 minutes). For the account's own posts use get_media.",
      inputSchema: {
        action: actionEnum(INSTAGRAM_READS),
        user: z.string().describe("Upload-Post profile name with Instagram connected. Sent as `profile`."),
        limit: z.number().int().min(1).max(50).optional().describe("tagged: posts per page (default 25)."),
        after: z.string().optional().describe("tagged: next_cursor of the previous page."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: { title: "Instagram stories and tagged posts", readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    },
    safe(async (args) => {
      const { action, user, ...rest } = args as { action: string; user: string } & Record<string, unknown>;
      return callRoute(client, INSTAGRAM_READS[action], { profile: user, ...rest });
    })
  );

  const threadsGhost = server.registerTool(
    "get_threads_ghost_posts",
    {
      title: "List Threads ghost posts",
      description:
        "The ghost posts of the Threads account connected to a profile (text posts Threads archives 24 hours after publishing), with ghost_post_status (ACTIVE or ARCHIVED) and ghost_post_expiration_timestamp besides id, text, permalink and timestamp. Pages with limit (1-100) and after / before (the next_cursor / previous_cursor of a previous answer); since / until filter by date (Unix or YYYY-MM-DD).",
      inputSchema: {
        user: z.string().describe("Upload-Post profile name with Threads connected."),
        limit: z.number().int().min(1).max(100).optional(),
        after: z.string().optional(),
        before: z.string().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
      },
      outputSchema: genericResultOutputSchema,
      annotations: { title: "List Threads ghost posts", readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    },
    safe(async (args) => callRoute(client, { method: "GET", path: "/uploadposts/threads/ghost-posts" }, args as Record<string, unknown>))
  );

  const xRead = server.registerTool(
    "x_read",
    {
      title: "Read X: mentions, search, followers, lists, trends, analytics",
      description:
        X_PAID +
        "mentions: posts that @mention the account (not only replies), newest first, each with the author's verified, verified_type (blue, business, government, none) and followers_count; filters verified_only, verified_type (comma-separated), min_followers and replies (include, exclude, only) apply to the `limit` (5-100) mentions scanned, so a page can hold fewer; page with cursor = pagination.next_cursor. " +
        "Every other action is one X read (`data`, `includes`, `meta` are X's): search_recent (query, last 7 days; start_time, end_time, since_id, until_id, sort_order), counts_recent (query, granularity minute|hour|day), liking_users / reposted_by / quote_posts (post_id; quote_posts takes exclude), bookmarks, followers, following, owned_lists, followed_lists, pinned_lists, list / list_posts / list_members / list_followers (list_id), trends (woeid, limit 1-50), trend_locations, personalized_trends, post_analytics (ids, up to 100; start_time, end_time, granularity hourly|daily|weekly|total), media_analytics (media_keys). Page with cursor = pagination.next_cursor. " +
        "liking_users, reposts_of_me (reposts of the account's posts), bookmarks, followers/following and the lists need X permissions Upload-Post asks since 2026-11-25: an X account connected before that answers 403 x_reconnect_required (with `scope`) until the user reconnects X once; mentions, search_recent, counts_recent, reposted_by, quote_posts, trends and the analytics work with the existing connection.",
      inputSchema: {
        action: z.enum(["mentions", ...X_READ_KINDS]),
        user: z.string().describe("Upload-Post profile name with X connected."),
        params: paramsField("query, post_id, list_id, woeid, ids, media_keys, limit, cursor, start_time, end_time, granularity, verified_only, verified_type, min_followers, replies..."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: { title: "Read X", readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    },
    safe(async (args) => {
      const a = args as { action: string };
      const fields = mergeArgs(args as Record<string, unknown>);
      if (a.action === "mentions") return callRoute(client, { method: "GET", path: "/uploadposts/x/mentions" }, fields);
      return callRoute(client, { method: "GET", path: "/uploadposts/x/read/{kind}" }, { ...fields, kind: a.action });
    })
  );

  const xLists = server.registerTool(
    "manage_x_lists",
    {
      title: "Manage X lists",
      description:
        "Create, update and delete the X account's lists and their members (needs X connected or reconnected on or after 2026-11-25). create (name 1-25 characters, description up to 100, private), update (list_id, name, description, private), delete (list_id, confirm: true; cannot be undone), add_member / remove_member (list_id, user_id = numeric X user id). Read lists with x_read owned_lists and list_members. Needs the X list.write permission (403 x_reconnect_required for accounts connected before it: reconnect X). Each call counts toward the daily X write limit shared with replies, edits, reposts and likes (429 x_daily_write_limit); 502 x_write_outcome_unknown means X did not answer: check before retrying.",
      inputSchema: {
        action: z.enum(["create", "update", "delete", "add_member", "remove_member"]),
        user: z.string().describe("Upload-Post profile name with X connected."),
        list_id: z.string().optional().describe("Every action but create."),
        name: z.string().max(25).optional(),
        description: z.string().max(100).optional(),
        private: z.boolean().optional(),
        user_id: z.string().optional().describe("add_member / remove_member: numeric X user id."),
        confirm: apiConfirmField,
      },
      outputSchema: genericResultOutputSchema,
      annotations: { title: "Manage X lists", readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    },
    safe(async (args) => callRoute(client, { method: "POST", path: "/uploadposts/x/lists" }, args as Record<string, unknown>))
  );

  const instagramMessaging = server.registerTool(
    "manage_instagram_messaging_profile",
    {
      title: "Instagram ice breakers and persistent menu",
      description:
        "The ice breakers (questions offered when someone opens a chat with the Instagram account for the first time) and the persistent menu of its inbox. Only accounts connected with Instagram Login; one connected through a Facebook Page answers 400 instagram_connection_unsupported. " +
        "get (fields: ice_breakers and/or persistent_menu, default both). set: each field sent replaces what Instagram had for it, the other stays; ice_breakers = up to 4 { question, payload } (the default locale) or [{ locale, call_to_actions: [{ question, payload }] }] with a `default` entry; persistent_menu = [{ locale (default 'default'), call_to_actions: [{ type: 'postback', title, payload } | { type: 'web_url', title, url }] }] with one `default` entry (Meta recommends at most 5 items). delete (fields, confirm: true). Tapping an ice breaker or a postback item arrives as a dm_received webhook with its payload.",
      inputSchema: {
        action: z.enum(["get", "set", "delete"]),
        user: z.string().describe("Upload-Post profile name with Instagram connected."),
        fields: z.array(z.enum(["ice_breakers", "persistent_menu"])).optional().describe("get / delete: which ones."),
        ice_breakers: z.array(z.record(z.unknown())).optional().describe("set: see the description."),
        persistent_menu: z.array(z.record(z.unknown())).optional().describe("set: see the description."),
        confirm: apiConfirmField,
      },
      outputSchema: genericResultOutputSchema,
      annotations: { title: "Instagram ice breakers and persistent menu", readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    },
    safe(async (args) => {
      const { action, ...rest } = args as { action: string; fields?: string[] } & Record<string, unknown>;
      const path = "/uploadposts/dms/instagram/profile";
      if (action === "get") return callRoute(client, { method: "GET", path }, rest);
      if (action === "delete") {
        if (!rest.fields || !(rest.fields as string[]).length) throw new Error("`fields` is required to delete.");
        return client.request("DELETE", path, { body: rest });
      }
      if (rest.ice_breakers === undefined && rest.persistent_menu === undefined) throw new Error("Send ice_breakers and/or persistent_menu.");
      return client.request("POST", path, { body: rest });
    })
  );

  return [facebookRead, facebookCaptions, pinterestRead, pinterestWrite, instagramRead, threadsGhost, xRead, xLists, instagramMessaging];
}
