import { z } from "zod";
import type { McpServer, RegisteredResource, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { MCP_APP_MIME_TYPE, type SessionContext } from "../client_profile.js";
import {
  DEFAULT_PROFILE,
  normalizePlatform,
  profilesOf,
  resolveConnectLink,
  oneClickTarget,
} from "../connect.js";
import { fail, ok, REDDIT_ENABLED, REDDIT_UNAVAILABLE } from "../schemas.js";

/**
 * "Your social accounts": an MCP Apps view (SEP-1865, `text/html;profile=mcp-app`)
 * with one card per network and a button that opens that network's connection
 * page in a new tab. OAuth for TikTok, Meta or Google cannot run inside the
 * host's iframe, so the view never tries.
 *
 * The signed link is minted when the user clicks, not when the view renders:
 * generate-jwt stores the platform list on the profile, so two links minted
 * ahead of time would leave the first one showing the second network.
 *
 * Only advertised to hosts that declare MCP Apps in `initialize` and are not
 * ChatGPT (see buildServer).
 */

export const NETWORKS_VIEW_URI = "ui://upload-post/social-accounts.html";
export const NETWORKS_TOOL = "open_social_accounts";
export const NETWORK_LINK_TOOL = "create_social_connect_link";

/** `oauth`: the connection page sends the user to the network. `form`: credentials typed on our page. */
export type ConnectMode = "oauth" | "form";

export interface NetworkInfo {
  id: string;
  label: string;
  mode: ConnectMode;
  /** Shown in the main grid; the rest sit under "More networks" unless connected or asked for. */
  featured: boolean;
  color: string;
}

/** The networks the connection page offers, in its order. */
export const NETWORKS: NetworkInfo[] = [
  { id: "tiktok", label: "TikTok", mode: "oauth", featured: true, color: "#111111" },
  { id: "instagram", label: "Instagram", mode: "oauth", featured: true, color: "#E1306C" },
  { id: "youtube", label: "YouTube", mode: "oauth", featured: true, color: "#FF0000" },
  { id: "linkedin", label: "LinkedIn", mode: "oauth", featured: true, color: "#0A66C2" },
  { id: "facebook", label: "Facebook", mode: "oauth", featured: true, color: "#1877F2" },
  { id: "x", label: "X", mode: "oauth", featured: true, color: "#111111" },
  { id: "threads", label: "Threads", mode: "oauth", featured: true, color: "#111111" },
  { id: "pinterest", label: "Pinterest", mode: "oauth", featured: true, color: "#E60023" },
  { id: "reddit", label: "Reddit", mode: "oauth", featured: true, color: "#FF4500" },
  { id: "bluesky", label: "Bluesky", mode: "form", featured: true, color: "#0085FF" },
  { id: "google_business", label: "Google Business", mode: "oauth", featured: true, color: "#4285F4" },
  { id: "telegram", label: "Telegram", mode: "form", featured: true, color: "#26A5E4" },
  { id: "discord", label: "Discord", mode: "form", featured: false, color: "#5865F2" },
  { id: "mastodon", label: "Mastodon", mode: "form", featured: false, color: "#6364FF" },
  { id: "wordpress", label: "WordPress", mode: "form", featured: false, color: "#21759B" },
  { id: "slack", label: "Slack", mode: "form", featured: false, color: "#4A154B" },
  { id: "nostr", label: "Nostr", mode: "form", featured: false, color: "#8E44AD" },
  { id: "lemmy", label: "Lemmy", mode: "form", featured: false, color: "#00BC8C" },
  { id: "devto", label: "Dev.to", mode: "form", featured: false, color: "#0A0A0A" },
  { id: "hashnode", label: "Hashnode", mode: "form", featured: false, color: "#2962FF" },
  { id: "whop", label: "Whop", mode: "form", featured: false, color: "#FA4616" },
  { id: "listmonk", label: "Listmonk", mode: "form", featured: false, color: "#00A98F" },
];

const NETWORK_IDS = NETWORKS.map((n) => n.id) as [string, ...string[]];
const NETWORK_BY_ID = new Map(NETWORKS.map((n) => [n.id, n]));

/** Profiles sent to the view. Agencies can have hundreds; the selected one is always included. */
export const MAX_VIEW_PROFILES = 50;

export interface AccountState {
  state: "connected" | "reconnect";
  name?: string;
}

export interface ProfileAccounts {
  profile: string;
  accounts: Record<string, AccountState>;
}

/** Per profile, the networks with an account behind them and whether it still works. */
export function profileAccounts(listUsersResult: unknown): ProfileAccounts[] {
  return profilesOf(listUsersResult).map((p) => {
    const accounts: Record<string, AccountState> = {};
    for (const [platform, value] of Object.entries((p.social_accounts ?? {}) as Record<string, unknown>)) {
      // An unconnected slot is "" or null (new profiles carry `tiktok: ""`).
      if (!value) continue;
      if (typeof value === "object" && Object.keys(value as object).length === 0) continue;
      const rec = (typeof value === "object" ? value : {}) as Record<string, unknown>;
      const name = [rec.display_name, rec.handle, rec.username].find((v) => typeof v === "string" && v) as
        | string
        | undefined;
      accounts[normalizePlatform(platform)] = {
        state: rec.reauth_required === true ? "reconnect" : "connected",
        ...(name ? { name } : {}),
      };
    }
    return { profile: String(p.username ?? ""), accounts };
  });
}

export type NetworkState = "connected" | "reconnect" | "not_connected" | "unavailable";

/** What a card shows for one network of one profile. */
export function networkState(
  accounts: Record<string, AccountState> | undefined,
  id: string,
  redditAvailable = REDDIT_ENABLED
): NetworkState {
  const account = accounts?.[id];
  // Reconnecting Reddit is as impossible as connecting it while it is down.
  if (id === "reddit" && !redditAvailable && account?.state !== "connected") return "unavailable";
  if (account) return account.state;
  return "not_connected";
}

export interface NetworksViewData {
  view: "social_accounts";
  profiles: ProfileAccounts[];
  profiles_total: number;
  /** Profile the cards show; null while the account has no profile at all. */
  selected: string | null;
  /** Networks the user asked for, shown first. */
  highlight: string[];
  /** True when clicking a card opens a signed link that needs no Upload-Post login. */
  one_click: boolean;
  reddit_available: boolean;
}

export function buildViewData(
  listUsersResult: unknown,
  opts: { profile?: string; platforms?: string[] } = {}
): NetworksViewData {
  const all = profileAccounts(listUsersResult);
  const names = all.map((p) => p.profile);
  let selected: string | null = null;
  if (opts.profile && names.includes(opts.profile)) selected = opts.profile;
  else if (names.includes(DEFAULT_PROFILE)) selected = DEFAULT_PROFILE;
  else if (names.length) selected = names[0];

  let profiles = all.slice(0, MAX_VIEW_PROFILES);
  if (selected && !profiles.some((p) => p.profile === selected)) {
    profiles = [...profiles.slice(0, MAX_VIEW_PROFILES - 1), all.find((p) => p.profile === selected)!];
  }
  const highlight = [...new Set((opts.platforms ?? []).map(normalizePlatform))].filter((id) => NETWORK_BY_ID.has(id));
  return {
    view: "social_accounts",
    profiles,
    profiles_total: all.length,
    selected,
    highlight,
    one_click: oneClickTarget(names, selected ?? undefined) !== undefined,
    reddit_available: REDDIT_ENABLED,
  };
}

function label(id: string): string {
  return NETWORK_BY_ID.get(id)?.label ?? id;
}

function list(ids: string[]): string {
  return ids.map(label).join(", ");
}

/** Plain-text twin of the view, for the model and for hosts that only show text. */
export function viewSummary(data: NetworksViewData): string {
  if (!data.selected) {
    return (
      "This Upload-Post account has no profile and no connected social account yet, so nothing can be published. " +
      `The user now sees one card per network; clicking one creates the profile "${DEFAULT_PROFILE}" and opens that network's connection page in a new tab, with no Upload-Post login needed. ` +
      "The cards re-check for a few minutes after each click and turn green once the network is connected."
    );
  }
  const accounts = data.profiles.find((p) => p.profile === data.selected)?.accounts ?? {};
  const connected = Object.entries(accounts)
    .filter(([, a]) => a.state === "connected")
    .map(([id, a]) => (a.name ? `${label(id)} (${a.name})` : label(id)));
  const reconnect = Object.entries(accounts)
    .filter(([, a]) => a.state === "reconnect")
    .map(([id]) => id);
  const wanted = data.highlight.filter((id) => accounts[id]?.state !== "connected");
  const parts = [
    `Social accounts of profile "${data.selected}"` +
      (data.profiles_total > 1 ? ` (the account has ${data.profiles_total} profiles; the user can switch in the view)` : "") +
      ".",
    connected.length ? `Connected: ${connected.join(", ")}.` : "No network is connected to this profile yet.",
  ];
  if (reconnect.length) parts.push(`Needs reconnecting before publishing: ${list(reconnect)}.`);
  if (wanted.length) parts.push(`Asked for but not ready yet: ${list(wanted)}.`);
  parts.push(
    data.one_click
      ? "Each card opens that network's connection page in a new tab, with no Upload-Post login needed."
      : "Each card opens the Upload-Post dashboard in a new tab, where the user signs in and connects the network."
  );
  parts.push(
    "The cards re-check for a few minutes after each click, turn green once a network is connected and report it back here. Before publishing, list_users confirms the connection."
  );
  return parts.join(" ");
}

// --- auto-refresh -----------------------------------------------------------

export interface PollConfig {
  intervalMs: number;
  /** Checks after one click. */
  maxPolls: number;
  /** How long one click keeps the view checking. */
  maxMs: number;
  /** Checks over the whole life of one view, however many clicks. */
  maxTotalPolls: number;
}

/** One check every 5 s for at most 3 minutes after a click, and never more than 120 per view. */
export const POLL: PollConfig = { intervalMs: 5_000, maxPolls: 36, maxMs: 180_000, maxTotalPolls: 120 };

export interface PollState {
  startedAt: number;
  polls: number;
  total: number;
  /** Clicked networks that are not connected yet. */
  pending: number;
}

/**
 * Whether the view checks again. Runs in the view too (inlined into the HTML
 * below), so it must stay self-contained: no imports, no outer references.
 */
export function pollDecision(state: PollState, now: number, cfg: PollConfig): "poll" | "done" | "limit" {
  if (state.pending <= 0) return "done";
  if (state.total >= cfg.maxTotalPolls) return "limit";
  if (state.polls >= cfg.maxPolls) return "limit";
  if (now - state.startedAt >= cfg.maxMs) return "limit";
  return "poll";
}

// --- registration -----------------------------------------------------------

const resourceMeta = {
  ui: {
    prefersBorder: true,
    // Everything is inline and every call goes through the host: the view
    // needs no network access of its own. No `domain`: each host has its own
    // format for it (claude.ai rejects anything but its hashed origin).
    csp: { connectDomains: [], resourceDomains: [] },
  },
};

export interface NetworksViewHandles {
  tool: RegisteredTool;
  linkTool: RegisteredTool;
  resource: RegisteredResource;
}

export function registerNetworksView(
  server: McpServer,
  client: UploadPostMcpClient,
  ctx: SessionContext
): NetworksViewHandles {
  const resource = server.registerResource(
    "upload-post-social-accounts",
    NETWORKS_VIEW_URI,
    {
      title: "Upload-Post social accounts",
      description: "Cards to connect or reconnect social networks to an Upload-Post profile.",
      mimeType: MCP_APP_MIME_TYPE,
      _meta: resourceMeta,
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: MCP_APP_MIME_TYPE, text: networksViewHtml, _meta: resourceMeta }],
    })
  );

  const tool = server.registerTool(
    NETWORKS_TOOL,
    {
      title: "Show social accounts",
      description:
        "Show the user's social accounts as interactive cards, one per network (TikTok, Instagram, YouTube, LinkedIn, Facebook, X, Threads, Pinterest, Bluesky, Google Business, Telegram and more), each marked connected, needs reconnecting or not connected, with a button that opens that network's connection page in a new tab. " +
        "After a click the cards re-check on their own for a few minutes and report a new connection back to the conversation, so the user does not have to come back and confirm. " +
        "Use it when the account has no connected social account yet, when the user asks to connect or reconnect a network (for example \"connect my TikTok\"), or to show which networks a profile can publish to. " +
        "Pass `platforms` to put the networks the user asked for first, and `profile` to show a specific profile.",
      inputSchema: {
        platforms: z
          .array(z.string())
          .optional()
          .describe("Networks the user wants to connect or publish to, e.g. ['tiktok','instagram']; shown first."),
        profile: z
          .string()
          .optional()
          .describe("Profile to show. Defaults to the only profile, or \"default\"."),
      },
      annotations: {
        title: "Show social accounts",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
      _meta: {
        ui: { resourceUri: NETWORKS_VIEW_URI, visibility: ["model", "app"] },
        // Legacy flat key, still read by hosts on earlier drafts of the spec.
        "ui/resourceUri": NETWORKS_VIEW_URI,
      },
    },
    async (args) => {
      try {
        const { platforms, profile } = args as { platforms?: string[]; profile?: string };
        const data = buildViewData(await client.sdk.listUsers(), { platforms, profile });
        return {
          content: [{ type: "text" as const, text: viewSummary(data) }],
          structuredContent: data as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return fail(err);
      }
    }
  );

  const linkTool = server.registerTool(
    NETWORK_LINK_TOOL,
    {
      title: "Create connection link",
      description:
        "Create the link that opens the connection page for one social network of a profile. Called by the social accounts view when the user clicks a network.",
      inputSchema: {
        platform: z.enum(NETWORK_IDS).describe("Network the user clicked."),
        profile: z.string().optional().describe("Profile shown in the view; omitted when the account has none yet."),
      },
      annotations: {
        title: "Create connection link",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
      },
      // Only the view calls it, at click time.
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => {
      const { platform, profile } = args as { platform: string; profile?: string };
      const network = NETWORK_BY_ID.get(normalizePlatform(platform));
      if (!network) return fail(`Unknown network "${platform}".`);
      if (network.id === "reddit" && !REDDIT_ENABLED) return fail(REDDIT_UNAVAILABLE);
      // OAuth networks get a page with only their card. Credential networks
      // open the full page, where their form lives.
      const link = await resolveConnectLink(client, {
        profile,
        platforms: network.mode === "oauth" ? [network.id] : undefined,
      });
      // The open of a connection link from the chat, which nothing recorded before.
      process.stderr.write(
        `[upload-post-mcp] connect-link opened platform=${network.id} signed=${link.signed} ` +
          `created_profile=${link.created_profile === true} client=${ctx.profile?.name ?? "unknown"}\n`
      );
      return ok({ platform: network.id, mode: network.mode, ...link });
    }
  );

  return { tool, linkTool, resource };
}

// --- the view ---------------------------------------------------------------

const networksViewHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Your social accounts</title>
<style>
  :root {
    --bg: var(--color-background-primary, #ffffff);
    --bg2: var(--color-background-secondary, #f5f5f4);
    --fg: var(--color-text-primary, #1c1917);
    --fg2: var(--color-text-secondary, #57534e);
    --line: var(--color-border-primary, #e7e5e4);
    --ok: var(--color-text-success, #15803d);
    --warn: var(--color-text-warning, #b45309);
    --danger: var(--color-text-danger, #b91c1c);
    --accent: #2563eb;
    --radius: var(--border-radius-md, 10px);
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: var(--color-background-primary, #1c1917);
      --bg2: var(--color-background-secondary, #292524);
      --fg: var(--color-text-primary, #fafaf9);
      --fg2: var(--color-text-secondary, #a8a29e);
      --line: var(--color-border-primary, #44403c);
      --ok: var(--color-text-success, #4ade80);
      --warn: var(--color-text-warning, #fbbf24);
      --danger: var(--color-text-danger, #f87171);
      --accent: #60a5fa;
    }
  }
  :root[data-theme="dark"] {
    --bg: var(--color-background-primary, #1c1917);
    --bg2: var(--color-background-secondary, #292524);
    --fg: var(--color-text-primary, #fafaf9);
    --fg2: var(--color-text-secondary, #a8a29e);
    --line: var(--color-border-primary, #44403c);
    --ok: var(--color-text-success, #4ade80);
    --warn: var(--color-text-warning, #fbbf24);
    --danger: var(--color-text-danger, #f87171);
    --accent: #60a5fa;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--fg); }
  body { font: 14px/1.4 var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif); padding: 14px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
  h1 { font-size: 15px; margin: 0; font-weight: 600; }
  select { font: inherit; color: var(--fg); background: var(--bg2); border: 1px solid var(--line); border-radius: 8px; padding: 4px 8px; max-width: 100%; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
  .card { display: flex; flex-direction: column; gap: 6px; padding: 10px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg); min-width: 0; }
  .card.hl { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
  .card.connected { background: var(--bg2); }
  .row { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .logo { flex: none; width: 26px; height: 26px; border-radius: 7px; display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 12px; }
  .name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .state { font-size: 12px; color: var(--fg2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .state.connected { color: var(--ok); }
  .state.reconnect { color: var(--warn); }
  button { font: inherit; cursor: pointer; border-radius: 8px; padding: 5px 10px; border: 1px solid var(--line); background: var(--bg2); color: var(--fg); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button:disabled { opacity: .6; cursor: default; }
  details { margin-top: 10px; }
  summary { cursor: pointer; color: var(--fg2); margin-bottom: 8px; }
  #status { margin-top: 10px; font-size: 13px; color: var(--fg2); min-height: 1em; }
  #status.error { color: var(--danger); }
  #status a { color: var(--accent); word-break: break-all; }
  #actions { margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap; }
  #actions:empty { display: none; }
  .hint { font-size: 12px; color: var(--fg2); margin: 0 0 10px; }
</style>
</head>
<body>
<header>
  <h1>Your social accounts</h1>
  <select id="profile" hidden aria-label="Profile"></select>
</header>
<p class="hint" id="hint">Loading…</p>
<div class="grid" id="main"></div>
<details id="moreBox" hidden><summary id="moreLabel">More networks</summary><div class="grid" id="more"></div></details>
<div id="status" role="status" aria-live="polite"></div>
<div id="actions"></div>
<script>
(function () {
  "use strict";
  var NETWORKS = ${JSON.stringify(NETWORKS)};
  var POLL = ${JSON.stringify(POLL)};
  var VIEW_TOOL = ${JSON.stringify(NETWORKS_TOOL)};
  var LINK_TOOL = ${JSON.stringify(NETWORK_LINK_TOOL)};
  ${pollDecision.toString()}

  var byId = {};
  NETWORKS.forEach(function (n) { byId[n.id] = n; });
  var $ = function (id) { return document.getElementById(id); };

  // --- MCP Apps bridge: JSON-RPC over postMessage with the host -----------
  var nextId = 1;
  var waiting = {};
  var hostCaps = {};
  function post(msg) { window.parent.postMessage(msg, "*"); }
  function request(method, params, timeoutMs) {
    var id = nextId++;
    post({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    return new Promise(function (resolve, reject) {
      waiting[id] = { resolve: resolve, reject: reject };
      setTimeout(function () {
        if (waiting[id]) { delete waiting[id]; reject(new Error("The chat did not answer in time.")); }
      }, timeoutMs || 60000);
    });
  }
  function notify(method, params) { post({ jsonrpc: "2.0", method: method, params: params || {} }); }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var m = event.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.method === undefined && m.id !== undefined) {
      var w = waiting[m.id];
      if (!w) return;
      delete waiting[m.id];
      if (m.error) w.reject(new Error(m.error.message || "Request failed")); else w.resolve(m.result || {});
      return;
    }
    if (m.id !== undefined) {
      if (m.method === "ping" || m.method === "ui/resource-teardown") post({ jsonrpc: "2.0", id: m.id, result: {} });
      else post({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
      return;
    }
    if (m.method === "ui/notifications/tool-input") toolArgs = (m.params && m.params.arguments) || {};
    else if (m.method === "ui/notifications/tool-result") onToolResult(m.params || {});
    else if (m.method === "ui/notifications/host-context-changed") applyContext(m.params || {});
  });

  function applyContext(ctx) {
    if (ctx.theme === "dark" || ctx.theme === "light") document.documentElement.setAttribute("data-theme", ctx.theme);
    var vars = ctx.styles && ctx.styles.variables;
    if (vars) Object.keys(vars).forEach(function (k) { if (vars[k]) document.documentElement.style.setProperty(k, vars[k]); });
  }

  function callTool(name, args) {
    return request("tools/call", { name: name, arguments: args }).then(function (res) {
      if (res && res.isError) throw new Error(textOf(res) || "The request failed.");
      return res;
    });
  }
  function textOf(res) {
    return ((res && res.content) || []).map(function (c) { return c && c.type === "text" ? c.text : ""; }).join(" ").trim();
  }
  function compact(obj) {
    var out = {};
    Object.keys(obj).forEach(function (k) { if (obj[k] !== undefined && obj[k] !== null) out[k] = obj[k]; });
    return out;
  }

  // --- state ---------------------------------------------------------------
  var toolArgs = {};
  var data = null;
  var selected = null;
  var watching = {};       // network id -> true while we wait for it
  var connectedHere = [];  // networks connected from this view
  var poll = null;         // { startedAt, polls, timer }
  var totalPolls = 0;

  function accountsOf(d, profile) {
    var p = d && d.profiles && d.profiles.filter(function (x) { return x.profile === profile; })[0];
    return (p && p.accounts) || {};
  }
  function stateOf(accounts, id) {
    var a = accounts[id];
    if (id === "reddit" && data && !data.reddit_available && !(a && a.state === "connected")) return "unavailable";
    if (a) return a.state;
    return "not_connected";
  }

  function onToolResult(result) {
    var sc = result.structuredContent;
    if (!sc || sc.view !== "social_accounts") {
      $("hint").textContent = textOf(result) || "Nothing to show.";
      return;
    }
    data = sc;
    if (!selected) selected = sc.selected;
    render();
  }

  // --- rendering -------------------------------------------------------------
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function card(n, accounts, highlighted) {
    var st = stateOf(accounts, n.id);
    var c = el("div", "card" + (highlighted ? " hl" : "") + (st === "connected" ? " connected" : ""));
    var row = el("div", "row");
    var logo = el("div", "logo", n.label.charAt(0));
    logo.style.background = n.color;
    logo.setAttribute("aria-hidden", "true");
    var who = el("div");
    who.style.minWidth = "0";
    who.appendChild(el("div", "name", n.label));
    var a = accounts[n.id];
    var text = st === "connected" ? "Connected" + (a && a.name ? " · " + a.name : "")
      : st === "reconnect" ? "Needs reconnecting"
      : st === "unavailable" ? "Unavailable right now"
      : watching[n.id] ? "Waiting for the connection…" : "Not connected";
    who.appendChild(el("div", "state " + st, text));
    row.appendChild(logo);
    row.appendChild(who);
    c.appendChild(row);
    if (st === "not_connected" || st === "reconnect") {
      var b = el("button", highlighted || st === "reconnect" ? "primary" : "", st === "reconnect" ? "Reconnect" : "Connect");
      b.type = "button";
      b.setAttribute("aria-label", (st === "reconnect" ? "Reconnect " : "Connect ") + n.label);
      b.addEventListener("click", function () { connect(n, b); });
      c.appendChild(b);
    }
    return c;
  }

  function render() {
    if (!data) return;
    var sel = $("profile");
    if (data.profiles.length > 1) {
      sel.hidden = false;
      sel.textContent = "";
      data.profiles.forEach(function (p) {
        var o = el("option", "", p.profile);
        o.value = p.profile;
        if (p.profile === selected) o.selected = true;
        sel.appendChild(o);
      });
    } else sel.hidden = true;

    var accounts = accountsOf(data, selected);
    var hl = data.highlight || [];
    $("hint").textContent = !selected
      ? "No network is connected yet. Pick one to connect it; it opens in a new tab."
      : data.one_click
        ? "Each button opens that network's connection page in a new tab. Come back here when you are done."
        : "Each button opens Upload-Post in a new tab, where you sign in and connect the network.";

    var main = $("main"), more = $("more");
    main.textContent = "";
    more.textContent = "";
    var ordered = hl.map(function (id) { return byId[id]; }).filter(Boolean)
      .concat(NETWORKS.filter(function (n) { return hl.indexOf(n.id) < 0; }));
    var extra = 0;
    ordered.forEach(function (n) {
      var inMain = n.featured || hl.indexOf(n.id) >= 0 || accounts[n.id] || watching[n.id];
      if (inMain) main.appendChild(card(n, accounts, hl.indexOf(n.id) >= 0));
      else { more.appendChild(card(n, accounts, false)); extra++; }
    });
    // Networks the account has that this view does not know yet.
    Object.keys(accounts).forEach(function (id) {
      if (!byId[id]) main.appendChild(card({ id: id, label: id, color: "#78716c", featured: true, mode: "oauth" }, accounts, false));
    });
    $("moreBox").hidden = extra === 0;
    $("moreLabel").textContent = "More networks (" + extra + ")";
  }

  $("profile").addEventListener("change", function (e) {
    selected = e.target.value;
    watching = {};
    stopPolling();
    render();
  });

  function setStatus(text, isError) {
    var s = $("status");
    s.className = isError ? "error" : "";
    s.textContent = text || "";
  }

  // --- connecting --------------------------------------------------------------
  function openLink(url) {
    if (window.openai && typeof window.openai.openExternal === "function") {
      window.openai.openExternal({ href: url });
      return Promise.resolve(true);
    }
    var fallback = function () {
      var w = null;
      try { w = window.open(url, "_blank", "noopener"); } catch (e) { w = null; }
      return !!w;
    };
    if (hostCaps.openLinks) {
      return request("ui/open-link", { url: url }, 120000).then(function () { return true; }, fallback);
    }
    return Promise.resolve(fallback());
  }

  function showLink(url, label) {
    var s = $("status");
    s.className = "";
    s.textContent = "If no tab opened, use this link to connect " + label + ": ";
    var a = el("a", "", url);
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    s.appendChild(a);
  }

  function connect(n, button) {
    var original = button.textContent;
    button.disabled = true;
    button.textContent = "Opening…";
    setStatus("");
    // The link is created now, on the click: creating it earlier would let a
    // second card overwrite the first one's network.
    callTool(LINK_TOOL, compact({ platform: n.id, profile: selected || undefined }))
      .then(function (res) {
        var r = res.structuredContent && res.structuredContent.result;
        if (!r || !r.connect_url) throw new Error(textOf(res) || "No link came back.");
        if (!selected && r.profile) selected = r.profile;
        return openLink(r.connect_url).then(function (opened) {
          if (opened) setStatus(n.label + " opened in a new tab. Finish there; this card turns green once it is connected.");
          else showLink(r.connect_url, n.label);
          watching[n.id] = true;
          startPolling();
          render();
        });
      })
      .catch(function (e) { setStatus("Could not open " + n.label + ": " + e.message, true); })
      .then(function () { button.disabled = false; button.textContent = original; });
  }

  // --- auto-refresh, capped ------------------------------------------------------
  function pendingCount() {
    var accounts = accountsOf(data, selected);
    return Object.keys(watching).filter(function (id) { return stateOf(accounts, id) !== "connected"; }).length;
  }
  function startPolling() {
    if (poll && poll.timer) clearTimeout(poll.timer);
    poll = { startedAt: Date.now(), polls: 0, timer: null };
    schedule();
  }
  function stopPolling() {
    if (poll && poll.timer) clearTimeout(poll.timer);
    poll = null;
  }
  function schedule() {
    if (!poll) return;
    poll.timer = setTimeout(tick, POLL.intervalMs);
  }
  function tick() {
    if (!poll) return;
    var decision = pollDecision({ startedAt: poll.startedAt, polls: poll.polls, total: totalPolls, pending: pendingCount() }, Date.now(), POLL);
    if (decision !== "poll") {
      stopPolling();
      if (decision === "limit") offerManualCheck();
      return;
    }
    poll.polls++;
    totalPolls++;
    refresh().then(schedule, schedule);
  }
  function refresh() {
    return callTool(VIEW_TOOL, compact({ profile: selected || undefined, platforms: toolArgs.platforms }))
      .then(function (res) {
        var sc = res.structuredContent;
        if (!sc || sc.view !== "social_accounts") return;
        var before = accountsOf(data, selected);
        data = sc;
        if (!selected) selected = sc.selected;
        var after = accountsOf(data, selected);
        var fresh = Object.keys(after).filter(function (id) {
          return after[id].state === "connected" && stateOf(before, id) !== "connected";
        });
        fresh.forEach(function (id) {
          delete watching[id];
          if (connectedHere.indexOf(id) < 0) connectedHere.push(id);
        });
        render();
        if (fresh.length) onConnected(fresh);
      });
  }
  function offerManualCheck() {
    var box = $("actions");
    if ($("checkAgain")) return;
    var b = el("button", "", "Check again");
    b.id = "checkAgain";
    b.type = "button";
    b.addEventListener("click", function () {
      b.remove();
      if (totalPolls >= POLL.maxTotalPolls) { setStatus("Stopped checking. Tell the assistant when you are done."); return; }
      totalPolls++;
      refresh().then(function () { if (pendingCount() > 0) startPolling(); });
    });
    box.appendChild(b);
    setStatus("Stopped checking automatically. Click \\u201cCheck again\\u201d when you have finished connecting.");
  }

  // --- telling the conversation ---------------------------------------------------
  function names(ids) { return ids.map(function (id) { return byId[id] ? byId[id].label : id; }).join(", "); }

  function onConnected(fresh) {
    var accounts = accountsOf(data, selected);
    var connected = Object.keys(accounts).filter(function (id) { return accounts[id].state === "connected"; });
    var reconnect = Object.keys(accounts).filter(function (id) { return accounts[id].state === "reconnect"; });
    setStatus(names(fresh) + " connected.");
    // Context for the model's next turn; no message is sent without a click.
    request("ui/update-model-context", {
      content: [{ type: "text", text:
        "From the social accounts view, the user connected " + names(connectedHere) + " to the Upload-Post profile \\"" + selected + "\\". " +
        "Profile \\"" + selected + "\\" can now publish to: " + (names(connected) || "none") + "." +
        (reconnect.length ? " Still needs reconnecting: " + names(reconnect) + "." : "") }],
      structuredContent: { profile: selected, connected: connected, reconnect_required: reconnect, connected_from_view: connectedHere.slice() }
    }).catch(function () {});
    var box = $("actions");
    var b = $("continue");
    if (!b) {
      b = el("button", "primary", "");
      b.id = "continue";
      b.type = "button";
      b.addEventListener("click", function () {
        b.disabled = true;
        request("ui/message", { role: "user", content: [{ type: "text", text:
          "I've connected " + names(connectedHere) + " to Upload-Post (profile \\"" + selected + "\\"). Let's continue." }] })
          .then(function (res) {
            if (res && res.isError) { b.disabled = false; return; }
            b.textContent = "Sent";
          }, function () { b.disabled = false; });
      });
      box.appendChild(b);
    }
    b.disabled = false;
    b.textContent = "Continue in the chat";
  }

  // --- size and start ------------------------------------------------------------
  var lastH = 0;
  function reportSize() {
    var h = Math.ceil(document.documentElement.scrollHeight);
    if (h === lastH) return;
    lastH = h;
    notify("ui/notifications/size-changed", { width: Math.ceil(document.documentElement.scrollWidth), height: h });
  }
  if (typeof ResizeObserver === "function") new ResizeObserver(reportSize).observe(document.body);

  request("ui/initialize", {
    appInfo: { name: "Upload-Post social accounts", version: "1.0.0" },
    appCapabilities: {},
    protocolVersion: "2026-01-26"
  }).then(function (res) {
    hostCaps = res.hostCapabilities || {};
    applyContext(res.hostContext || {});
  }, function () {}).then(function () {
    notify("ui/notifications/initialized", {});
    reportSize();
  });
})();
</script>
</body>
</html>`;

/** For tests: the HTML the host renders. */
export function networksViewHtmlForTests(): string {
  return networksViewHtml;
}
