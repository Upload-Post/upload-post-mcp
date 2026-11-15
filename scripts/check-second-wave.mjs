#!/usr/bin/env node
/**
 * Regression check for the Telegram / Bluesky / Google Business / best-times
 * tools and the parameters added to existing tools (0.24.0):
 *   - ChatGPT does not see the new tools nor the new parameters;
 *   - each action reaches the right route with the API's field names, GET as
 *     query (lists comma-separated) and writes as JSON body, keeping `null`;
 *   - edit_post / repost_post / post_action preview first (confirmed), and the
 *     API's own `confirm` is passed through untouched;
 *   - new platformOptions reach the upload form and are not reported as ignored;
 *   - unpublish_post (Telegram delete_all_messages), update_queue_settings
 *     (slots "auto") and list_dm_conversations (view) send the new fields.
 * The HTTP layer is replaced by in-memory fakes. Run after `npm run build`.
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { UploadPostMcpClient } from "../dist/client.js";

const NEW_TOOLS = [
  "get_best_times",
  "edit_post",
  "repost_post",
  "post_action",
  "manage_telegram_chat",
  "manage_telegram_bot",
  "bluesky_read",
  "manage_bluesky_account",
  "google_business_read",
  "update_google_business_location",
];

function formFields(form) {
  const boundary = form.getBoundary();
  const body = form.getBuffer().toString("utf8");
  const fields = {};
  for (const part of body.split(`--${boundary}`)) {
    const match = part.match(/name="([^"]+)"\r\n\r\n([\s\S]*?)\r\n$/);
    if (match) fields[match[1]] = match[2];
  }
  return fields;
}

async function connect(name) {
  const calls = [];
  const uploads = [];
  const upClient = new UploadPostMcpClient({ apiKey: "test", baseUrl: "https://example.invalid/api" });
  upClient.http.request = async (cfg) => {
    calls.push(cfg);
    return { status: 200, data: { success: true } };
  };
  upClient.sdk._request = async (endpoint, method, form) => {
    uploads.push({ endpoint, fields: formFields(form) });
    return { success: true, request_id: "r1" };
  };
  const server = buildServer(upClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name, version: "0.0.0-test" });
  await client.connect(clientTransport);
  const tools = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
  return {
    calls,
    uploads,
    tools,
    async call(toolName, args) {
      const res = await client.callTool({ name: toolName, arguments: args });
      assert.ok(!res.isError, `${toolName}: ${res.content?.[0]?.text}`);
      return res.structuredContent?.result;
    },
    raw: (toolName, args) => client.callTool({ name: toolName, arguments: args }),
    async close() {
      await client.close();
      await server.close();
    },
  };
}

// --- ChatGPT keeps its reviewed surface ------------------------------------------
{
  const s = await connect("openai-mcp");
  for (const name of NEW_TOOLS) assert.ok(!s.tools.has(name), `ChatGPT must not see ${name} yet`);
  assert.equal(s.tools.get("unpublish_post").inputSchema.properties.delete_all_messages, undefined);
  assert.ok(!s.tools.get("unpublish_post").inputSchema.properties.platform.enum.includes("telegram"));
  assert.equal(s.tools.get("upload_text").inputSchema.properties.platformOptions.properties.telegramPoll, undefined);
  assert.equal(s.tools.get("list_dm_conversations").inputSchema.properties.view, undefined);
  // A new key sent anyway is stripped by ChatGPT's schema: never reaches the API.
  await s.call("unpublish_post", { user: "demo", platform: "x", postId: "1", delete_all_messages: true });
  assert.equal(s.calls.at(-1).data.delete_all_messages, undefined);
  await s.close();
}

const s = await connect("claude-ai");
for (const name of NEW_TOOLS) assert.ok(s.tools.has(name), `claude-ai sees ${name}`);
const last = () => s.calls.at(-1);

// --- Annotations --------------------------------------------------------------------
for (const name of ["get_best_times", "bluesky_read", "google_business_read"]) {
  assert.equal(s.tools.get(name).annotations.readOnlyHint, true, `${name} is read-only`);
}
for (const name of ["edit_post", "manage_telegram_chat", "manage_telegram_bot", "manage_bluesky_account", "update_google_business_location"]) {
  assert.equal(s.tools.get(name).annotations.destructiveHint, true, `${name} is marked destructive`);
}
// Nothing that is switched off is offered.
assert.ok(!s.tools.get("get_best_times").inputSchema.properties.platform.enum.includes("x"));
assert.ok(!s.tools.get("post_action").inputSchema.properties.action.enum.includes("like"));
assert.ok(!s.tools.get("repost_post").inputSchema.properties.platform.enum.includes("bluesky"));
assert.ok(!s.tools.get("edit_post").inputSchema.properties.platform.enum.includes("youtube"));

// --- Best times ------------------------------------------------------------------------
await s.call("get_best_times", { profile_username: "demo", platform: "instagram", top: 3 });
assert.equal(last().method, "GET");
assert.equal(last().url, "/uploadposts/best-times");
assert.deepEqual(last().params, { profile_username: "demo", platform: "instagram", top: 3 });

// --- Edit / repost / actions: preview first ------------------------------------------
s.calls.length = 0;
let r = await s.call("edit_post", { user: "demo", platform: "facebook", post_id: "p1", text: "new" });
assert.equal(r.status, "confirmation_required");
assert.equal(s.calls.length, 0, "no edit without confirmed");
await s.call("edit_post", { user: "demo", platform: "facebook", post_id: "p1", text: "new", confirmed: true });
assert.equal(last().url, "/uploadposts/posts/edit");
assert.deepEqual(last().data, { user: "demo", platform: "facebook", post_id: "p1", message: "new" });
await s.call("edit_post", {
  user: "demo",
  platform: "telegram",
  post_id: "7",
  telegram_action: "pin",
  params: { telegram_pin_notify: true },
  confirmed: true,
});
assert.deepEqual(last().data, { telegram_pin_notify: true, user: "demo", platform: "telegram", post_id: "7", action: "pin" });
await s.call("edit_post", { user: "demo", platform: "google_business", post_id: "accounts/1/locations/2/localPosts/3", text: "Hi", confirmed: true });
assert.equal(last().data.summary, "Hi");

s.calls.length = 0;
r = await s.call("repost_post", { user: "demo", platform: "telegram", post_id: "5", mode: "copy", target_chat_id: "@other", all_messages: true });
assert.equal(r.status, "confirmation_required");
assert.equal(s.calls.length, 0);
await s.call("repost_post", { user: "demo", platform: "telegram", post_id: "5", mode: "copy", target_chat_id: "@other", all_messages: true, confirmed: true });
assert.equal(last().url, "/uploadposts/posts/repost");
assert.deepEqual(last().data, { user: "demo", platform: "telegram", post_id: "5", mode: "copy", target_chat_id: "@other", all_messages: true });

// bookmark is private: no preview; pin is public: preview
s.calls.length = 0;
await s.call("post_action", { user: "demo", platform: "bluesky", action: "bookmark", post_id: "at://did:plc:x/app.bsky.feed.post/1" });
assert.equal(last().url, "/uploadposts/posts/action");
assert.deepEqual(last().data, { user: "demo", platform: "bluesky", action: "bookmark", post_id: "at://did:plc:x/app.bsky.feed.post/1" });
s.calls.length = 0;
r = await s.call("post_action", { user: "demo", platform: "bluesky", action: "pin", post_id: "at://x" });
assert.equal(r.status, "confirmation_required");
assert.equal(s.calls.length, 0);
// delete_reaction: the API's own confirm goes through as given
await s.call("post_action", { user: "demo", platform: "telegram", action: "delete_reaction", post_id: "9", confirm: true, params: { user_id: 42 } });
assert.deepEqual(last().data, { user_id: 42, user: "demo", platform: "telegram", action: "delete_reaction", post_id: "9", confirm: true });
r = await s.raw("post_action", { user: "demo", platform: "telegram", action: "bookmark", post_id: "9" });
assert.ok(r.isError, "a Bluesky action on Telegram is refused before any call");

// --- Telegram ---------------------------------------------------------------------------
await s.call("manage_telegram_chat", { action: "get_info", user: "demo", params: { include_administrators: true } });
assert.equal(last().method, "GET");
assert.equal(last().url, "/uploadposts/telegram/chat-info");
assert.deepEqual(last().params, { include_administrators: true, user: "demo" });
await s.call("manage_telegram_chat", { action: "moderate_member", user: "demo", params: { action: "ban", user_id: 5 }, confirm: true });
assert.equal(last().method, "POST");
assert.equal(last().url, "/uploadposts/telegram/members");
assert.deepEqual(last().data, { action: "ban", user_id: 5, user: "demo", confirm: true }, "the API's own `action` survives");
await s.call("manage_telegram_chat", { action: "revoke_invite_link", user: "demo", params: { invite_link: "https://t.me/+x" } });
assert.equal(last().method, "DELETE");
assert.deepEqual(last().data, { invite_link: "https://t.me/+x", user: "demo" }, "no confirm is added by the server");
await s.call("manage_telegram_bot", { action: "set_commands", user: "demo", params: { commands: [{ command: "start", description: "Start" }] } });
assert.equal(last().url, "/uploadposts/telegram/bot-commands");
assert.deepEqual(last().data.commands, [{ command: "start", description: "Start" }], "nested objects keep their shape");

// --- Bluesky ------------------------------------------------------------------------------
await s.call("bluesky_read", { action: "profiles", params: { actor: ["a.bsky.social", "b.bsky.social"] } });
assert.equal(last().url, "/uploadposts/bluesky/profile");
assert.deepEqual(last().params, { actor: "a.bsky.social,b.bsky.social" }, "lists go comma-separated");
await s.call("bluesky_read", { action: "post_thread", params: { uri: "at://x", depth: 2 } });
assert.equal(last().url, "/uploadposts/bluesky/xrpc/app.bsky.feed.getPostThread");
await s.call("bluesky_read", { action: "xrpc", params: { nsid: "app.bsky.feed.getPosts", uris: "at://x" } });
assert.equal(last().url, "/uploadposts/bluesky/xrpc/app.bsky.feed.getPosts");
assert.deepEqual(last().params, { uris: "at://x" });
await s.call("bluesky_read", { action: "post_engagement", params: { post_id: "at://x", type: "quotes" } });
assert.equal(last().url, "/uploadposts/post-engagement");
assert.equal(last().params.platform, "bluesky");
r = await s.raw("bluesky_read", { action: "xrpc" });
assert.ok(r.isError, "xrpc without nsid is refused before any call");
await s.call("manage_bluesky_account", { action: "update_profile", user: "demo", params: { description: null, website: "https://x.y" } });
assert.equal(last().method, "POST");
assert.equal(last().url, "/uploadposts/bluesky/profile/self");
assert.deepEqual(last().data, { description: null, website: "https://x.y", user: "demo" }, "null (clear) is kept");
await s.call("manage_bluesky_account", { action: "delete_draft", user: "demo", draft_id: "d/1", confirm: true });
assert.equal(last().method, "DELETE");
assert.equal(last().url, "/uploadposts/bluesky/drafts/d%2F1");
assert.deepEqual(last().data, { user: "demo", confirm: true });

// --- Google Business -----------------------------------------------------------------------
await s.call("google_business_read", { action: "performance", user: "demo", location_id: "123", params: { metrics: ["CALL_CLICKS", "WEBSITE_CLICKS"], start_date: "2026-10-01" } });
assert.equal(last().url, "/uploadposts/google-business/performance");
assert.deepEqual(last().params, { metrics: "CALL_CLICKS,WEBSITE_CLICKS", start_date: "2026-10-01", user: "demo", location_id: "123" });
await s.call("google_business_read", { action: "list_posts", user: "demo" });
assert.equal(last().url, "/uploadposts/google-business/posts");
await s.call("update_google_business_location", {
  user: "demo",
  edit_mode: "strict",
  fields: { title: "New name", website: null },
  confirm: true,
});
assert.equal(last().method, "PATCH");
assert.equal(last().url, "/uploadposts/google-business/location-info");
assert.deepEqual(last().data, { title: "New name", website: null, user: "demo", edit_mode: "strict", confirm: true });

// --- Widened existing tools -------------------------------------------------------------------
await s.call("unpublish_post", { user: "demo", platform: "telegram", postId: "77", delete_all_messages: true, confirmed: true });
assert.deepEqual(last().data, { platform: "telegram", user: "demo", post_id: "77", delete_all_messages: true });
await s.call("update_queue_settings", { profile_username: "demo", slots: "auto", auto_slots_count: 4 });
assert.deepEqual(last().data, { profile_username: "demo", slots: "auto", auto_slots_count: 4 });
await s.call("update_queue_settings", { profile_username: "demo", slots: [{ hour: 9 }] });
assert.deepEqual(last().data.slots, [{ hour: 9 }], "fixed slots still work");
await s.call("list_dm_conversations", { user: "demo", platform: "bluesky", view: "summary", include: "unread_counts" });
assert.equal(last().params.view, "summary");

// Upload fields reach the form under the API's names, with no "ignored" warning.
const text = await s.call("upload_text", {
  title: "Pick one",
  user: "demo",
  platforms: ["telegram", "bluesky", "google_business"],
  scheduledDate: "2026-12-01T10:00:00Z",
  platformOptions: {
    telegramPoll: { options: ["A", "B"] },
    telegramDisableNotification: true,
    telegramPin: true,
    blueskyTags: ["launch"],
    blueskyThreadOverflow: true,
    gbpRecurrence: "WEEKLY",
    gbpRecurrenceEnd: "2027-01-31",
    paidPartnership: true,
  },
});
assert.equal(text.ignored_platform_options, undefined, JSON.stringify(text));
const f = s.uploads.at(-1).fields;
assert.equal(f.telegram_poll, JSON.stringify({ options: ["A", "B"] }));
assert.equal(f.telegram_disable_notification, "true");
assert.equal(f.telegram_pin, "true");
assert.ok(f.bluesky_tags, "bluesky_tags sent");
assert.equal(f.bluesky_thread_overflow, "true");
assert.equal(f.gbp_recurrence, "WEEKLY");
assert.equal(f.gbp_recurrence_end, "2027-01-31");
assert.equal(f.paid_partnership, "true");

const video = await s.call("upload_video", {
  videoPathOrUrl: "https://example.com/v.mp4",
  user: "demo",
  platforms: ["bluesky", "telegram"],
  scheduledDate: "2026-12-01T10:00:00Z",
  platformOptions: { blueskyVideoPresentation: "gif", telegramHasSpoiler: true, telegramCaptionOverflow: "split" },
});
assert.equal(video.ignored_platform_options, undefined, JSON.stringify(video));
const v = s.uploads.at(-1).fields;
assert.equal(v.bluesky_video_presentation, "gif");
assert.equal(v.telegram_has_spoiler, "true");
assert.equal(v.telegram_caption_overflow, "split");

await s.close();
console.log("check-second-wave: ok");
