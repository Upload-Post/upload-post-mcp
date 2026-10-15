#!/usr/bin/env node
/**
 * Regression check for the per-client tool surface.
 *
 * The Upload Studio widget only works in ChatGPT (Apps SDK bridge), so it must
 * never be advertised to any other host — those try to render it as an MCP App
 * and show the user "Upload Post MCP cannot be reached". Run after `npm run build`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { UploadPostMcpClient } from "../dist/client.js";

async function surfaceFor(clientName) {
  const server = buildServer(
    new UploadPostMcpClient({ apiKey: "test", baseUrl: "https://example.invalid" })
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: clientName, version: "0.0.0-test" });
  await client.connect(clientTransport);
  const tools = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
  const resources = (await client.listResources()).resources.map((r) => r.uri);
  await client.close();
  await server.close();
  return { tools, resources };
}

const chatgpt = await surfaceFor("openai-mcp");
assert.ok(chatgpt.tools.has("open_upload_studio"), "ChatGPT must keep the Studio tool");
assert.ok(
  chatgpt.resources.includes("ui://upload-post/video-upload-studio.html"),
  "ChatGPT must keep the Studio ui:// resource"
);
assert.ok(
  chatgpt.tools.get("upload_video").description.includes("open_upload_studio"),
  "ChatGPT upload_video must point at the Studio"
);

const chatgptPhotos = chatgpt.tools.get("upload_photos");
assert.ok(
  chatgptPhotos.description.includes("open_upload_studio"),
  "ChatGPT upload_photos must point at the Studio for attached images"
);
assert.equal(
  chatgptPhotos._meta["openai/widgetAccessible"],
  true,
  "the Studio publishes photos through upload_photos, so the widget must be allowed to call it"
);
assert.ok(
  chatgpt.tools.get("open_upload_studio").inputSchema.properties.mediaType,
  "open_upload_studio must accept mediaType (video | photos)"
);

for (const name of ["claude-ai", "Claude Code", "cursor-vscode", "unknown-host"]) {
  const { tools, resources } = await surfaceFor(name);
  assert.ok(!tools.has("open_upload_studio"), `${name} must not see the Studio tool`);
  assert.equal(resources.length, 0, `${name} must not see the Studio ui:// resource`);
  const uploadVideo = tools.get("upload_video").description;
  assert.ok(!uploadVideo.includes("open_upload_studio"), `${name} upload_video must not name the Studio`);
  assert.ok(
    uploadVideo.includes("create_media_upload"),
    `${name} upload_video must point at media staging`
  );
  const uploadPhotos = tools.get("upload_photos").description;
  assert.ok(!uploadPhotos.includes("open_upload_studio"), `${name} upload_photos must not name the Studio`);
  assert.ok(uploadPhotos.includes("create_media_upload"), `${name} upload_photos must point at media staging`);
  assert.deepEqual(
    tools.get("create_media_upload")._meta.ui.visibility,
    ["model", "app"],
    `${name} must expose media staging to the model`
  );
}

// The one-operation comment and AutoDM tools sit next to the older multi-action
// tools; clients that already call comment_action or manage_autodms keep working.
for (const name of [
  "comment_action", "manage_autodms",
  "hide_comment", "like_comment", "pin_comment", "edit_comment", "hold_comment",
  "approve_comment", "ignore_comment", "set_post_comments",
  "start_autodm", "list_autodms", "get_autodm_logs", "pause_autodm",
  "resume_autodm", "stop_autodm", "delete_autodm",
]) {
  assert.ok(chatgpt.tools.has(name), `ChatGPT must expose ${name}`);
}

// Annotations declared in the ChatGPT submission must match what the server serves.
const submission = JSON.parse(
  readFileSync(new URL("../chatgpt-app-submission.json", import.meta.url), "utf8")
);
for (const [name, tool] of chatgpt.tools) {
  const declared = submission.tools[name];
  assert.ok(declared, `chatgpt-app-submission.json is missing ${name}`);
  for (const hint of ["readOnlyHint", "openWorldHint", "destructiveHint"]) {
    assert.equal(
      tool.annotations?.[hint],
      declared.annotations[hint],
      `${name}.${hint} differs between the server and chatgpt-app-submission.json`
    );
  }
}

console.log("client profile surfaces OK");
