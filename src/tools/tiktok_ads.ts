import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { genericResultOutputSchema, safe } from "../schemas.js";
import { apiConfirmField, mergeArgs, paramsField, type Route } from "./resource.js";

/**
 * TikTok Ads (TikTok's Marketing API) through the ad account the user
 * connected to Upload-Post: promote a post of the TikTok account linked to it
 * (boost), campaigns, ad groups, ads, reports, targeting and audiences. Spend
 * runs on the user's own TikTok ad account; Upload-Post never charges it.
 *
 * Everything this tool creates is paused unless the user asks for `active`:
 * creates send `status: paused` when none is given, and a boost also pauses
 * its ad group and ad (`pause_all_levels: true`) unless told otherwise.
 *
 * Left out on purpose: Upload-Post generating the Spark authorization code of
 * the profile's own post, which needs a TikTok permission Upload-Post does not
 * have. Raw HTTP: the published SDK has no TikTok Ads methods yet.
 */

const T = "/uploadposts/ads/tiktok";

const READ_ROUTES: Record<string, Route> = {
  accounts: { method: "GET", path: `${T}/accounts` },
  account: { method: "GET", path: `${T}/account` },
  identities: { method: "GET", path: `${T}/identities` },
  spark_posts: { method: "GET", path: `${T}/spark/posts` },
  campaigns: { method: "GET", path: `${T}/campaigns` },
  adgroups: { method: "GET", path: `${T}/adgroups` },
  ads: { method: "GET", path: `${T}/ads` },
  insights: { method: "GET", path: `${T}/insights` },
  campaign_insights: { method: "GET", path: `${T}/campaigns/{campaign_id}/insights` },
  adgroup_insights: { method: "GET", path: `${T}/adgroups/{adgroup_id}/insights` },
  ad_insights: { method: "GET", path: `${T}/ads/{ad_id}/insights` },
  locations: { method: "GET", path: `${T}/locations` },
  interests: { method: "GET", path: `${T}/interests` },
  audiences: { method: "GET", path: `${T}/audiences` },
};

const WRITE_ROUTES: Record<string, Route> = {
  connect: { method: "POST", path: `${T}/connect` },
  disconnect: { method: "DELETE", path: `${T}/accounts/{advertiser_id}` },
  boost: { method: "POST", path: `${T}/boost` },
  create_campaign: { method: "POST", path: `${T}/campaigns` },
  update_campaign: { method: "PATCH", path: `${T}/campaigns/{campaign_id}` },
  pause_campaign: { method: "POST", path: `${T}/campaigns/{campaign_id}/pause` },
  resume_campaign: { method: "POST", path: `${T}/campaigns/{campaign_id}/resume` },
  delete_campaign: { method: "POST", path: `${T}/campaigns/{campaign_id}/delete` },
  create_adgroup: { method: "POST", path: `${T}/adgroups` },
  update_adgroup: { method: "PATCH", path: `${T}/adgroups/{adgroup_id}` },
  pause_adgroup: { method: "POST", path: `${T}/adgroups/{adgroup_id}/pause` },
  resume_adgroup: { method: "POST", path: `${T}/adgroups/{adgroup_id}/resume` },
  delete_adgroup: { method: "POST", path: `${T}/adgroups/{adgroup_id}/delete` },
  create_ad: { method: "POST", path: `${T}/ads` },
  update_ad: { method: "PATCH", path: `${T}/ads/{ad_id}` },
  pause_ad: { method: "POST", path: `${T}/ads/{ad_id}/pause` },
  resume_ad: { method: "POST", path: `${T}/ads/{ad_id}/resume` },
  delete_ad: { method: "POST", path: `${T}/ads/{ad_id}/delete` },
  upload_video: { method: "POST", path: `${T}/creatives/videos` },
  upload_image: { method: "POST", path: `${T}/creatives/images` },
  create_customer_file_audience: { method: "POST", path: `${T}/audiences/customer-file` },
  create_lookalike_audience: { method: "POST", path: `${T}/audiences/lookalike` },
  delete_audience: { method: "POST", path: `${T}/audiences/{audience_id}/delete` },
};

