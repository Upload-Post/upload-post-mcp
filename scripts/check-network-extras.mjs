#!/usr/bin/env node
/**
 * Regression check for what the API switched on in production on 2026-11-25:
 * Facebook Page reads and video captions, the Pinterest API v5 gateway,
 * Instagram stories and tagged posts, Threads ghost posts, X mentions, reads,
 * lists and actions, WhatsApp extras, TikTok image comments and trending
 * searches.
 *   - ChatGPT sees none of it (its surface is the reviewed one);
 *   - each tool hits the documented route with the API's field names;
 *   - what is still off in production is not offered: Pinterest catalogs,
 *     beta, search and terms; X reposts_of_me and X DMs; LinkedIn reactions;
 *   - irreversible or public changes wait for the confirmation step.
 * The HTTP layer is replaced by an in-memory fake. Run after `npm run build`.
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { UploadPostMcpClient } from "../dist/client.js";

const NEW_TOOLS = [
  "facebook_page_read",
  "manage_facebook_video_captions",
  "pinterest_api_read",
  "manage_pinterest_api",
  "instagram_account_read",
  "get_threads_ghost_posts",
  "x_read",
  "manage_x_lists",
  "manage_whatsapp_number",
  "manage_whatsapp_flows",
];

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
const props = (s, tool) => s.tools.get(tool).inputSchema.properties;

// --- ChatGPT keeps its reviewed surface ----------------------------------------
{
  const s = await connect("openai-mcp");
  for (const name of NEW_TOOLS) assert.ok(!s.tools.has(name), `ChatGPT must not see ${name} yet`);
  assert.ok(!("imageUrl" in props(s, "create_comment")), "ChatGPT's create_comment is unchanged");
  assert.deepEqual(props(s, "get_suggestions").type.enum, ["hashtags", "keywords"], "ChatGPT's get_suggestions is unchanged");
  assert.ok(!("flow" in props(s, "send_dm")), "ChatGPT's send_dm is unchanged");
  await s.close();
}

const s = await connect("claude-ai");
for (const name of NEW_TOOLS) assert.ok(s.tools.has(name), `claude-ai sees ${name}`);
for (const name of ["facebook_page_read", "pinterest_api_read", "instagram_account_read", "get_threads_ghost_posts", "x_read"]) {
  assert.equal(s.tools.get(name).annotations.readOnlyHint, true, `${name} is read-only`);
}

// Nothing that is still off in production is offered or described.
const touched = JSON.stringify(
  [...NEW_TOOLS, "create_comment", "get_suggestions", "send_dm", "post_action", "save_post", "comment_action", "list_dm_conversations", "manage_whatsapp_templates"].map((t) => s.tools.get(t))
);
for (const off of [/catalog/i, /\bterms\b/, /search\/(pins|boards)/, /product_tags/, /pins\/analytics/]) {
  assert.doesNotMatch(touched, off, `no Pinterest operation that is off (${off})`);
}
const everything = JSON.stringify([...s.tools.values()]);
for (const off of [
  /reposts_of_me/,
  /timeline\.read/,
  /linkedin\/reactions/,
  /instagram\/audio/,
  /threads\/(mentions|search|locations)/,
  /ads\/(meta|tiktok)/,
  /dm\.read|dm\.write|participant_ids/,
]) {
  assert.doesNotMatch(everything, off, `nothing off in production is offered (${off})`);
}
assert.ok(!props(s, "x_read").action.enum.includes("reposts_of_me"));
assert.ok(!props(s, "send_dm").platform?.enum?.includes?.("x"), "no X DMs");

// --- Facebook Pages -------------------------------------------------------------
await s.call("facebook_page_read", { action: "ratings", user: "brand", params: { limit: 10 } });
assert.equal(last(s).method, "GET");
assert.equal(last(s).url, "/uploadposts/facebook/ratings");
assert.deepEqual(last(s).params, { user: "brand", limit: 10 });
await s.call("facebook_page_read", { action: "insights", user: "brand", params: { metric: "page_media_view", object_id: "1_2" } });
assert.equal(last(s).url, "/uploadposts/facebook/insights");
await s.call("facebook_page_read", { action: "video_captions", user: "brand", video_id: "987" });
assert.equal(last(s).url, "/uploadposts/facebook/videos/987/captions");

let n = s.calls.length;
let r = await s.call("manage_facebook_video_captions", { user: "brand", video_id: "987", srt: "1\n00:00:00,000 --> 00:00:01,000\nHi\n", locale: "en_US" });
assert.ok(isPreview(r), "changing captions waits for confirmation");
assert.equal(s.calls.length, n, "nothing sent before confirmation");
await s.call("manage_facebook_video_captions", { user: "brand", video_id: "987", srt: "1\n00:00:00,000 --> 00:00:01,000\nHi\n", locale: "en_US", confirmed: true });
assert.equal(last(s).method, "POST");
assert.equal(last(s).url, "/uploadposts/facebook/videos/987/captions");
assert.equal(typeof last(s).data.getHeaders, "function", "captions go as multipart");
assert.match(last(s).data.getBuffer().toString(), /name="captions_file"; filename="captions.srt"/);

// --- Pinterest ---------------------------------------------------------------------
await s.call("pinterest_api_read", { user: "brand", endpoint: "/user_account/analytics", query: { start_date: "2026-11-01", end_date: "2026-11-24" } });
assert.equal(last(s).url, "/uploadposts/pinterest/api/user_account/analytics");
assert.deepEqual(last(s).params, { start_date: "2026-11-01", end_date: "2026-11-24", user: "brand" });
await s.call("pinterest_api_read", { user: "brand", endpoint: "trends/keywords/US/top/growing" });
assert.equal(last(s).url, "/uploadposts/pinterest/api/trends/keywords/US/top/growing");
for (const endpoint of ["catalogs", "catalogs/feeds", "search/pins", "terms/related", "pins/analytics", "pins/1/product_tags", "merchant/1/status"]) {
  n = s.calls.length;
  r = await s.call("pinterest_api_read", { user: "brand", endpoint });
  assert.equal(r.isError, true, `${endpoint} is not offered`);
  assert.equal(s.calls.length, n, `${endpoint}: nothing sent`);
}
await s.call("manage_pinterest_api", { user: "brand", method: "POST", endpoint: "boards/123/sections", body: { name: "Autumn" } });
assert.equal(last(s).method, "POST");
assert.equal(last(s).url, "/uploadposts/pinterest/api/boards/123/sections");
assert.deepEqual(last(s).data, { name: "Autumn" });
assert.deepEqual(last(s).params, { user: "brand" });
for (const [method, endpoint] of [["PATCH", "pins/1"], ["POST", "user_account/following/someone"], ["POST", "user_account/websites"], ["POST", "catalogs"]]) {
  n = s.calls.length;
  r = await s.call("manage_pinterest_api", { user: "brand", method, endpoint });
  assert.equal(r.isError, true, `${method} ${endpoint} is not offered`);
  assert.equal(s.calls.length, n);
}
n = s.calls.length;
r = await s.call("manage_pinterest_api", { user: "brand", method: "DELETE", endpoint: "boards/123", confirm: true });
assert.ok(isPreview(r), "deleting a board waits for confirmation");
assert.equal(s.calls.length, n);
await s.call("manage_pinterest_api", { user: "brand", method: "DELETE", endpoint: "boards/123", confirm: true, confirmed: true });
assert.equal(last(s).method, "DELETE");
assert.deepEqual(last(s).params, { user: "brand", confirm: true });

// --- Instagram, Threads -----------------------------------------------------------
await s.call("instagram_account_read", { action: "tagged", user: "brand", limit: 10 });
assert.equal(last(s).url, "/uploadposts/instagram/tagged");
assert.deepEqual(last(s).params, { profile: "brand", limit: 10 });
await s.call("get_threads_ghost_posts", { user: "brand", limit: 5 });
assert.equal(last(s).url, "/uploadposts/threads/ghost-posts");

// --- X ------------------------------------------------------------------------------
await s.call("x_read", { action: "mentions", user: "brand", params: { verified_type: "business", limit: 20 } });
assert.equal(last(s).url, "/uploadposts/x/mentions");
assert.deepEqual(last(s).params, { verified_type: "business", limit: 20, user: "brand" });
await s.call("x_read", { action: "search_recent", user: "brand", params: { query: "upload-post" } });
assert.equal(last(s).url, "/uploadposts/x/read/search_recent");
assert.match(s.tools.get("x_read").description, /paid Upload-Post plan/);
n = s.calls.length;
r = await s.call("manage_x_lists", { action: "delete", user: "brand", list_id: "1", confirm: true });
assert.ok(isPreview(r));
await s.call("manage_x_lists", { action: "create", user: "brand", name: "Partners", private: true });
assert.equal(last(s).url, "/uploadposts/x/lists");
assert.deepEqual(last(s).data, { action: "create", user: "brand", name: "Partners", private: true });
await s.call("post_action", { user: "brand", platform: "x", action: "bookmark", post_id: "186", folder_id: "9" });
assert.equal(last(s).url, "/uploadposts/posts/action");
assert.deepEqual(last(s).data, { user: "brand", platform: "x", action: "bookmark", post_id: "186", folder_id: "9" });
n = s.calls.length;
r = await s.call("post_action", { user: "brand", platform: "x", action: "unrepost", post_id: "186" });
assert.ok(isPreview(r), "unrepost changes what others see: confirmation first");
r = await s.call("post_action", { user: "brand", platform: "x", action: "pin", post_id: "186", confirmed: true });
assert.equal(r.isError, true, "pin is not an X action");
await s.call("save_post", { user: "brand", platform: "x", post_id: "186" });
assert.equal(last(s).url, "/uploadposts/posts/save");
await s.call("comment_action", { user: "brand", platform: "x", action: "hide", commentId: "187" });
assert.deepEqual(last(s).data, { platform: "x", user: "brand", comment_id: "187", action: "hide" });
assert.match(s.tools.get("comment_action").description, /tweet\.moderate\.write/);

// --- TikTok ---------------------------------------------------------------------------
await s.call("create_comment", { user: "brand", platform: "tiktok", postId: "740", message: "Size chart", imageUrl: "https://example.com/c.png", confirmed: true });
assert.equal(last(s).data.image_url, "https://example.com/c.png");
await s.call("get_suggestions", { user: "brand", platform: "tiktok", type: "trending", personalized: true });
assert.deepEqual(last(s).params, { user: "brand", platform: "tiktok", type: "trending", personalized: true });
assert.match(s.tools.get("get_suggestions").description, /warnings/);
assert.match(s.tools.get("get_post_analytics").description, /engagement_likes/);

// --- WhatsApp ---------------------------------------------------------------------------
await s.call("send_dm", {
  platform: "whatsapp",
  user: "brand",
  recipient_id: "34600111222",
  message: "Book a table",
  flow: { flow_id: "118", cta: "Book" },
  confirmed: true,
});
assert.deepEqual(last(s).data.flow, { flow_id: "118", cta: "Book" });
r = await s.call("send_dm", { platform: "whatsapp", user: "brand", recipient_id: "34600111222", location_request: true, confirmed: true });
assert.equal(r.isError, true, "a location request needs the body text");
await s.call("manage_whatsapp_number", { action: "get_number", user: "brand" });
assert.equal(last(s).url, "/uploadposts/dms/whatsapp/number");
n = s.calls.length;
r = await s.call("manage_whatsapp_number", { action: "block_users", user: "brand", users: ["34600111222"] });
assert.ok(isPreview(r), "blocking waits for confirmation");
await s.call("manage_whatsapp_number", { action: "unblock_users", user: "brand", users: ["34600111222"] });
assert.equal(last(s).method, "DELETE");
assert.deepEqual(last(s).data, { user: "brand", users: ["34600111222"] }, "unblock sends the users in the body");
await s.call("manage_whatsapp_number", { action: "change_pin", user: "brand", pin: "123456", confirm: true, confirmed: true });
assert.deepEqual(last(s).data, { user: "brand", pin: "123456", confirm: true, action: "change_pin" });
await s.call("manage_whatsapp_flows", { action: "get_json", user: "brand", flow_id: "118" });
assert.equal(last(s).url, "/uploadposts/dms/whatsapp/flows/118/json");
r = await s.call("manage_whatsapp_flows", { action: "publish", user: "brand", flow_id: "118" });
assert.ok(isPreview(r), "publishing a Flow waits for confirmation");
await s.call("manage_whatsapp_flows", { action: "delete", user: "brand", flow_id: "118", confirm: true, confirmed: true });
assert.equal(last(s).method, "DELETE");
assert.deepEqual(last(s).params, { user: "brand", confirm: true });
await s.call("manage_whatsapp_templates", { action: "library", user: "brand", search: "order" });
assert.equal(last(s).url, "/uploadposts/dms/whatsapp/templates/library");
r = await s.call("manage_whatsapp_templates", { action: "edit", user: "brand", template_id: "129", message_send_ttl_seconds: 3600, current_category: "UTILITY" });
assert.ok(isPreview(r), "editing a template waits for confirmation");
await s.call("manage_whatsapp_templates", { action: "edit", user: "brand", template_id: "129", message_send_ttl_seconds: 3600, current_category: "UTILITY", confirmed: true });
assert.equal(last(s).method, "PATCH");
assert.equal(last(s).data.platform, "whatsapp");

await s.close();
console.log(`check-network-extras: ok (${NEW_TOOLS.length} new tools)`);
