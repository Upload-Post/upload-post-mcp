#!/usr/bin/env node
/**
 * Regression check for the YouTube tools (0.25.0):
 *   - ChatGPT does not see them, nor the new YouTube upload options;
 *   - reads go as GET query, writes as JSON body, ids fill the path;
 *   - files only by public URL: `image` / `file` / `thumbnail` are refused before any call;
 *   - public writes and deletions preview first (`confirmed`), and the API's
 *     own `confirm` is passed through untouched;
 *   - every YouTube tool tells the agent about the daily allowance;
 *   - youtubeLocalizations / youtubeBrandPartner reach the upload form, and
 *     edit_post takes YouTube.
 * The HTTP layer is replaced by in-memory fakes. Run after `npm run build`.
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { UploadPostMcpClient } from "../dist/client.js";

const TOOLS = [
  "youtube_read",
  "manage_youtube_playlists",
  "manage_youtube_comments",
  "manage_youtube_channel",
  "manage_youtube_videos",
  "manage_youtube_live",
];

function formFields(form) {
  const boundary = form.getBoundary();
  const fields = {};
  for (const part of form.getBuffer().toString("utf8").split(`--${boundary}`)) {
    const m = part.match(/name="([^"]+)"\r\n\r\n([\s\S]*?)\r\n$/);
    if (m) fields[m[1]] = m[2];
  }
  return fields;
}

async function connect(name) {
  const calls = [];
  const uploads = [];
  const up = new UploadPostMcpClient({ apiKey: "test", baseUrl: "https://example.invalid/api" });
  up.http.request = async (cfg) => {
    calls.push(cfg);
    return { status: 200, data: { success: true } };
  };
  up.sdk._request = async (endpoint, method, form) => {
    uploads.push(formFields(form));
    return { success: true, request_id: "r1" };
  };
  const server = buildServer(up);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name, version: "0.0.0-test" });
  await client.connect(ct);
  const tools = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
  return {
    calls,
    uploads,
    tools,
    raw: (n, a) => client.callTool({ name: n, arguments: a }),
    async call(n, a) {
      const r = await client.callTool({ name: n, arguments: a });
      assert.ok(!r.isError, `${n}: ${r.content?.[0]?.text}`);
      return r.structuredContent?.result;
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

{
  const s = await connect("openai-mcp");
  for (const n of TOOLS) assert.ok(!s.tools.has(n), `ChatGPT must not see ${n} yet`);
  const po = s.tools.get("upload_video").inputSchema.properties.platformOptions.properties;
  assert.equal(po.youtubeLocalizations, undefined);
  assert.equal(po.youtubeBrandPartner, undefined);
  await s.close();
}

const s = await connect("claude-ai");
const last = () => s.calls.at(-1);
for (const n of TOOLS) {
  assert.ok(s.tools.has(n), `claude-ai sees ${n}`);
  assert.match(s.tools.get(n).description, /daily YouTube allowance/, `${n} warns about the quota`);
}
assert.equal(s.tools.get("youtube_read").annotations.readOnlyHint, true);
for (const n of TOOLS.slice(1)) assert.equal(s.tools.get(n).annotations.destructiveHint, true, `${n} is destructive`);
// Switched off in production: nothing of Analytics, Reporting or push.
const all = JSON.stringify([...s.tools.values()].filter((t) => TOOLS.includes(t.name)));
assert.doesNotMatch(all, /analytics\/query|reporting|websub|youtube\/push/i);

// Reads
await s.call("youtube_read", { action: "videos", user: "demo", params: { ids: ["a", "b"], parts: "snippet,status" } });
assert.equal(last().method, "GET");
assert.equal(last().url, "/uploadposts/youtube/videos");
assert.deepEqual(last().params, { ids: "a,b", parts: "snippet,status", user: "demo" });
await s.call("youtube_read", { action: "playlist_items", user: "demo", params: { playlist_id: "PL/1" } });
assert.equal(last().url, "/uploadposts/youtube/playlists/PL%2F1/items");
assert.deepEqual(last().params, { user: "demo" });
await s.call("youtube_read", { action: "quota" });
assert.equal(last().url, "/uploadposts/youtube/quota");

// Writes, ids in the path, body as JSON
await s.call("manage_youtube_playlists", { action: "add_video", user: "demo", playlist_id: "PL1", params: { video_id: "v1", position: 0 } });
assert.equal(last().method, "POST");
assert.equal(last().url, "/uploadposts/youtube/playlists/PL1/items");
assert.deepEqual(last().data, { video_id: "v1", position: 0, user: "demo" });
await s.call("manage_youtube_channel", { action: "update", user: "demo", params: { keywords: "a b", localizations_remove: ["fr"] } });
assert.equal(last().method, "PATCH");
assert.equal(last().url, "/uploadposts/youtube/channel");
await s.call("manage_youtube_videos", { action: "rate", user: "demo", video_id: "v9", params: { rating: "like" } });
assert.equal(last().url, "/uploadposts/youtube/videos/v9/rate");
assert.deepEqual(last().data, { rating: "like", user: "demo" });
await s.call("manage_youtube_videos", { action: "set_thumbnail", user: "demo", video_id: "v9", params: { thumbnail_url: "https://x/t.jpg" } });
assert.deepEqual(last().data, { thumbnail_url: "https://x/t.jpg", user: "demo", video_id: "v9" }, "video_id stays in the body when the path does not take it");

// Files: URLs only
s.calls.length = 0;
let r = await s.raw("manage_youtube_channel", { action: "set_banner", user: "demo", params: { image: "/etc/passwd" } });
assert.ok(r.isError);
assert.match(r.content[0].text, /image_url/);
r = await s.raw("manage_youtube_videos", { action: "upload_caption", user: "demo", video_id: "v", params: { file: "./subs.srt" } });
assert.ok(r.isError);
assert.equal(s.calls.length, 0, "nothing reaches the API with a file path");

// Preview first for public writes and deletions; reads and plain edits run straight away
s.calls.length = 0;
r = await s.call("manage_youtube_comments", { action: "create", user: "demo", params: { parent_id: "c1", text: "Thanks!" } });
assert.equal(r.status, "confirmation_required");
assert.match(r.action, /PUBLIC YouTube reply/);
assert.equal(s.calls.length, 0);
await s.call("manage_youtube_comments", { action: "create", user: "demo", params: { parent_id: "c1", text: "Thanks!" }, confirmed: true });
assert.equal(last().url, "/uploadposts/youtube/comments");
assert.deepEqual(last().data, { parent_id: "c1", text: "Thanks!", user: "demo" });

s.calls.length = 0;
r = await s.call("manage_youtube_playlists", { action: "delete", user: "demo", playlist_id: "PL1", confirm: true });
assert.equal(r.status, "confirmation_required", "API confirm alone is not the user's approval");
assert.equal(s.calls.length, 0);
await s.call("manage_youtube_playlists", { action: "delete", user: "demo", playlist_id: "PL1", confirm: true, confirmed: true });
assert.equal(last().method, "DELETE");
assert.equal(last().url, "/uploadposts/youtube/playlists/PL1");
assert.deepEqual(last().data, { user: "demo", confirm: true }, "the API's confirm goes through; the MCP's is not sent");

s.calls.length = 0;
r = await s.call("manage_youtube_live", { action: "transition", user: "demo", broadcast_id: "b1", params: { status: "live" }, confirm: true });
assert.equal(r.status, "confirmation_required");
await s.call("manage_youtube_live", { action: "transition", user: "demo", broadcast_id: "b1", params: { status: "testing" } });
assert.equal(last().url, "/uploadposts/youtube/live/broadcasts/b1/transition", "testing needs no preview");
r = await s.call("manage_youtube_live", { action: "send_chat_message", user: "demo", broadcast_id: "b1", params: { message: "hi" } });
assert.equal(r.status, "confirmation_required");
await s.call("manage_youtube_live", { action: "create_broadcast", user: "demo", params: { title: "Show", scheduled_start_time: "2026-12-01T18:00:00Z", privacy_status: "unlisted" } });
assert.equal(last().url, "/uploadposts/youtube/live/broadcasts");

// edit_post on YouTube
await s.call("edit_post", { user: "demo", platform: "youtube", post_id: "v9", text: "New description", params: { localizations: { es: { title: "Hola" } } }, confirmed: true });
assert.equal(last().url, "/uploadposts/posts/edit");
assert.deepEqual(last().data, { localizations: { es: { title: "Hola" } }, user: "demo", platform: "youtube", post_id: "v9", description: "New description" });

// Upload options reach the form
const up = await s.call("upload_video", {
  videoPathOrUrl: "https://example.com/v.mp4",
  user: "demo",
  platforms: ["youtube"],
  scheduledDate: "2026-12-01T10:00:00Z",
  platformOptions: { youtubeLocalizations: { es: { title: "Hola", description: "Desc" } }, youtubeBrandPartner: "UC1234567890123456789012" },
});
assert.equal(up.ignored_platform_options, undefined, JSON.stringify(up));
const f = s.uploads.at(-1);
assert.equal(f.youtube_localizations, JSON.stringify({ es: { title: "Hola", description: "Desc" } }));
assert.equal(f.youtube_brand_partner, "UC1234567890123456789012");

await s.close();
console.log("check-youtube: ok");