/** Ids that name the object in the path; on the creates and lists they are fields. */
const PATH_IDS = ["campaign_id", "adgroup_id", "ad_id", "audience_id"];

const actionEnum = (routes: Record<string, Route>) => z.enum(Object.keys(routes) as [string, ...string[]]);

const accountFields = {
  advertiser_id: z
    .string()
    .optional()
    .describe(
      "Connected TikTok ad account to use (from tiktok_ads_read accounts). Without it and without profile_username: the only account, or the default one."
    ),
  profile_username: z
    .string()
    .optional()
    .describe("Use only the TikTok ad account linked to this Upload-Post profile (never the default)."),
};

const idFields = {
  campaign_id: z
    .string()
    .optional()
    .describe("The campaign (campaign_insights, update/pause/resume/delete_campaign; adgroups and ads list the ones of this campaign; create_adgroup puts the group in it)."),
  adgroup_id: z
    .string()
    .optional()
    .describe("The ad group (adgroup_insights, update/pause/resume/delete_adgroup; ads lists the ones of this group; create_ad puts the ad in it)."),
  ad_id: z.string().optional().describe("The ad (ad_insights, update/pause/resume/delete_ad)."),
};

function queryValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.join(",");
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return value;
}

async function callTiktokAds(client: UploadPostMcpClient, route: Route, input: Record<string, unknown>): Promise<unknown> {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) if (v !== undefined) fields[k] = v;
  const path = route.path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = fields[name];
    // The advertiser of /accounts/{advertiser_id} is the object, not the account choice.
    delete fields[name];
    if (value === undefined || value === null || value === "") throw new Error(`\`${name}\` is required for this action.`);
    return encodeURIComponent(String(value));
  });
  // The account choice goes in the query string: the API reads it there first,
  // and the pause/resume routes take nothing else.
  const query: Record<string, unknown> = {};
  for (const key of ["advertiser_id", "profile_username"]) {
    if (fields[key] !== undefined && fields[key] !== "") query[key] = fields[key];
    delete fields[key];
  }
  if (route.method === "GET" || route.method === "DELETE") {
    for (const [k, v] of Object.entries(fields)) {
      if (v === null || v === "") continue;
      query[k] = queryValue(v);
    }
    return client.request(route.method, path, { query });
  }
  return client.request(route.method, path, { query, body: fields });
}

/** Ids a create reads from its body (the parent it goes in). */
const BODY_IDS: Record<string, string[]> = { create_adgroup: ["campaign_id"], create_ad: ["adgroup_id"] };

/** What manage_tiktok_ads sends: paused by default, and only the ids the route uses. */
export function tiktokAdsBody(action: string, fields: Record<string, unknown>): Record<string, unknown> {
  const out = { ...fields };
  const isCreate = action === "boost" || action === "create_campaign" || action === "create_adgroup" || action === "create_ad";
  if (isCreate && (out.status === undefined || out.status === "")) out.status = "paused";
  if (action === "boost" && out.status === "paused" && out.pause_all_levels === undefined) out.pause_all_levels = true;
  const path = WRITE_ROUTES[action]?.path ?? "";
  for (const id of PATH_IDS) {
    if (!path.includes(`{${id}}`) && !(BODY_IDS[action] ?? []).includes(id)) delete out[id];
  }
  return out;
}

