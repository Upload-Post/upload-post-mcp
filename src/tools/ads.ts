import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { genericResultOutputSchema, safe } from "../schemas.js";
import { mergeArgs, paramsField, type Route } from "./resource.js";

/**
 * ChatGPT Ads (OpenAI's ad platform) through the ad account the user connected
 * to Upload-Post: campaigns, ad groups, ads, creatives and insights. Spend runs
 * on the user's own OpenAI billing. Connecting or disconnecting the account
 * takes the OpenAI Ads key and stays in the dashboard.
 *
 * Raw HTTP for now: the published SDK (upload-post 2.21.0) has no Ads methods.
 */

const A = "/uploadposts/ads/chatgpt";

const READ_ROUTES: Record<string, Route> = {
  accounts: { method: "GET", path: `${A}/accounts` },
  account: { method: "GET", path: `${A}/account` },
  insights: { method: "GET", path: `${A}/insights` },
  campaigns: { method: "GET", path: `${A}/campaigns` },
  campaign: { method: "GET", path: `${A}/campaigns/{campaign_id}` },
  campaign_insights: { method: "GET", path: `${A}/campaigns/{campaign_id}/insights` },
  ad_groups: { method: "GET", path: `${A}/adgroups` },
  ad_group: { method: "GET", path: `${A}/adgroups/{ad_group_id}` },
  ad_group_insights: { method: "GET", path: `${A}/adgroups/{ad_group_id}/insights` },
  ads: { method: "GET", path: `${A}/ads` },
  ad: { method: "GET", path: `${A}/ads/{ad_id}` },
  ad_insights: { method: "GET", path: `${A}/ads/{ad_id}/insights` },
  // A POST that changes nothing: OpenAI renders a temporary preview.
  preview_ad: { method: "POST", path: `${A}/ads/{ad_id}/preview` },
};

const WRITE_ROUTES: Record<string, Route> = {
  promote: { method: "POST", path: `${A}/promote` },
  create_campaign: { method: "POST", path: `${A}/campaigns` },
  update_campaign: { method: "POST", path: `${A}/campaigns/{campaign_id}` },
  activate_campaign: { method: "POST", path: `${A}/campaigns/{campaign_id}/activate` },
  pause_campaign: { method: "POST", path: `${A}/campaigns/{campaign_id}/pause` },
  archive_campaign: { method: "POST", path: `${A}/campaigns/{campaign_id}/archive` },
  create_ad_group: { method: "POST", path: `${A}/adgroups` },
  update_ad_group: { method: "POST", path: `${A}/adgroups/{ad_group_id}` },
  activate_ad_group: { method: "POST", path: `${A}/adgroups/{ad_group_id}/activate` },
  pause_ad_group: { method: "POST", path: `${A}/adgroups/{ad_group_id}/pause` },
  archive_ad_group: { method: "POST", path: `${A}/adgroups/{ad_group_id}/archive` },
  create_ad: { method: "POST", path: `${A}/ads` },
  update_ad: { method: "POST", path: `${A}/ads/{ad_id}` },
  activate_ad: { method: "POST", path: `${A}/ads/{ad_id}/activate` },
  pause_ad: { method: "POST", path: `${A}/ads/{ad_id}/pause` },
  archive_ad: { method: "POST", path: `${A}/ads/{ad_id}/archive` },
  upload_creative: { method: "POST", path: `${A}/creatives` },
};

/** Insights parameters the API reads as repeated `key[]` values. */
const REPEATABLE = new Set(["fields", "segments", "filters", "sort", "time_ranges"]);

/** Path ids: required by the routes that name them, and also how the list reads filter. */
const PATH_IDS = ["campaign_id", "ad_group_id", "ad_id"];

const actionEnum = (routes: Record<string, Route>) => z.enum(Object.keys(routes) as [string, ...string[]]);

const accountFields = {
  ad_account_id: z
    .string()
    .optional()
    .describe("Connected ad account to use (`adacct_...`, from chatgpt_ads_read accounts). Without it and without profile_username: the default account."),
  profile_username: z
    .string()
    .optional()
    .describe("Use the ad account linked to this Upload-Post profile, and only that one."),
};

