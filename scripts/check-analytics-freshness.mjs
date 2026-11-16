#!/usr/bin/env node
/**
 * Regression check for the analytics freshness changes:
 *   - get_post_analytics: `refresh` and `daily` (+ since/until) for every client
 *     but ChatGPT; requestId alone keeps the SDK path; `daily` with requestId
 *     needs `platform` and is refused before any call otherwise;
 *   - the "fetches the metrics live" sentence is rewritten for every client but
 *     ChatGPT, which keeps the reviewed description byte for byte;
 *   - get_cached_post_analytics: `sort`, `order`, `date_field`, `origin`;
 *   - get_analytics: `since` / `until` / `compare` go by raw HTTP (the SDK
 *     forwards a fixed list of parameters), without them the SDK path;
 *   - get_insights and get_analytics_status: read-only, hidden from ChatGPT.
 * The SDK and HTTP layer are replaced by in-memory fakes. Run after `npm run build`.
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { UploadPostMcpClient } from "../dist/client.js";
import { POST_ANALYTICS_LIVE_SENTENCE } from "../dist/tools/analytics.js";

async function connect(name) {
  const calls = [];
  const upClient = new UploadPostMcpClient({ apiKey: "test", baseUrl: "https://example.invalid/api" });
  upClient.http.request = async (cfg) => {
    calls.push(["http", cfg.method, cfg.url, cfg.params]);
    return { status: 200, data: { success: true } };
  };
  for (const method of ["getPostAnalytics", "getPostAnalyticsByPlatformId", "getAnalytics"]) {
    upClient.sdk[method] = async (...args) => {
      calls.push([`sdk.${method}`, ...args]);
      return { success: true };
    };
  }
  const server = buildServer(upClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name, version: "0.0.0-test" });
  await client.connect(clientTransport);
  const tools = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
  return {
    calls,
    tools,
    call: (toolName, args) => client.callTool({ name: toolName, arguments: args }),
    async close() {
      await client.close();
      await server.close();
    },
  };
}

const NEW_TOOLS = ["get_insights", "get_analytics_status"];

// --- ChatGPT: the reviewed surface, untouched ---------------------------------------
{
  const s = await connect("openai-mcp");
  for (const name of NEW_TOOLS) assert.ok(!s.tools.has(name), `ChatGPT must not see ${name} yet`);
  const post = s.tools.get("get_post_analytics");
  assert.ok(post.description.includes(POST_ANALYTICS_LIVE_SENTENCE), "ChatGPT keeps the reviewed sentence");
  for (const key of ["refresh", "daily", "since", "until"]) {
    assert.ok(!(key in post.inputSchema.properties), `ChatGPT get_post_analytics has no ${key} yet`);
  }
  const cached = s.tools.get("get_cached_post_analytics");
  for (const key of ["sort", "order", "date_field", "origin"]) {
    assert.ok(!(key in cached.inputSchema.properties), `ChatGPT get_cached_post_analytics has no ${key} yet`);
  }
  assert.ok(!("since" in s.tools.get("get_analytics").inputSchema.properties));
  await s.close();
}

const s = await connect("claude-ai");
const last = () => s.calls.at(-1);

// --- descriptions -----------------------------------------------------------------
const post = s.tools.get("get_post_analytics");
assert.ok(!post.description.includes("fetches the metrics live"), "no more 'fetches the metrics live'");
for (const word of ["as_of", "next_refresh_at", "served_from", "refresh: true", "missing", "avg_watch_seconds", "daily: true", "do not poll"]) {
  assert.ok(post.description.includes(word), `get_post_analytics description mentions ${word}`);
}
assert.match(post.description, /TikTok drafts/, "the rest of the description is kept");
const cached = s.tools.get("get_cached_post_analytics");
for (const word of ["as_of", "origin", "sort", "date_field", "request_id", "caption_preview"]) {
  assert.ok(cached.description.includes(word), `get_cached_post_analytics description mentions ${word}`);
}
assert.ok(!/there is no background refresh, so `captured_at`/.test(cached.description));
assert.match(s.tools.get("get_analytics").description, /views_field/);
assert.match(s.tools.get("get_total_impressions").description, /views_total/);
// Public repo: tool text never names storage internals.
for (const tool of s.tools.values()) {
  assert.ok(!/mongo|redis|uploadposts_[a-z_]+_snapshots|collection/i.test(tool.description ?? ""), `${tool.name}: no internals`);
}

// --- get_post_analytics -------------------------------------------------------------
s.calls.length = 0;
let r = await s.call("get_post_analytics", { requestId: "req1" });
assert.ok(!r.isError);
assert.deepEqual(last(), ["sdk.getPostAnalytics", "req1"], "requestId alone keeps the SDK path");

r = await s.call("get_post_analytics", { requestId: "req1", refresh: true });
assert.ok(!r.isError);
assert.deepEqual(last(), ["http", "GET", "/uploadposts/post-analytics/req1", { refresh: "true" }]);

r = await s.call("get_post_analytics", { requestId: "req1", platform: "x", refresh: false });
assert.deepEqual(last(), ["http", "GET", "/uploadposts/post-analytics/req1", { platform: "x" }], "refresh false is not sent");

r = await s.call("get_post_analytics", { requestId: "req1", platform: "tiktok", daily: true, since: "2026-11-01" });
assert.ok(!r.isError);
assert.deepEqual(last(), ["http", "GET", "/uploadposts/post-analytics/req1/daily", { platform: "tiktok", since: "2026-11-01" }]);

s.calls.length = 0;
r = await s.call("get_post_analytics", { requestId: "req1", daily: true });
assert.ok(r.isError, "daily with requestId needs platform");
assert.equal(s.calls.length, 0, "refused before any call");

r = await s.call("get_post_analytics", { platformPostId: "7300", platform: "tiktok", user: "brand", daily: true, until: "2026-11-15" });
assert.ok(!r.isError);
assert.deepEqual(last(), ["http", "GET", "/uploadposts/post-analytics/daily", { platform_post_id: "7300", platform: "tiktok", user: "brand", until: "2026-11-15" }]);

r = await s.call("get_post_analytics", { platformPostId: "7300", platform: "youtube", user: "brand", refresh: true });
assert.deepEqual(last(), ["http", "GET", "/uploadposts/post-analytics", { platform_post_id: "7300", platform: "youtube", user: "brand", refresh: "true" }]);

r = await s.call("get_post_analytics", { platformPostId: "7300", platform: "youtube", user: "brand" });
assert.deepEqual(last(), ["sdk.getPostAnalyticsByPlatformId", "7300", "youtube", "brand"], "without the new keys, the SDK path as before");

// --- get_cached_post_analytics ---------------------------------------------------
r = await s.call("get_cached_post_analytics", { user: "brand", platform: "x", sort: "-views", date_field: "published_at", origin: "all", limit: 20 });
assert.ok(!r.isError, JSON.stringify(r.content));
assert.deepEqual(last(), ["http", "GET", "/uploadposts/post-analytics/cached", { user: "brand", platform: "x", sort: "-views", date_field: "published_at", origin: "all", limit: 20 }]);
r = await s.call("get_cached_post_analytics", { user: "brand", origin: "upload_post" });
assert.ok(r.isError, "origin only accepts external or all");

// --- get_analytics -------------------------------------------------------------------
r = await s.call("get_analytics", { profileUsername: "brand", platforms: ["tiktok", "youtube"] });
assert.deepEqual(last(), ["sdk.getAnalytics", "brand", { platforms: ["tiktok", "youtube"] }], "no period: SDK path");
r = await s.call("get_analytics", { profileUsername: "brand", platforms: ["tiktok", "youtube"], since: "2026-10-17", until: "2026-11-15", compare: "previous" });
assert.ok(!r.isError);
assert.deepEqual(last(), ["http", "GET", "/analytics/brand", { platforms: "tiktok,youtube", since: "2026-10-17", until: "2026-11-15", compare: "previous" }]);

// --- new tools -------------------------------------------------------------------------
for (const name of NEW_TOOLS) {
  const tool = s.tools.get(name);
  assert.ok(tool, `claude-ai sees ${name}`);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
}
assert.deepEqual(s.tools.get("get_insights").inputSchema.required, ["user"]);
r = await s.call("get_insights", { user: "brand", platform: "tiktok", since: "2026-10-01" });
assert.ok(!r.isError);
assert.deepEqual(last(), ["http", "GET", "/uploadposts/insights", { user: "brand", platform: "tiktok", since: "2026-10-01" }]);
r = await s.call("get_analytics_status", {});
assert.ok(!r.isError);
assert.deepEqual(last(), ["http", "GET", "/uploadposts/analytics-status", {}]);

await s.close();
console.log("check-analytics-freshness: ok");
