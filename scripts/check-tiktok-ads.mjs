#!/usr/bin/env node
/**
 * Regression check for the TikTok Ads tools (tiktok_ads_read, manage_tiktok_ads):
 *   - ChatGPT does not see them (its surface is the reviewed one);
 *   - each action hits the documented route with the API's field names, and the
 *     ad account choice goes in the query string;
 *   - everything is created paused unless the user asks for active, and a boost
 *     also pauses its ad group and ad;
 *   - what can spend money or cannot be undone (resume, delete, disconnect,
 *     budget changes, active creates) is behind the confirmation step; deletes
 *     also need the API's confirm: true; pausing and paused drafts run at once;
 *   - the Spark authorization of the profile's own post is not offered.
 * The HTTP layer is replaced by an in-memory fake. Run after `npm run build`.
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { UploadPostMcpClient } from "../dist/client.js";

const T = "/uploadposts/ads/tiktok";

async function connect(name) {
  const calls = [];
  const upClient = new UploadPostMcpClient({ apiKey: "test", baseUrl: "https://example.invalid/api" });
  upClient.http.request = async (cfg) => {
    calls.push(cfg);
    return { status: 200, data: { success: true } };
  };
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

const last = (s) => s.calls[s.calls.length - 1];
const isPreview = (r) => r.structuredContent?.result?.status === "confirmation_required";

// --- ChatGPT keeps its reviewed surface -----------------------------------------
{
  const s = await connect("openai-mcp");
  for (const name of ["tiktok_ads_read", "manage_tiktok_ads"]) assert.ok(!s.tools.has(name), `ChatGPT must not see ${name} yet`);
  await s.close();
}

const s = await connect("claude-ai");
const read = s.tools.get("tiktok_ads_read");
const manage = s.tools.get("manage_tiktok_ads");
assert.ok(read && manage, "claude-ai sees both TikTok Ads tools");
assert.equal(read.annotations.readOnlyHint, true);
assert.equal(manage.annotations.destructiveHint, true);
assert.match(manage.description, /spend the user's money/);
assert.match(manage.description, /created PAUSED/);
assert.match(manage.description, /Upload-Post never does/);
for (const tool of [read, manage]) {
  assert.doesNotMatch(tool.description, /https?:\/\//, `${tool.name}: no URLs in the description`);
  assert.doesNotMatch(tool.description, /authoriz\w*-post|biz\.spark|post_auth_code|Not generally available/, `${tool.name}: nothing that is not offered`);
}
assert.ok(!manage.inputSchema.properties.action.enum.includes("authorize_post"), "no Spark authorization of the own post");

// --- Reads ----------------------------------------------------------------------
s.calls.length = 0;
let r = await s.call("tiktok_ads_read", { action: "spark_posts", profile_username: "my-profile", params: { identity_id: "id-1", count: 20 } });
assert.ok(!r.isError, JSON.stringify(r.content));
assert.equal(last(s).method, "GET");
assert.equal(last(s).url, `${T}/spark/posts`);
assert.deepEqual(last(s).params, { profile_username: "my-profile", identity_id: "id-1", count: 20 });

r = await s.call("tiktok_ads_read", { action: "ads", advertiser_id: "7300", campaign_id: "c1", ad_id: "stray" });
assert.equal(last(s).url, `${T}/ads`);
assert.deepEqual(last(s).params, { advertiser_id: "7300", campaign_id: "c1" }, "a list filters by its parents only");

r = await s.call("tiktok_ads_read", { action: "campaign_insights", campaign_id: "c/1", params: { breakdown: "day", start_date: "2026-11-18" } });
assert.equal(last(s).url, `${T}/campaigns/c%2F1/insights`);
assert.deepEqual(last(s).params, { breakdown: "day", start_date: "2026-11-18" });

r = await s.call("tiktok_ads_read", { action: "ad_insights" });
assert.ok(r.isError, "ad_insights needs ad_id");

// --- Creates: paused by default -------------------------------------------------
s.calls.length = 0;
const boost = {
  identity_id: "5f39abca-0000-4000-8000-000000000001", post_id: "7311111111111111111", goal: "reach",
  budget: { amount: 20, type: "daily" }, targeting: { countries: ["ES"] },
};
r = await s.call("manage_tiktok_ads", { action: "boost", profile_username: "my-profile", params: boost });
assert.ok(!isPreview(r) && !r.isError, "a paused boost spends nothing: no confirmation");
assert.equal(last(s).method, "POST");
assert.equal(last(s).url, `${T}/boost`);
assert.deepEqual(last(s).params, { profile_username: "my-profile" });
assert.deepEqual(last(s).data, { ...boost, status: "paused", pause_all_levels: true }, "boost: campaign, ad group and ad paused");

r = await s.call("manage_tiktok_ads", { action: "boost", params: { ...boost, pause_all_levels: false } });
assert.equal(last(s).data.pause_all_levels, false, "the user can keep only the campaign paused");

s.calls.length = 0;
r = await s.call("manage_tiktok_ads", { action: "boost", params: { ...boost, status: "active" } });
assert.ok(isPreview(r), "an active boost spends money");
assert.match(r.structuredContent.result.action, /STARTS.*7311111111111111111.*TikTok charges/);
assert.equal(s.calls.length, 0, "nothing sent before confirmation");
r = await s.call("manage_tiktok_ads", { action: "boost", params: { ...boost, status: "active" }, confirmed: true });
assert.deepEqual(last(s).data, { ...boost, status: "active" }, "an approved active boost is sent as asked (no pause_all_levels)");

r = await s.call("manage_tiktok_ads", { action: "create_adgroup", campaign_id: "c1", ad_id: "stray", params: { name: "ES", goal: "reach", budget: { amount: 25 }, targeting: { countries: ["ES"] } } });
assert.ok(!isPreview(r));
assert.equal(last(s).url, `${T}/adgroups`);
assert.deepEqual(last(s).data, { name: "ES", goal: "reach", budget: { amount: 25 }, targeting: { countries: ["ES"] }, campaign_id: "c1", status: "paused" });

r = await s.call("manage_tiktok_ads", { action: "create_ad", adgroup_id: "g1", params: { name: "Ad", identity_id: "id-1", post_id: "p1" } });
assert.deepEqual(last(s).data, { name: "Ad", identity_id: "id-1", post_id: "p1", adgroup_id: "g1", status: "paused" });

// --- Status, edits and deletes --------------------------------------------------
s.calls.length = 0;
r = await s.call("manage_tiktok_ads", { action: "pause_campaign", campaign_id: "c1", advertiser_id: "7300" });
assert.ok(!isPreview(r) && !r.isError, "pausing stops spending: no confirmation");
assert.equal(last(s).url, `${T}/campaigns/c1/pause`);
assert.deepEqual(last(s).params, { advertiser_id: "7300" });

s.calls.length = 0;
r = await s.call("manage_tiktok_ads", { action: "resume_campaign", campaign_id: "c1" });
assert.ok(isPreview(r), "resume needs confirmation");
assert.match(r.structuredContent.result.action, /start spending/);
assert.equal(s.calls.length, 0);
r = await s.call("manage_tiktok_ads", { action: "resume_campaign", campaign_id: "c1", confirmed: true });
assert.equal(last(s).url, `${T}/campaigns/c1/resume`);

r = await s.call("manage_tiktok_ads", { action: "update_adgroup", adgroup_id: "g1", params: { budget: 40 } });
assert.ok(isPreview(r), "a budget change needs confirmation");
r = await s.call("manage_tiktok_ads", { action: "update_ad", ad_id: "a1", params: { name: "New name" } });
assert.ok(!isPreview(r), "renaming spends nothing");
assert.equal(last(s).method, "PATCH");
assert.equal(last(s).url, `${T}/ads/a1`);
assert.deepEqual(last(s).data, { name: "New name" });

s.calls.length = 0;
r = await s.call("manage_tiktok_ads", { action: "delete_ad", ad_id: "a1" });
assert.ok(isPreview(r), "delete needs confirmation");
r = await s.call("manage_tiktok_ads", { action: "delete_ad", ad_id: "a1", confirmed: true });
assert.ok(r.isError, "delete also needs the API's confirm: true");
assert.equal(s.calls.length, 0);
r = await s.call("manage_tiktok_ads", { action: "delete_ad", ad_id: "a1", confirm: true, confirmed: true });
assert.equal(last(s).url, `${T}/ads/a1/delete`);
assert.deepEqual(last(s).data, { confirm: true });

r = await s.call("manage_tiktok_ads", { action: "delete_audience", audience_id: "aud1", confirm: true, confirmed: true });
assert.equal(last(s).url, `${T}/audiences/aud1/delete`);

// --- Connection -----------------------------------------------------------------
r = await s.call("manage_tiktok_ads", { action: "connect", profile_username: "my-profile" });
assert.ok(!isPreview(r), "the authorization link spends nothing");
assert.equal(last(s).url, `${T}/connect`);
assert.deepEqual(last(s).params, { profile_username: "my-profile" });

s.calls.length = 0;
r = await s.call("manage_tiktok_ads", { action: "disconnect", advertiser_id: "7300", profile_username: "my-profile" });
assert.ok(isPreview(r), "disconnecting needs confirmation");
assert.match(r.structuredContent.result.action, /Unlinks TikTok ad account 7300 from profile "my-profile"/);
r = await s.call("manage_tiktok_ads", { action: "disconnect", advertiser_id: "7300", profile_username: "my-profile", confirmed: true });
assert.equal(last(s).method, "DELETE");
assert.equal(last(s).url, `${T}/accounts/7300`);
assert.deepEqual(last(s).params, { profile_username: "my-profile" });

await s.close();
console.log("check-tiktok-ads: ok");