const idFields = {
  campaign_id: z.string().optional().describe("The campaign (campaign, campaign_insights, update/activate/pause/archive_campaign; ad_groups lists the groups of this campaign; create_ad_group puts the group in it)."),
  ad_group_id: z.string().optional().describe("The ad group (ad_group, ad_group_insights, update/activate/pause/archive_ad_group; ads lists the ads of this group; create_ad puts the ad in it)."),
  ad_id: z.string().optional().describe("The ad (ad, ad_insights, preview_ad, update/activate/pause/archive_ad)."),
};

function queryValue(key: string, value: unknown): unknown {
  if (REPEATABLE.has(key)) {
    const list = Array.isArray(value) ? value : [value];
    // filters, sort and time_ranges are JSON-encoded objects, one per value.
    return list.map((v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v));
  }
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return value;
}

async function callAds(
  client: UploadPostMcpClient,
  route: Route,
  input: Record<string, unknown>,
  listParent?: "campaign_id" | "ad_group_id"
): Promise<unknown> {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) if (v !== undefined) fields[k] = v;
  const path = route.path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = fields[name];
    delete fields[name];
    if (value === undefined || value === null || value === "") throw new Error(`\`${name}\` is required for this action.`);
    return encodeURIComponent(String(value));
  });
  // The account choice goes in the query string: the activate/pause/archive and
  // preview routes take no body, and the query wins over the body everywhere.
  const query: Record<string, unknown> = {};
  for (const key of ["ad_account_id", "profile_username"]) {
    if (fields[key] !== undefined && fields[key] !== "") query[key] = fields[key];
    delete fields[key];
  }
  if (route.method === "GET") {
    for (const [k, v] of Object.entries(fields)) {
      if (v === null || v === "") continue;
      // Only the list of the parent's children reads the parent id.
      if (PATH_IDS.includes(k) && k !== listParent) continue;
      query[k] = queryValue(k, v);
    }
    return client.request("GET", path, { query });
  }
  const noBody = /\/(activate|pause|archive|preview)$/.test(route.path);
  if (noBody) {
    return client.request(route.method, path, { query });
  }
  return client.request(route.method, path, { query, body: fields });
}

const LIST_PARENT: Record<string, "campaign_id" | "ad_group_id" | undefined> = {
  ad_groups: "campaign_id",
  ads: "ad_group_id",
};

