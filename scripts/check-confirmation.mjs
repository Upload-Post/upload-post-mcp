#!/usr/bin/env node
/**
 * Regression check for the confirmation step (Anthropic directory review,
 * 2026-10-27).
 *
 * Tools that publish or reach other people as the user must not run until the
 * call carries `confirmed: true` (delete_user: `confirm_username`); without it
 * they return a preview and touch nothing. ChatGPT keeps the surface OpenAI
 * reviewed. Reddit is not a publish target while the app is down. Run after
 * `npm run build`.
 *
 * The Upload-Post SDK and raw API are replaced by in-memory fakes, so nothing
 * leaves the process.
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { UploadPostMcpClient } from "../dist/client.js";
import { GATES } from "../dist/confirm.js";

async function connect(clientName = "claude-ai") {
  const calls = [];
  const upClient = new UploadPostMcpClient({ apiKey: "test", baseUrl: "https://example.invalid" });
  for (const m of ["upload", "uploadPhotos", "uploadText", "uploadDocument", "deleteUser"]) {
    upClient.sdk[m] = async (...args) => {
      calls.push([m, ...args]);
      return { success: true };
    };
  }
  upClient.request = async (method, path, opts) => {
    calls.push([method, path, opts]);
    return { success: true };
  };
  const server = buildServer(upClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: clientName, version: "0.0.0-test" });
  await client.connect(clientTransport);
  const tools = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
  return {
    client,
    calls,
    tools,
    async call(name, args = {}) {
      const res = await client.callTool({ name, arguments: args });
      return {
        isError: res.isError === true,
        text: res.content.map((c) => c.text).join("\n"),
        result: res.structuredContent?.result,
      };
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function assertPreview(r, label) {
  assert.equal(r.isError, false, `${label}: a preview is not an error`);
  assert.equal(r.result.status, "confirmation_required", `${label}: status`);
  assert.equal(r.result.executed, false, `${label}: executed`);
  assert.match(r.result.next_step, /Nothing has been (sent|deleted)/, `${label}: next_step`);
}

// --- surface: every gated tool advertises its confirmation argument ----------
{
  const s = await connect("claude-ai");
  for (const [name, gate] of Object.entries(GATES)) {
    const tool = s.tools.get(name);
    assert.ok(tool, `claude-ai must see ${name}`);
    const field = gate.field ?? "confirmed";
    assert.ok(tool.inputSchema.properties[field], `${name} must accept ${field}`);
    assert.match(tool.description, /Needs the user's approval/, `${name} description must say so`);
  }
  assert.ok(!s.tools.has("delete_media_upload"), "delete_media_upload is a Studio helper, not for Claude");
  assert.equal(s.tools.get("get_account_info").title, "Get account info");
  assert.doesNotMatch(s.tools.get("get_account_info").description, /API key/);
  assert.doesNotMatch(s.tools.get("comment_action").description, /nothing here is permanent/);
  assert.match(s.tools.get("submit_ffmpeg_job").description, /\{output\}/);
  await s.close();
}

// --- ChatGPT keeps the reviewed surface ----------------------------------------
{
  const s = await connect("openai-mcp");
  for (const name of Object.keys(GATES)) {
    const tool = s.tools.get(name);
    if (!tool) continue; // comment_action / manage_autodms are not served to ChatGPT
    assert.ok(!tool.inputSchema.properties.confirmed, `ChatGPT ${name} must not gain confirmed`);
    assert.doesNotMatch(tool.description, /Needs the user's approval/, `ChatGPT ${name} description unchanged`);
  }
  assert.ok(s.tools.has("delete_media_upload"), "the Studio still deletes its staging uploads");
  const r = await s.call("upload_text", { user: "marca", platforms: ["x"], title: "hola" });
  assert.equal(r.isError, false);
  assert.equal(s.calls.length, 1, "ChatGPT publishes on the first call");
  await s.close();
}

// --- uploads: preview first, publish only when confirmed -----------------------
{
  const s = await connect();
  const args = { user: "marca", platforms: ["x", "linkedin"], title: "Hola mundo" };
  const preview = await s.call("upload_text", args);
  assertPreview(preview, "upload_text");
  assert.match(preview.result.action, /Publishes IMMEDIATELY a text post as profile "marca" on x, linkedin/);
  assert.equal(preview.result.preview.title, "Hola mundo");
  assert.equal(s.calls.length, 0, "nothing is published without confirmed");

  const notYet = await s.call("upload_text", { ...args, confirmed: false });
  assertPreview(notYet, "upload_text confirmed:false");
  assert.equal(s.calls.length, 0);

  const scheduled = await s.call("upload_text", { ...args, scheduledDate: "2026-12-25T10:00:00Z" });
  assert.match(scheduled.result.action, /^Schedules for 2026-12-25T10:00:00Z/);

  const done = await s.call("upload_text", { ...args, confirmed: true });
  assert.equal(done.isError, false);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0][0], "uploadText");
  assert.ok(!JSON.stringify(s.calls[0]).includes("confirmed"), "confirmed never reaches the API");

  const video = await s.call("upload_video", {
    user: "marca", platforms: ["tiktok"], title: "x", firstComment: "primero", videoBase64: "A".repeat(5000),
  });
  assert.equal(video.result.preview.firstComment, "primero", "the first comment is part of what the user approves");
  assertPreview(video, "upload_video");
  assert.equal(video.result.preview.videoBase64, "<5000 base64 characters>", "file bytes are not echoed");

  const doc = await s.call("upload_document", { user: "marca", title: "Deck", documentPathOrUrl: "https://example.invalid/a.pdf" });
  assert.match(doc.result.action, /a document as profile "marca" on LinkedIn/);
  await s.close();
}

// --- messages to other people ----------------------------------------------------
{
  const s = await connect();
  const dm = await s.call("send_dm", {
    user: "marca", platform: "instagram", recipient_id: "123", message: "hola",
    buttons: [{ title: "Web", url: "https://example.com" }],
  });
  assertPreview(dm, "send_dm");
  assert.deepEqual(dm.result.preview.buttons, [{ title: "Web", url: "https://example.com" }]);
  for (const [name, args] of [
    ["reply_to_comment", { user: "marca", commentId: "c1", message: "hola" }],
    ["public_reply_to_comment", { user: "marca", commentId: "c1", message: "hola" }],
    ["create_comment", { user: "marca", platform: "facebook", postId: "p1", message: "hola" }],
    ["reply_to_google_business_review", { user: "marca", review_name: "accounts/1/locations/2/reviews/3", comment: "gracias" }],
    ["edit_comment", { user: "marca", platform: "facebook", commentId: "c1", message: "nuevo" }],
    ["unpublish_post", { user: "marca", platform: "x", postId: "999" }],
  ]) {
    assertPreview(await s.call(name, args), name);
  }
  assert.equal(s.calls.length, 0, "no message, comment or deletion went out");

  const sent = await s.call("send_dm", {
    user: "marca", platform: "instagram", recipient_id: "123", message: "hola", confirmed: true,
  });
  assert.equal(sent.isError, false);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0][1], "/uploadposts/dms/send");
  assert.equal(s.calls[0][2].body.confirmed, undefined, "confirmed never reaches the API");
  await s.close();
}

// --- multi-action tools gate only the risky actions ----------------------------
{
  const s = await connect();
  await s.call("manage_autodms", { action: "status" });
  await s.call("comment_action", { user: "marca", platform: "tiktok", commentId: "c1", action: "like" });
  await s.call("hide_comment", { user: "marca", platform: "youtube", commentId: "c1", postId: "v1" });
  assert.equal(s.calls.length, 3, "read and reversible actions run straight away");

  const start = await s.call("manage_autodms", {
    action: "start", profile_username: "marca", post_url: "https://instagram.com/p/x",
    reply_message: "Aquí tienes el enlace", trigger_keywords: ["LINK"],
    buttons: [{ title: "Guía", url: "https://example.com" }],
  });
  assertPreview(start, "manage_autodms start");
  assert.match(start.result.action, /answers comments containing LINK .* with a private Instagram DM, within seconds of each new comment/);
  assert.equal(start.result.preview.reply_message, "Aquí tienes el enlace");

  const everyone = await s.call("start_autodm", {
    profile_username: "marca", platform: "youtube", post_id: "v1", reply_message: "gracias",
  });
  assert.match(everyone.result.action, /answers EVERY comment .* with a PUBLIC reply on youtube, every 15 minutes/);

  assertPreview(await s.call("comment_action", {
    user: "marca", platform: "facebook", commentId: "c1", action: "edit", message: "nuevo",
  }), "comment_action edit");
  assertPreview(await s.call("comment_action", {
    user: "marca", platform: "youtube", commentId: "c1", postId: "v1", action: "hide", banAuthor: true,
  }), "comment_action ban");
  assertPreview(await s.call("hide_comment", {
    user: "marca", platform: "youtube", commentId: "c1", postId: "v1", banAuthor: true,
  }), "hide_comment ban");
  assert.equal(s.calls.length, 3, "no gated action ran");

  await s.call("manage_autodms", {
    action: "start", profile_username: "marca", post_url: "https://instagram.com/p/x",
    reply_message: "hola", confirmed: true,
  });
  assert.equal(s.calls.length, 4);
  assert.equal(s.calls[3][1], "/uploadposts/autodms/start");
  assert.equal(s.calls[3][2].body.confirmed, undefined);
  await s.close();
}

// --- delete_user: the profile name, repeated ------------------------------------
{
  const s = await connect();
  assertPreview(await s.call("delete_user", { username: "marca" }), "delete_user");
  assertPreview(await s.call("delete_user", { username: "marca", confirm_username: "otra" }), "delete_user wrong name");
  assert.equal(s.calls.length, 0, "nothing deleted");
  const r = await s.call("delete_user", { username: "marca", confirm_username: "marca" });
  assert.equal(r.isError, false);
  assert.deepEqual(s.calls, [["deleteUser", "marca"]]);
  await s.close();
}

// --- Reddit is a state, not an instruction ---------------------------------------
for (const clientName of ["claude-ai", "openai-mcp"]) {
  const s = await connect(clientName);
  for (const name of ["upload_video", "upload_photos", "upload_text"]) {
    const platforms = s.tools.get(name).inputSchema.properties.platforms.items.enum;
    assert.ok(platforms.includes("x") || platforms.includes("tiktok"), `${name} lists platforms`);
    assert.ok(!platforms.includes("reddit"), `${clientName} ${name} must not offer reddit`);
  }
  const r = await s.call("upload_text", { user: "marca", platforms: ["reddit"], title: "hola", confirmed: true });
  assert.equal(r.isError, true);
  assert.match(r.text, /reddit_unavailable/);
  assert.equal(s.calls.length, 0);
  assert.match(s.tools.get("get_reddit_detailed_posts").description, /^Recent Reddit posts/);
  if (clientName === "openai-mcp") {
    const studio = await s.client.readResource({ uri: "ui://upload-post/video-upload-studio.html" });
    const html = studio.contents[0].text;
    assert.ok(html.includes('["bluesky", "Bluesky"'), "the Studio still lists its platforms");
    assert.ok(!html.includes('"reddit", "Reddit"'), "the Studio must not offer reddit");
  }
  await s.close();
}
{
  const s = await connect("claude-ai");
  assert.doesNotMatch(s.tools.get("upload_text").description, /Do not use reddit/);
  assert.doesNotMatch(s.tools.get("upload_video").description, /Do not use reddit/);
  await s.close();
}

console.log("confirmation gates OK");
