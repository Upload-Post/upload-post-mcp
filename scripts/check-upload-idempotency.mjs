#!/usr/bin/env node
/**
 * Regression check for retried uploads: every upload tool sends an
 * Idempotency-Key derived from its arguments, so a call repeated after a
 * client timeout is answered with the first upload instead of publishing
 * again:
 *   - the same arguments give the same key, whatever their order;
 *   - different arguments (or another tool) give another key;
 *   - the key is not the confirmation flag: preview + confirmed call match;
 *   - it holds within one 10-minute window and changes in the next one, so a
 *     deliberate repeat later publishes again.
 * The SDK's HTTP call is replaced by an in-memory fake. Run after `npm run build`.
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { UploadPostMcpClient } from "../dist/client.js";
import { idempotencyClock } from "../dist/tools/upload.js";

const WINDOW_MS = 10 * 60 * 1000;
let now = 2000 * WINDOW_MS + 1000; // just after a window starts
idempotencyClock.now = () => now;

const sent = [];
const upClient = new UploadPostMcpClient({ apiKey: "test", baseUrl: "https://example.invalid/api" });
upClient.sdk._request = async (endpoint, method, form, isForm, headers = {}) => {
  sent.push({ endpoint, key: headers["Idempotency-Key"] });
  return { success: true, request_id: "r1" };
};
upClient.request = async () => ({ success: true, profiles: [] });

const server = buildServer(upClient);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: "claude-ai", version: "0.0.0-test" });
await client.connect(clientTransport);

async function keyFor(name, args) {
  const before = sent.length;
  const res = await client.callTool({ name, arguments: { ...args, confirmed: true } });
  assert.ok(!res.isError, `${name}: ${res.content?.[0]?.text}`);
  assert.equal(sent.length, before + 1, `${name} sent one upload`);
  return sent.at(-1).key;
}

const calls = {
  upload_video: { videoPathOrUrl: "https://example.com/v.mp4", user: "demo", platforms: ["youtube"], title: "t" },
  upload_photos: { photosPathsOrUrls: ["https://example.com/a.jpg"], user: "demo", platforms: ["instagram"], title: "t" },
  upload_text: { title: "t", user: "demo", platforms: ["linkedin"] },
  upload_document: { documentPathOrUrl: "https://example.com/d.pdf", title: "t", user: "demo" },
};

const keys = new Set();
for (const [name, args] of Object.entries(calls)) {
  const key = await keyFor(name, args);
  assert.ok(typeof key === "string" && key.length >= 16 && key.length <= 200, `${name} sends an Idempotency-Key`);
  // Same arguments in another order: same key.
  const reordered = Object.fromEntries(Object.entries(args).reverse());
  assert.equal(await keyFor(name, reordered), key, `${name}: same arguments, same key`);
  // Any change: another key.
  assert.notEqual(await keyFor(name, { ...args, title: "t2" }), key, `${name}: other arguments, other key`);
  keys.add(key);
}
assert.equal(keys.size, Object.keys(calls).length, "each tool gets its own key");

// Nested options count too, in any order.
const withOptions = { ...calls.upload_video, platformOptions: { youtubePrivacyStatus: "private", youtubeTags: ["a", "b"] } };
const k1 = await keyFor("upload_video", withOptions);
const k2 = await keyFor("upload_video", {
  ...calls.upload_video,
  platformOptions: { youtubeTags: ["a", "b"], youtubePrivacyStatus: "private" },
});
assert.equal(k1, k2);
assert.notEqual(
  await keyFor("upload_video", { ...calls.upload_video, platformOptions: { youtubePrivacyStatus: "private", youtubeTags: ["b", "a"] } }),
  k1,
  "array order matters"
);

// Time window: same window, same key; next window, another key.
const base = await keyFor("upload_text", calls.upload_text);
now += WINDOW_MS - 2000; // later, still in the same window
assert.equal(await keyFor("upload_text", calls.upload_text), base, "same window, same key");
now += 2000; // next window
assert.notEqual(await keyFor("upload_text", calls.upload_text), base, "next window, another key");

// The tool descriptions say what a repeated call does.
const { tools } = await client.listTools();
for (const name of ["upload_video", "upload_photos", "upload_text"]) {
  const tool = tools.find((t) => t.name === name);
  assert.match(tool.description, /idempotent_replay/, `${name} documents the replay`);
  assert.match(tool.description, /following minutes/, `${name} says the replay is for a short time`);
  assert.match(tool.description, /retry_post/, `${name} points failed uploads to retry_post`);
  assert.doesNotMatch(tool.description, /within 24 hours is taken as a retry/, name);
}

console.log("check-upload-idempotency: ok");
process.exit(0);