export function registerAdsTools(server: McpServer, client: UploadPostMcpClient): RegisteredTool[] {
  const read = server.registerTool(
    "chatgpt_ads_read",
    {
      title: "Read ChatGPT Ads",
      description:
        "Read-only ChatGPT Ads (OpenAI's ad platform) data of the ad account the user connected to Upload-Post in the dashboard; spending on it runs on the user's own OpenAI billing. Nothing here changes or spends anything. " +
        "accounts (connected ad accounts, default first, with their linked profiles; never the key); account (live metadata of the chosen account); " +
        "campaigns; campaign (campaign_id); ad_groups (campaign_id required); ad_group (ad_group_id); ads (ad_group_id required; each ad has review_status in_review|approved|rejected); ad (ad_id); " +
        "lists take params limit (1-500, default 20), after (last_id of the previous page), before, order asc|desc. " +
        "insights (whole account), campaign_insights (campaign_id), ad_group_insights (ad_group_id), ad_insights (ad_id): params since / until (YYYY-MM-DD, ad account timezone), time_granularity hourly|daily|monthly|none (default daily), aggregation_level ad_account|campaign|ad_group|ad, fields (list: impressions, clicks, spend, ctr, cpc, cpm and more), segments (list: product, country, device), filters / sort / time_ranges (lists of objects, passed to OpenAI), limit (1-2000), after, before. " +
        "preview_ad (ad_id): a temporary preview link of the ad, valid 24 hours. " +
        "404 means no ChatGPT Ads account is connected, the profile has none linked, or the object does not exist; 401 can also mean OpenAI revoked the stored key and the account has to be reconnected in the dashboard.",
      inputSchema: {
        action: actionEnum(READ_ROUTES),
        ...accountFields,
        ...idFields,
        params: paramsField("Paging and insights fields, as listed for each action."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: { title: "Read ChatGPT Ads", readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    },
    safe(async (args) => {
      const action = (args as { action: string }).action;
      return callAds(client, READ_ROUTES[action], mergeArgs(args as Record<string, unknown>), LIST_PARENT[action]);
    })
  );

  const manage = server.registerTool(
    "manage_chatgpt_ads",
    {
      title: "Manage ChatGPT Ads",
      description:
        "Create and change ChatGPT Ads campaigns, ad groups and ads in the ad account the user connected to Upload-Post. This spends the user's money: spend runs on their own OpenAI billing, and an ad serves only when its campaign, ad group and ad are all active and OpenAI approved the ad. Objects are created paused unless params.status is active. Fields go in `params` with the API's names. " +
        "promote: campaign + ad group + ad in one call (title 3-50 characters, body up to 100, target_url, image_url or file_id; budget = lifetime spend limit in the account currency, minimum 1, or budget_micros; max_bid per billing event or max_bid_micros; bidding_type impressions|clicks|conversions, billing_event_type impression|click, start_time, end_time, locations, targeting, context_hints, name, ad_group_name, ad_name, status); if a later step fails the error lists in details.created what was already created. " +
        "create_campaign (name, budget or budget_micros, status, description, start_time, end_time, bidding_type, conversion_event_setting_ids, locations, custom_audience_ids, excluded_custom_audience_ids, targeting); " +
        "create_ad_group (campaign_id, name, max_bid or max_bid_micros unless bidding_config, billing_event_type, status, description, context_hints, product_set); " +
        "create_ad (ad_group_id, name, and title, body, target_url, file_id, price at the top level or a full creative object; type chat_card|product_ad_template; it serves after OpenAI's review); " +
        "upload_creative (image_url, OpenAI fetches it; returns the file_id an ad uses); " +
        "update_campaign / update_ad_group / update_ad (the id plus only the fields to change; an edited ad goes back into review); " +
        "activate_* starts spending, pause_* stops it, archive_* is irreversible (campaign_id, ad_group_id or ad_id). " +
        "Connecting or disconnecting the ad account is done in the Upload-Post dashboard. Read results with chatgpt_ads_read.",
      inputSchema: {
        action: actionEnum(WRITE_ROUTES),
        ...accountFields,
        ...idFields,
        params: paramsField("See the description for each action's fields."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Manage ChatGPT Ads",
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    safe(async (args) => {
      const action = (args as { action: string }).action;
      const fields = mergeArgs(args as Record<string, unknown>);
      // The create routes read the parent from the body, not from the path.
      return callAds(client, WRITE_ROUTES[action], fields);
    })
  );

  return [read, manage];
}

/** What a manage_chatgpt_ads call would do, when it spends money or cannot be undone. */
export function describeAdsAction(a: Record<string, unknown>): string | undefined {
  const action = String(a.action ?? "");
  const p = { ...((a.params ?? {}) as Record<string, unknown>) };
  const account = a.profile_username
    ? ` in the ad account of profile "${String(a.profile_username)}"`
    : a.ad_account_id
      ? ` in ad account ${String(a.ad_account_id)}`
      : " in the default ad account";
  const money = "Spend runs on the user's own OpenAI billing.";
  const active = p.status === "active";
  const budget =
    p.budget !== undefined ? ` with a lifetime budget of ${String(p.budget)}` : p.budget_micros !== undefined ? ` with a lifetime budget of ${String(p.budget_micros)} micros` : "";
  const bid = p.max_bid !== undefined ? `, max bid ${String(p.max_bid)}` : p.max_bid_micros !== undefined ? `, max bid ${String(p.max_bid_micros)} micros` : "";
  if (action.startsWith("pause_") || action === "upload_creative") return undefined;
  if (action === "promote") {
    return active
      ? `Creates and ACTIVATES a ChatGPT Ads campaign, ad group and ad${account}${budget}${bid} for "${String(p.title ?? "")}" → ${String(p.target_url ?? "")}; it starts spending once OpenAI approves the ad. ${money}`
      : undefined;
  }
  if (action.startsWith("create_")) {
    return active ? `Creates an ACTIVE ${action.slice(7).replace("_", " ")}${account}${budget}${bid}; it can start spending right away. ${money}` : undefined;
  }
  const kind = action.replace(/^(update|activate|archive)_/, "");
  const id = String(a[`${kind}_id`] ?? "");
  const what = `${kind.replace("_", " ")} ${id}${account}`;
  if (action.startsWith("activate_")) return `Activates ChatGPT Ads ${what}: it starts spending. ${money}`;
  if (action.startsWith("archive_")) return `Archives ChatGPT Ads ${what}. It stops serving and cannot be undone.`;
  if (action.startsWith("update_")) {
    return `Changes ChatGPT Ads ${what}${budget}${bid}${p.status ? ` and sets it ${String(p.status)}` : ""}: ${JSON.stringify(p)}. ${money}`;
  }
  return undefined;
}
