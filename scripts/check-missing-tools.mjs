#!/usr/bin/env node
/**
 * Regression check for the tools added to cover the rest of the public API
 * (ChatGPT Ads, webhook subscriptions and settings, the team approval queue,
 * team info, scheduled post detail, profile management, queue slots,
 * publishing limits, Pinterest boards, saving Pins, and the new YouTube,
 * Google Business and Telegram actions):
 *   - ChatGPT sees none of them (its surface is the reviewed one);
 *   - each tool hits the documented route with the API's field names;
 *   - what spends money, reaches other people or cannot be undone is behind the
 *     confirmation step, and the rest runs straight away;
 *   - the account's webhook secret never reaches the model;
 *   - a team member's upload that went to approval (202 pending_approval) and
 *     its status read come back as a success with a next_step, not as an error;
 *   - UPLOAD_POST_ACT_AS_USER reaches both the raw HTTP client and the SDK.
 * The HTTP layer is replaced by an in-memory fake. Run after `npm run build`.
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { UploadPostMcpClient } from "../dist/client.js";

const NEW_TOOLS = [
  "chatgpt_ads_read",
  "manage_chatgpt_ads",
  "list_webhook_subscriptions",
  "create_webhook_subscription",
  "delete_webhook_subscription",
  "test_webhook_subscription",
  "manage_webhook_settings",
  "list_pending_approvals",
  "approve_post",
  "reject_post",
  "edit_pending_post",
  "withdraw_pending_post",
  "get_team_info",
  "get_scheduled_post",
  "manage_profile",
  "mark_queue_slot",
  "get_publishing_limits",
  "manage_pinterest_boards",
  "save_post",
  "manage_google_business",
  "manage_telegram_payments",
  "manage_telegram_business",
];

async function connect(name, { respond, sdk } = {}) {
  const calls = [];
  const upClient = new UploadPostMcpClient({ apiKey: "test", baseUrl: "https://example.invalid/api" });
  upClient.http.request = async (cfg) => {
    calls.push(cfg);
    return respond ? respond(cfg) : { status: 200, data: { success: true } };
  };
  if (sdk) Object.assign(upClient.sdk, sdk);
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

// --- ChatGPT keeps its reviewed surface ----------------------------------------
{
  const s = await connect("openai-mcp");
  for (const name of NEW_TOOLS) assert.ok(!s.tools.has(name), `ChatGPT must not see ${name} yet`);
  assert.equal(s.tools.size, 72, "ChatGPT still sees exactly 72 tools");
  await s.close();
}

const s = await connect("claude-ai");
for (const name of NEW_TOOLS) assert.ok(s.tools.has(name), `claude-ai sees ${name}`);
for (const name of ["chatgpt_ads_read", "list_webhook_subscriptions", "list_pending_approvals", "get_team_info", "get_scheduled_post", "get_publishing_limits"]) {
  assert.equal(s.tools.get(name).annotations.readOnlyHint, true, `${name} is read-only`);
}
for (const name of ["manage_chatgpt_ads", "delete_webhook_subscription", "withdraw_pending_post", "reject_post", "manage_profile"]) {
  assert.equal(s.tools.get(name).annotations.destructiveHint, true, `${name} is marked destructive`);
}
for (const tool of NEW_TOOLS) {
  assert.doesNotMatch(s.tools.get(tool).description, /https?:\/\//, `${tool}: no URLs in the description`);
}

// Features that are off by default say so, with the 503 code they answer.
for (const [tool, code] of [
  ["list_webhook_subscriptions", "webhook_subscriptions_disabled"],
  ["create_webhook_subscription", "webhook_subscriptions_disabled"],
  ["approve_post", "post_approvals_disabled"],
  ["list_pending_approvals", "post_approvals_disabled"],
  ["manage_telegram_business", "telegram_business_unavailable"],
  ["manage_telegram_payments", "telegram_stars_spend_disabled"],
  ["manage_telegram_bot", "telegram_updates_unavailable"],
  ["youtube_read", "youtube_feature_disabled"],
  ["manage_youtube_live", "youtube_feature_disabled"],
  ["manage_youtube_videos", "youtube_feature_disabled"],
]) {
  assert.match(s.tools.get(tool).description, new RegExp(`Not generally available yet[^]*${code}`), `${tool} says it is not generally available (${code})`);
}
assert.match(s.tools.get("youtube_read").description, /except videos and quota/);
assert.match(s.tools.get("manage_youtube_videos").description, /except set_thumbnail/);
assert.doesNotMatch(s.tools.get("test_webhook_subscription").description, /2xx/, "a redirect counts as delivered: no 2xx promise");

// --- ChatGPT Ads ----------------------------------------------------------------
s.calls.length = 0;
let r = await s.call("chatgpt_ads_read", {
  action: "campaign_insights",
  campaign_id: "camp/1",
  profile_username: "brand",
  params: { since: "2026-11-01", fields: ["impressions", "spend"], filters: [{ field: "country", value: "ES" }] },
});
assert.ok(!r.isError, JSON.stringify(r.content));
assert.equal(last(s).method, "GET");
assert.equal(last(s).url, "/uploadposts/ads/chatgpt/campaigns/camp%2F1/insights");
assert.deepEqual(last(s).params, {
  profile_username: "brand",
  since: "2026-11-01",
  fields: ["impressions", "spend"],
  filters: ['{"field":"country","value":"ES"}'],
}, "repeatable insights parameters stay arrays (sent as key[]), objects JSON-encoded");

r = await s.call("chatgpt_ads_read", { action: "ad_groups", campaign_id: "c1", ad_id: "stray" });
assert.deepEqual(last(s).params, { campaign_id: "c1" }, "ad_groups filters by the campaign and drops ids it does not read");
r = await s.call("chatgpt_ads_read", { action: "ad", ad_id: "" });
assert.ok(r.isError, "an action that names an id needs it");

r = await s.call("chatgpt_ads_read", { action: "preview_ad", ad_id: "ad1", ad_account_id: "adacct_1" });
assert.equal(last(s).method, "POST");
assert.equal(last(s).url, "/uploadposts/ads/chatgpt/ads/ad1/preview");
assert.deepEqual(last(s).params, { ad_account_id: "adacct_1" });
assert.equal(last(s).data, undefined, "preview takes no body");

// Spending money needs the user's approval; pausing and paused objects do not.
s.calls.length = 0;
r = await s.call("manage_chatgpt_ads", { action: "activate_campaign", campaign_id: "c1" });
assert.ok(isPreview(r), "activate needs confirmation");
assert.match(r.structuredContent.result.action, /starts spending/);
assert.equal(s.calls.length, 0, "nothing sent before confirmation");
r = await s.call("manage_chatgpt_ads", { action: "activate_campaign", campaign_id: "c1", ad_account_id: "adacct_1", confirmed: true });
assert.equal(last(s).url, "/uploadposts/ads/chatgpt/campaigns/c1/activate");
assert.deepEqual(last(s).params, { ad_account_id: "adacct_1" });
assert.equal(last(s).data, undefined);

s.calls.length = 0;
r = await s.call("manage_chatgpt_ads", { action: "pause_ad", ad_id: "ad9" });
assert.ok(!isPreview(r) && !r.isError, "pausing stops spending: no confirmation");
assert.equal(last(s).url, "/uploadposts/ads/chatgpt/ads/ad9/pause");

r = await s.call("manage_chatgpt_ads", { action: "create_campaign", params: { name: "Black Friday", budget: 50 } });
assert.ok(!isPreview(r), "a paused campaign spends nothing");
assert.equal(last(s).url, "/uploadposts/ads/chatgpt/campaigns");
assert.deepEqual(last(s).data, { name: "Black Friday", budget: 50 });

s.calls.length = 0;
r = await s.call("manage_chatgpt_ads", { action: "promote", params: { title: "Hi", body: "b", target_url: "https://x.example", budget: 20, status: "active" } });
assert.ok(isPreview(r), "an active promote spends money");
assert.match(r.structuredContent.result.action, /budget of 20/);
assert.equal(s.calls.length, 0);

r = await s.call("manage_chatgpt_ads", { action: "create_ad_group", campaign_id: "c1", params: { name: "g", max_bid: 0.06 } });
assert.deepEqual(last(s).data, { name: "g", max_bid: 0.06, campaign_id: "c1" }, "create_ad_group sends the campaign in the body");
r = await s.call("manage_chatgpt_ads", { action: "archive_ad", ad_id: "ad1" });
assert.ok(isPreview(r), "archive is irreversible");
r = await s.call("manage_chatgpt_ads", { action: "update_ad_group", ad_group_id: "g1", params: { max_bid: 1 } });
assert.ok(isPreview(r), "updates can change budget and bid");
assert.ok(!s.tools.get("manage_chatgpt_ads").inputSchema.properties.action.enum.includes("connect"), "connecting the account (an API key) stays in the dashboard");

// --- Webhook subscriptions ------------------------------------------------------
s.calls.length = 0;
r = await s.call("create_webhook_subscription", { url: "https://upload-post.com/", events: ["upload_completed"], source: "n8n" });
assert.ok(isPreview(r), "sending the account's events to a new URL needs approval");
assert.match(r.structuredContent.result.action, /upload_completed.*https:\/\/upload-post\.com\//);
assert.equal(s.calls.length, 0);
r = await s.call("create_webhook_subscription", { url: "https://upload-post.com/", events: ["upload_completed"], source: "n8n", confirmed: true });
assert.equal(last(s).method, "POST");
assert.equal(last(s).url, "/uploadposts/webhooks/subscriptions");
assert.deepEqual(last(s).data, { url: "https://upload-post.com/", events: ["upload_completed"], source: "n8n" });
r = await s.call("create_webhook_subscription", { url: "https://upload-post.com/", events: [], confirmed: true });
assert.ok(r.isError, "events cannot be empty");
r = await s.call("create_webhook_subscription", { url: "https://upload-post.com/", events: ["x"], source: "N8N!", confirmed: true });
assert.ok(r.isError, "source only takes a-z 0-9 _ . -");

r = await s.call("list_webhook_subscriptions", { status: "active", url: "https://upload-post.com/" });
assert.equal(last(s).url, "/uploadposts/webhooks/subscriptions");
assert.deepEqual(last(s).params, { status: "active", url: "https://upload-post.com/" });
r = await s.call("list_webhook_subscriptions", { subscription_id: "whsub_1" });
assert.equal(last(s).url, "/uploadposts/webhooks/subscriptions/whsub_1");

s.calls.length = 0;
r = await s.call("delete_webhook_subscription", { subscription_id: "whsub_1" });
assert.ok(isPreview(r));
assert.equal(s.calls.length, 0);
r = await s.call("delete_webhook_subscription", { subscription_id: "whsub_1", confirmed: true });
assert.equal(last(s).method, "DELETE");
assert.equal(last(s).url, "/uploadposts/webhooks/subscriptions/whsub_1");

s.calls.length = 0;
r = await s.call("test_webhook_subscription", { subscription_id: "whsub_1", event: "comment_received" });
assert.ok(isPreview(r), "a test event reaches an outside server: confirmation first, like redeliver_webhook");
assert.match(r.structuredContent.result.action, /comment_received.*whsub_1/);
assert.equal(s.calls.length, 0, "nothing sent before confirmation");
assert.ok(s.tools.get("test_webhook_subscription").inputSchema.properties.confirmed);
r = await s.call("test_webhook_subscription", { subscription_id: "whsub_1", event: "comment_received", confirmed: true });
assert.equal(last(s).url, "/uploadposts/webhooks/subscriptions/whsub_1/test");
assert.deepEqual(last(s).data, { event: "comment_received" });

// --- Webhook settings: the secret never reaches the model -----------------------
{
  const w = await connect("claude-ai", {
    respond: () => ({
      status: 200,
      data: { success: true, notifications: { webhook_url: "https://hook.example", webhook_secret: "whsec_SECRET", slack_webhook_url: "https://hooks.slack.com/T/B/X" } },
    }),
  });
  const got = await w.call("manage_webhook_settings", { action: "get_account" });
  assert.equal(w.calls[0].url, "/uploadposts/users/notifications");
  const text = JSON.stringify(got);
  assert.doesNotMatch(text, /whsec_SECRET|hooks\.slack\.com/, "secret and Slack URL are redacted");
  assert.equal(got.structuredContent.result.notifications.webhook_secret_set, true);
  assert.equal(got.structuredContent.result.notifications.webhook_url, "https://hook.example");
  await w.close();
}
s.calls.length = 0;
r = await s.call("manage_webhook_settings", { action: "set_profile", profile_username: "brand", webhook_url: "https://hook.example/p" });
assert.ok(isPreview(r), "redirecting a profile's events needs approval");
r = await s.call("manage_webhook_settings", { action: "set_profile", profile_username: "brand", webhook_url: "https://hook.example/p", webhook_events: { dm_received: true }, confirmed: true });
assert.equal(last(s).method, "POST");
assert.equal(last(s).url, "/uploadposts/users/profile-webhook");
assert.deepEqual(last(s).data, { profile_username: "brand", webhook_url: "https://hook.example/p", webhook_events: { dm_received: true } });
r = await s.call("manage_webhook_settings", { action: "remove_profile", profile_username: "brand", confirmed: true });
assert.equal(last(s).method, "DELETE");
assert.deepEqual(last(s).data, { profile_username: "brand" });
r = await s.call("manage_webhook_settings", { action: "get_profile" });
assert.ok(r.isError, "profile actions need profile_username");
s.calls.length = 0;
r = await s.call("manage_webhook_settings", { action: "test_account", params: { platform: "tiktok" } });
assert.ok(isPreview(r), "a test notification reaches the configured channels: confirmation first");
assert.equal(s.calls.length, 0);
r = await s.call("manage_webhook_settings", { action: "test_account", params: { platform: "tiktok" }, confirmed: true });
assert.equal(last(s).url, "/uploadposts/users/notifications/test");
r = await s.call("manage_webhook_settings", { action: "get_account" });
assert.ok(!isPreview(r), "reading the settings needs no confirmation");

// --- Approval queue and team ---------------------------------------------------
r = await s.call("list_pending_approvals", { status: ["pending_approval", "draft"], profile_username: "brand", limit: 10 });
assert.equal(last(s).url, "/uploadposts/approvals");
assert.deepEqual(last(s).params, { profile_username: "brand", limit: 10, status: "pending_approval,draft" });
r = await s.call("list_pending_approvals", { approval_id: "ap 1" });
assert.equal(last(s).url, "/uploadposts/approvals/ap%201");

s.calls.length = 0;
r = await s.call("approve_post", { approval_id: "ap1", version: 3, publish_now: true });
assert.ok(isPreview(r), "approving publishes: needs approval");
assert.match(r.structuredContent.result.action, /NOW/);
assert.equal(s.calls.length, 0);
r = await s.call("approve_post", { approval_id: "ap1", version: 3, publish_now: true, confirmed: true });
assert.equal(last(s).url, "/uploadposts/approvals/ap1/approve");
assert.deepEqual(last(s).data, { version: 3, publish_now: true });
r = await s.call("approve_post", { approval_id: "ap1", confirmed: true });
assert.ok(r.isError, "version is required");

r = await s.call("reject_post", { approval_id: "ap1", comment: "Off brand", confirmed: true });
assert.equal(last(s).url, "/uploadposts/approvals/ap1/reject");
assert.deepEqual(last(s).data, { comment: "Off brand" });
s.calls.length = 0;
for (const args of [{ approval_id: "ap1", comment: "", confirmed: true }, { approval_id: "ap1", comment: "   " }, { approval_id: "ap1" }]) {
  r = await s.call("reject_post", args);
  assert.ok(r.isError, "a rejection needs a comment");
  assert.match(r.content[0].text, /comment_required: a rejection needs a comment/, "and says so plainly");
}
assert.equal(s.calls.length, 0, "nothing sent without a comment");
r = await s.call("withdraw_pending_post", { approval_id: "ap1", confirmed: true });
assert.equal(last(s).method, "DELETE");
assert.equal(last(s).url, "/uploadposts/approvals/ap1");
r = await s.call("edit_pending_post", { approval_id: "ap1", caption: "New" });
assert.ok(!isPreview(r), "editing a pending post publishes nothing");
assert.equal(last(s).method, "PATCH");
assert.deepEqual(last(s).data, { caption: "New" });

r = await s.call("get_team_info", { action: "audit", audit_action: "approved", limit: 5 });
assert.equal(last(s).url, "/uploadposts/teams/audit");
assert.deepEqual(last(s).params, { limit: 5, action: "approved" });
r = await s.call("get_team_info", { action: "shared_with_me" });
assert.equal(last(s).url, "/uploadposts/teams/shared-with-me");

// --- A team member's upload that went to approval is not a failure ---------------
{
  const pending = {
    success: true,
    pending_approval: true,
    approval_id: "ap7",
    approval_status: "pending_approval",
    job_id: null,
    request_id: "req7",
    scheduled_date: null,
    message: "Sent for approval",
  };
  const t = await connect("claude-ai", {
    sdk: {
      uploadText: async () => pending,
      getStatus: async () => ({ request_id: "req7", job_id: null, approval_id: "ap7", status: "draft", completed: 0, total: 1, results: [] }),
    },
  });
  const up = await t.call("upload_text", { user: "brand", platforms: ["x"], title: "Hello", confirmed: true });
  assert.ok(!up.isError, JSON.stringify(up.content));
  assert.equal(up.structuredContent.result.pending_approval, true);
  assert.match(up.structuredContent.result.next_step, /not an error/);
  const st = await t.call("get_status", { requestId: "req7" });
  assert.ok(!st.isError);
  assert.match(st.structuredContent.result.next_step, /drafts? .*review/);
  await t.close();
}

// --- Account extras --------------------------------------------------------------
r = await s.call("get_scheduled_post", { job_id: "j1", view: "thumbnail" });
assert.equal(last(s).url, "/uploadposts/schedule/j1/thumbnail");
r = await s.call("get_scheduled_post", { job_id: "j1" });
assert.equal(last(s).url, "/uploadposts/schedule/j1");

r = await s.call("manage_profile", { action: "select_page", username: "brand", page_type: "google_business", page_id: "locations/9" });
assert.equal(last(s).url, "/uploadposts/users/google-business-location");
assert.deepEqual(last(s).data, { profile_username: "brand", gbp_location_id: "locations/9" });
r = await s.call("manage_profile", { action: "rename", username: "brand", display_name: "Brand ES" });
assert.equal(last(s).method, "PATCH");
assert.equal(last(s).url, "/uploadposts/users/brand");
s.calls.length = 0;
r = await s.call("manage_profile", { action: "disconnect_social", username: "brand", social_platform: "instagram" });
assert.ok(isPreview(r), "disconnecting a network needs approval");
assert.equal(s.calls.length, 0);
r = await s.call("manage_profile", { action: "disconnect_social", username: "brand", social_platform: "instagram", confirmed: true });
assert.equal(last(s).method, "DELETE");
assert.deepEqual(last(s).data, { profile_username: "brand", social_platform: "instagram" });

r = await s.call("mark_queue_slot", { profile_username: "brand", slot_datetime: "2026-12-01T10:00:00Z", full: false });
assert.equal(last(s).method, "DELETE");
assert.equal(last(s).url, "/uploadposts/queue/slot-full");
r = await s.call("get_publishing_limits", { platform: "threads", profile: "brand" });
assert.equal(last(s).url, "/uploadposts/threads/publishing_limit");
assert.deepEqual(last(s).params, { profile: "brand" });
r = await s.call("manage_pinterest_boards", { action: "create_section", profile: "brand", board_id: "b1", name: "Ideas" });
assert.equal(last(s).url, "/uploadposts/pinterest/boards/b1/sections");
assert.deepEqual(last(s).params, { profile: "brand" });
assert.deepEqual(last(s).data, { name: "Ideas" });
r = await s.call("save_post", { platform: "pinterest", user: "brand", post_id: "p1", confirmed: true });
assert.ok(r.isError, "Pinterest needs a board");
r = await s.call("save_post", { platform: "bluesky", user: "brand", post_id: "at://x" });
assert.ok(!isPreview(r), "a Bluesky bookmark is private");
assert.equal(last(s).url, "/uploadposts/posts/save");

// --- New actions on existing per-network tools --------------------------------------
r = await s.call("youtube_read", { action: "caption_download", user: "brand", params: { caption_id: "cap1", tfmt: "srt" } });
assert.equal(last(s).url, "/uploadposts/youtube/captions/cap1/download");
s.calls.length = 0;
r = await s.call("manage_youtube_live", { action: "ban_user", user: "brand", broadcast_id: "b1", params: { channel_id: "UC1", type: "permanent" } });
assert.ok(isPreview(r), "banning from a live chat needs approval");
assert.equal(s.calls.length, 0);
r = await s.call("manage_youtube_videos", { action: "report_abuse", user: "brand", video_id: "v1", params: { reason_id: "S" } });
assert.ok(isPreview(r), "an abuse report cannot be withdrawn");
r = await s.call("manage_google_business", { action: "delete_media", user: "brand", params: { media_key: "m1" }, confirm: true });
assert.equal(last(s).method, "DELETE");
assert.equal(last(s).url, "/uploadposts/google-business/media");
r = await s.call("google_business_read", { action: "verification_state", user: "brand" });
assert.equal(last(s).url, "/uploadposts/google-business/verification/state");
r = await s.call("manage_telegram_payments", { action: "stars_balance", user: "brand" });
assert.equal(last(s).url, "/uploadposts/telegram/stars");
s.calls.length = 0;
r = await s.call("manage_telegram_payments", { action: "send_invoice", user: "brand", params: { title: "T", prices: [{ label: "x", amount: 5 }] } });
assert.ok(isPreview(r), "an invoice is posted in the chat");
r = await s.call("manage_telegram_bot", { action: "set_updates", user: "brand", params: { enabled: true } });
assert.equal(last(s).url, "/uploadposts/telegram/updates");
r = await s.call("manage_telegram_chat", { action: "profile_audios", user: "brand", params: { user_id: 42 } });
assert.equal(last(s).url, "/uploadposts/telegram/users/42/profile-audios");

await s.close();

// --- Team members acting on the owner's account (stdio) --------------------------
{
  const member = new UploadPostMcpClient({ apiKey: "k", baseUrl: "https://example.invalid/api", actAsUser: " owner@example.com " });
  assert.equal(member.http.defaults.headers["X-Act-As-User"], "owner@example.com");
  assert.equal(member.sdk.actAsUser, "owner@example.com");
  const owner = new UploadPostMcpClient({ apiKey: "k", baseUrl: "https://example.invalid/api" });
  assert.equal(owner.http.defaults.headers["X-Act-As-User"], undefined);
  assert.equal(owner.sdk.actAsUser, null);
}

console.log(`check-missing-tools: ok (${NEW_TOOLS.length} new tools)`);
