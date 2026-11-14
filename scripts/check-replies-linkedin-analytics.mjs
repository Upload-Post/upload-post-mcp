#!/usr/bin/env node
/**
 * Regression check for:
 *   - get_post_comments: replies under a comment are readable on Instagram,
 *     Facebook and LinkedIn too, and `commentId` still maps to `comment_id`;
 *   - resolve_linkedin_organization: GET /linkedin/resolve-organization with
 *     `user` + `url`, read-only, hidden from ChatGPT until its next review;
 *   - get_post_analytics: `requestId` (as before, through the SDK), or
 *     `platformPostId` + `platform` + `user` together; an incomplete mix is
 *     refused before any call;
 *   - upload descriptions: Bluesky's 4 / 10 image limits and LinkedIn mentions.
 * The SDK and HTTP layer are replaced by in-memory fakes. Run after `npm run build`.
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { UploadPostMcpClient } from "../dist/client.js";

async function connect(name) {
  const calls = [];
  const upClient = new UploadPostMcpClient({ apiKey: "test", baseUrl: "https://example.invalid/api" });
  upClient.http.request = async (cfg) => {
    calls.push(["http", cfg.method, cfg.url, cfg.params]);
    return { status: 200, data: { success: true } };
  };
  upClient.sdk.getPostAnalytics = async (...args) => {
    calls.push(["sdk.getPostAnalytics", ...args]);
    return { success: true };
  };
  upClient.sdk.getPostAnalyticsByPlatformId = async (...args) => {
    calls.push(["sdk.getPostAnalyticsByPlatformId", ...args]);
    return { success: true };
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

{
  const s = await connect("openai-mcp");
  assert.ok(!s.tools.has("resolve_linkedin_organization"), "ChatGPT must not see resolve_linkedin_organization yet");
  const analytics = s.tools.get("get_post_analytics");
  assert.ok(analytics.inputSchema.properties.platformPostId, "ChatGPT get_post_analytics accepts platformPostId");
  assert.ok(!analytics.inputSchema.required?.includes("requestId"), "requestId is optional now");
  await s.close();
}

const s = await connect("claude-ai");

// --- comments: replies on Instagram / Facebook / LinkedIn ------------------------
const comments = s.tools.get("get_post_comments");
assert.match(comments.description, /TikTok, Threads, YouTube, Instagram, Facebook and LinkedIn/);
assert.match(comments.description, /X and Bluesky/);
assert.match(comments.inputSchema.properties.commentId.description, /comment_urn/);
let r = await s.call("get_post_comments", {
  user: "brand", platform: "linkedin", postId: "urn:li:share:1", commentId: "urn:li:comment:(urn:li:activity:1,2)", after: "10",
});
assert.ok(!r.isError);
assert.deepEqual(s.calls[0], [
  "http", "GET", "/uploadposts/comments",
  { platform: "linkedin", user: "brand", post_id: "urn:li:share:1", comment_id: "urn:li:comment:(urn:li:activity:1,2)", after: "10" },
]);

// --- LinkedIn Page resolver ------------------------------------------------------
const resolve = s.tools.get("resolve_linkedin_organization");
assert.ok(resolve, "claude-ai sees resolve_linkedin_organization");
assert.equal(resolve.annotations.readOnlyHint, true);
assert.deepEqual(resolve.inputSchema.required.sort(), ["url", "user"]);
assert.match(resolve.description, /exactly, capitals included/);
s.calls.length = 0;
r = await s.call("resolve_linkedin_organization", { user: "brand", url: "https://www.linkedin.com/company/linkedin/" });
assert.ok(!r.isError);
assert.deepEqual(s.calls[0], [
  "http", "GET", "/uploadposts/linkedin/resolve-organization",
  { user: "brand", url: "https://www.linkedin.com/company/linkedin/" },
]);

// --- post analytics -------------------------------------------------------------
s.calls.length = 0;
r = await s.call("get_post_analytics", { requestId: "req1" });
assert.ok(!r.isError);
assert.deepEqual(s.calls[0], ["sdk.getPostAnalytics", "req1"], "requestId alone keeps the SDK path");

s.calls.length = 0;
r = await s.call("get_post_analytics", { requestId: "req1", platform: "tiktok" });
assert.ok(!r.isError);
assert.deepEqual(s.calls[0], ["http", "GET", "/uploadposts/post-analytics/req1", { platform: "tiktok" }]);

s.calls.length = 0;
r = await s.call("get_post_analytics", { platformPostId: "7300000000000000000", platform: "tiktok", user: "brand" });
assert.ok(!r.isError, JSON.stringify(r.content));
assert.deepEqual(s.calls[0], ["sdk.getPostAnalyticsByPlatformId", "7300000000000000000", "tiktok", "brand"]);

s.calls.length = 0;
for (const bad of [
  { platformPostId: "1", platform: "tiktok" },
  { platformPostId: "1", user: "brand" },
  { platform: "tiktok", user: "brand" },
  { requestId: "req1", platformPostId: "1", platform: "tiktok", user: "brand" },
  {},
]) {
  r = await s.call("get_post_analytics", bad);
  assert.ok(r.isError, `refused: ${JSON.stringify(bad)}`);
}
assert.equal(s.calls.length, 0, "an incomplete identification never reaches the API");

// --- upload descriptions ----------------------------------------------------------
const photos = s.tools.get("upload_photos");
assert.match(photos.description, /blueskyGallery/);
assert.match(photos.description, /up to 10/);
assert.doesNotMatch(photos.description, /\b20 images\b/);
assert.ok(photos.inputSchema.properties.platformOptions.properties.blueskyGallery, "blueskyGallery is a declared option");
for (const name of ["upload_text", "upload_photos", "upload_video", "upload_document"]) {
  assert.match(s.tools.get(name).description, /urn:li:organization/, `${name} explains LinkedIn mentions`);
}

await s.close();
console.log("check-replies-linkedin-analytics: ok");
