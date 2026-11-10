#!/usr/bin/env node
/**
 * Regression check for platformOptions that agents reported as silently
 * dropped (send_feedback, 2026-11-09/10):
 *   - YouTube native scheduling and notify flag, Instagram trial Reels and AI
 *     label, Facebook photo stories reach the API form under the right names;
 *   - unknown keys are listed in `ignored_platform_options`, both in the
 *     confirmation preview and in the upload result.
 * The SDK's HTTP call is replaced by an in-memory fake. Run after `npm run build`.
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { UploadPostMcpClient } from "../dist/client.js";
import { sdkOptionKeys } from "../dist/sdk-options.js";

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

const sent = [];
const upClient = new UploadPostMcpClient({ apiKey: "test", baseUrl: "https://example.invalid/api" });
upClient.sdk._request = async (endpoint, method, form) => {
  sent.push({ endpoint, fields: formFields(form) });
  return { success: true, request_id: "r1" };
};
// list_users-style lookups some upload paths make: keep them offline.
upClient.request = async () => ({ success: true, profiles: [] });

const server = buildServer(upClient);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: "claude-ai", version: "0.0.0-test" });
await client.connect(clientTransport);

const parse = (res) => JSON.parse(res.content[0].text);

// The key list comes from the installed SDK source.
const keys = sdkOptionKeys();
for (const k of ["youtubePublishAt", "youtubeNotifySubscribers", "instagramShareMode", "instagramIsAiGenerated", "facebookMediaType", "tiktokIsAiGenerated", "linkedinPageId"]) {
  assert.ok(keys.has(k), `SDK key list includes ${k}`);
}
assert.ok(!keys.has("instagramTrialMode"), "made-up keys are not in the list");

const videoArgs = {
  videoPathOrUrl: "https://example.com/v.mp4",
  user: "demo",
  platforms: ["youtube", "instagram"],
  title: "t",
  platformOptions: {
    youtubePrivacyStatus: "private",
    youtubePublishAt: "2026-12-01T10:00:00Z",
    youtubeNotifySubscribers: false,
    instagramMediaType: "REELS",
    instagramShareMode: "TRIAL_REELS_DONT_SHARE_TO_FOLLOWERS",
    instagramIsAiGenerated: true,
    instagramTrialMode: "yes",
  },
};

// Preview: nothing is sent and the bogus key is flagged before approval.
const preview = parse(await client.callTool({ name: "upload_video", arguments: videoArgs }));
assert.equal(preview.status, "confirmation_required");
assert.deepEqual(preview.ignored_platform_options, ["instagramTrialMode"]);
assert.equal(sent.length, 0, "preview sends nothing");

const result = parse(await client.callTool({ name: "upload_video", arguments: { ...videoArgs, confirmed: true } }));
assert.equal(sent.length, 1);
const v = sent[0].fields;
assert.equal(v.youtube_publish_at, "2026-12-01T10:00:00Z");
assert.equal(v.youtube_notify_subscribers, "false");
assert.equal(v.share_mode, "TRIAL_REELS_DONT_SHARE_TO_FOLLOWERS");
assert.equal(v.is_ai_generated, "true");
assert.deepEqual(result.ignored_platform_options, ["instagramTrialMode"]);
assert.match(result.platform_options_warning, /NOT sent/);
assert.equal(result.request_id, "r1", "the upload result is kept");

// Photos: Facebook story and no warning when every key is known.
const photo = parse(
  await client.callTool({
    name: "upload_photos",
    arguments: {
      photosPathsOrUrls: ["https://example.com/a.jpg"],
      user: "demo",
      platforms: ["facebook", "instagram"],
      title: "t",
      platformOptions: { facebookPageId: "123", facebookMediaType: "STORIES", instagramIsAiGenerated: true },
      confirmed: true,
    },
  })
);
const p = sent[1].fields;
assert.equal(p.facebook_media_type, "STORIES");
assert.equal(p.is_ai_generated, "true");
assert.equal(photo.ignored_platform_options, undefined, "no warning when all keys are known");

console.log("check-platform-options: ok");