export function registerTiktokAdsTools(server: McpServer, client: UploadPostMcpClient): RegisteredTool[] {
  const read = server.registerTool(
    "tiktok_ads_read",
    {
      title: "Read TikTok Ads",
      description:
        "Read-only TikTok Ads data of the TikTok ad account the user connected to Upload-Post; nothing here changes or spends anything (spend on that account is charged by TikTok, never by Upload-Post). " +
        "accounts (connected ad accounts with their linked profiles; reauth_required true = connect it again with manage_tiktok_ads connect); account (live name, currency, time zone, status, balance, country); " +
        "identities (TikTok accounts the ad account can advertise as; params identity_type, page, page_size): use identity_id of the one that published the post; " +
        "spark_posts (params identity_id, item_type VIDEO|CAROUSEL, count 1-20, cursor of the previous page while has_more, exclude_adsonly): posts of that TikTok account, use item_id as post_id in manage_tiktok_ads boost or create_ad; " +
        "campaigns (params ids, page, page_size), adgroups (campaign_id, params ids), ads (campaign_id or adgroup_id, params ids): as TikTok has them, also those made in TikTok Ads Manager, read live; " +
        "insights (params level advertiser|campaign|adgroup|ad, ids), campaign_insights (campaign_id), adgroup_insights (adgroup_id), ad_insights (ad_id): params start_date / end_date YYYY-MM-DD (default the last 7 days, UTC), breakdown day|age|gender|country|platform (day: at most 30 days, otherwise 365); answers totals (spend in the account currency, impressions, clicks, ctr, cpc, cpm) and rows; " +
        "locations (params goal reach|video_views|traffic|followers): the countries TikTok delivers that goal to; interests (params language): interest categories for targeting.interest_category_ids; audiences (params page, page_size): custom and lookalike audiences. " +
        "404 means no TikTok ad account is connected, the profile has none linked, or the object does not exist; 401 tiktok_ads_reauth_required means it has to be connected again.",
      inputSchema: {
        action: actionEnum(READ_ROUTES),
        ...accountFields,
        ...idFields,
        params: paramsField("Paging, filters and report fields, as listed for each action."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: { title: "Read TikTok Ads", readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    },
    safe(async (args) => {
      const action = (args as { action: string }).action;
      const fields = mergeArgs(args as Record<string, unknown>);
      const route = READ_ROUTES[action];
      // Ids that are not in the route's path are list filters only where the API reads them.
      const filters: Record<string, string[]> = { adgroups: ["campaign_id"], ads: ["campaign_id", "adgroup_id"] };
      for (const id of PATH_IDS) {
        if (!route.path.includes(`{${id}}`) && !(filters[action] ?? []).includes(id)) delete fields[id];
      }
      return callTiktokAds(client, route, fields);
    })
  );

  const manage = server.registerTool(
    "manage_tiktok_ads",
    {
      title: "Manage TikTok Ads",
      description:
        "Create and change TikTok ads in the TikTok ad account the user connected to Upload-Post. This can spend the user's money: TikTok charges the ad spend to their own ad account (Upload-Post never does), and an ad runs once its campaign, ad group and ad are all enabled and TikTok approved it. " +
        "Everything is created PAUSED unless params.status is active: this tool sends status paused when none is given, and a boost also pauses its ad group and ad (pause_all_levels true) unless params.pause_all_levels is false. Fields go in `params` with the API's names. " +
        "boost: promote an existing post in one call (campaign + ad group + Spark Ad): params identity_id and post_id (from tiktok_ads_read identities and spark_posts), goal reach|video_views|traffic|followers, budget {amount, type daily|lifetime} in the account currency (TikTok refuses less than about 20 EUR a day per ad group), targeting {countries (ISO), age_min, age_max or age_groups (default 18+), gender, interest_category_ids, languages, audience_ids, excluded_audience_ids}, schedule {start_date, end_date}, landing_page_url (required for traffic), call_to_action (only with landing_page_url; VIEW_PROFILE only with followers), frequency / frequency_schedule (reach: default 3 every 7 days), name, idempotency_key; if a later step fails, details.created lists what already exists (paused). " +
        "create_campaign (name, goal, optional budget: without it the budget lives in the ad groups); create_adgroup (campaign_id, name, goal of the campaign, budget, targeting, schedule); create_ad (adgroup_id, name, identity_id + post_id, optional landing_page_url and call_to_action; its text is the post's caption). " +
        "update_campaign / update_adgroup (name, budget; a campaign without its own budget answers campaign_without_budget: change its ad groups; an ad group budget must be at least 105% of what it spent) and update_ad (name). " +
        "resume_* starts spending (campaign_id, adgroup_id or ad_id; after a boost with pause_all_levels resume the ad, the ad group and the campaign), pause_* stops it, delete_* cannot be undone and needs confirm: true. " +
        "connect: returns authorize_url, a TikTok page the user opens to connect an ad account (params profile_username to link it, redirect_url); disconnect (advertiser_id; params profile_username to only unlink that profile; campaigns keep running in TikTok). " +
        "upload_video / upload_image (params video_url / image_url), create_customer_file_audience (name, identifier_type email|phone, identifiers: hashed with SHA-256 before they leave Upload-Post), create_lookalike_audience (name, source_audience_id, countries, audience_size), delete_audience (audience_id, confirm: true). " +
        "Read results with tiktok_ads_read.",
      inputSchema: {
        action: actionEnum(WRITE_ROUTES),
        ...accountFields,
        ...idFields,
        audience_id: z.string().optional().describe("The audience (delete_audience)."),
        confirm: apiConfirmField,
        params: paramsField("See the description for each action's fields."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Manage TikTok Ads",
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    safe(async (args) => {
      const action = (args as { action: string }).action;
      const fields = mergeArgs(args as Record<string, unknown>);
      if (action.startsWith("delete_") && fields.confirm !== true) {
        throw new Error("Deleting cannot be undone: ask the user, then call again with confirm: true.");
      }
      if (!action.startsWith("delete_")) delete fields.confirm;
      return callTiktokAds(client, WRITE_ROUTES[action], tiktokAdsBody(action, fields));
    })
  );

  return [read, manage];
}

/** What a manage_tiktok_ads call would do, when it can spend money or cannot be undone. */
export function describeTiktokAdsAction(a: Record<string, unknown>): string | undefined {
  const action = String(a.action ?? "");
  const p = { ...((a.params ?? {}) as Record<string, unknown>) };
  const account = a.profile_username
    ? ` in the TikTok ad account of profile "${String(a.profile_username)}"`
    : a.advertiser_id && action !== "disconnect"
      ? ` in TikTok ad account ${String(a.advertiser_id)}`
      : " in the default TikTok ad account";
  const money = "TikTok charges the spend to the user's own ad account.";
  const active = p.status === "active";
  const budget = p.budget !== undefined ? ` with a budget of ${JSON.stringify(p.budget)} (ad account currency)` : "";
  if (action.startsWith("pause_") || action.startsWith("upload_") || action === "connect") return undefined;
  if (action === "create_customer_file_audience" || action === "create_lookalike_audience") return undefined;
  if (action === "boost") {
    return active
      ? `Creates and STARTS a TikTok campaign, ad group and ad${account} promoting post ${String(p.post_id ?? "")}${budget}, goal ${String(p.goal ?? "")}; it starts spending once TikTok approves the ad. ${money}`
      : undefined;
  }
  if (action.startsWith("create_")) {
    return active ? `Creates an ACTIVE TikTok ${action.slice(7)}${account}${budget}; it can start spending right away. ${money}` : undefined;
  }
  if (action === "disconnect") {
    return a.profile_username
      ? `Unlinks TikTok ad account ${String(a.advertiser_id ?? "")} from profile "${String(a.profile_username)}".`
      : `Disconnects TikTok ad account ${String(a.advertiser_id ?? "")} from Upload-Post and unlinks every profile. Its campaigns keep running in TikTok Ads Manager.`;
  }
  if (action === "delete_audience") return `Deletes TikTok audience ${String(a.audience_id ?? "")}${account}. It cannot be undone.`;
  const kind = action.replace(/^(update|resume|delete)_/, "");
  const id = String(a[`${kind}_id`] ?? "");
  const what = `${kind} ${id}${account}`;
  if (action.startsWith("resume_")) return `Resumes TikTok ${what}: it can start spending right away. ${money}`;
  if (action.startsWith("delete_")) return `Deletes TikTok ${what}. It stops running and cannot be undone.`;
  if (action.startsWith("update_")) {
    return p.budget !== undefined ? `Changes the budget of TikTok ${what} to ${JSON.stringify(p.budget)}. ${money}` : undefined;
  }
  return undefined;
}
