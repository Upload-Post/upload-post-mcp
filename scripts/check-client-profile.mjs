#!/usr/bin/env node
/**
 * Regression check for the per-client tool surface.
 *
 * The Upload Studio widget only works in ChatGPT (Apps SDK bridge), so it must
 * never be advertised to any other host — those try to render it as an MCP App
 * and show the user "Upload Post MCP cannot be reached". Run after `npm run build`.
 */
import assert from "node:assert/strict";
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
  assert.deepEqual(
    tools.get("create_media_upload")._meta.ui.visibility,
    ["model", "app"],
    `${name} must expose media staging to the model`
  );
}

console.log("client profile surfaces OK");
