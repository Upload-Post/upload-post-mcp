#!/usr/bin/env node
/**
 * Regression check for native commercial disclosure (paid partnership / branded
 * content) in the upload tools:
 *   - `paidPartnership` and `facebookSponsorId` are platformOptions of video,
 *     photo and text posts; `pinterestSponsorId` of video and photo posts only
 *     (Pinterest takes no text posts);
 *   - the descriptions tell an agent which platform takes which field and that
 *     Instagram has no API field for it;
 *   - with an installed `upload-post` SDK that reads the keys (>= 2.20.0) they
 *     reach the API form as paid_partnership / facebook_sponsor_id /
 *     pinterest_sponsor_id; with an older SDK they are reported in
 *     `ignored_platform_options` instead of vanishing.
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
upClient.request = async () => ({ success: true, profiles: [] });

const server = buildServer(upClient);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: "claude-ai", version: "0.0.0-test" });
await client.connect(clientTransport);

const parse = (res) => JSON.parse(res.content[0].text);
const tools = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
const optionProps = (tool) => tools.get(tool).inputSchema.properties.platformOptions.properties;

// --- schema -------------------------------------------------------------
for (const tool of ["upload_video", "upload_photos", "upload_text"]) {
  const props = optionProps(tool);
  assert.equal(props.paidPartnership.type, "boolean", `${tool}: paidPartnership is a boolean`);
  assert.equal(props.facebookSponsorId.type, "string", `${tool}: facebookSponsorId is a string`);
}
for (const tool of ["upload_video", "upload_photos"]) {
  assert.equal(optionProps(tool).pinterestSponsorId.type, "string", `${tool}: pinterestSponsorId is a string`);
}
assert.equal(optionProps("upload_text").pinterestSponsorId, undefined, "Pinterest takes no text posts");

const pp = optionProps("upload_video").paidPartnership.description;
assert.match(pp, /TikTok/);
assert.match(pp, /YouTube/);
assert.match(pp, /Instagram has no API field/);
assert.match(pp, /facebookSponsorId/);
assert.match(pp, /SELF_ONLY/);
assert.match(optionProps("upload_video").facebookSponsorId.description, /Reels and Stories have no such field/);

// --- delivery -----------------------------------------------------------
const args = {
  videoPathOrUrl: "https://example.com/v.mp4",
  user: "demo",
  platforms: ["tiktok", "youtube", "facebook", "pinterest"],
  title: "t",
  platformOptions: {
    paidPartnership: true,
    facebookPageId: "123",
    facebookMediaType: "VIDEO",
    facebookSponsorId: "987654321",
    pinterestBoardId: "b1",
    pinterestSponsorId: "555",
  },
  confirmed: true,
};
const result = parse(await client.callTool({ name: "upload_video", arguments: args }));
assert.equal(sent.length, 1);
const f = sent[0].fields;

const keys = sdkOptionKeys();
if (keys.has("paidPartnership")) {
  assert.equal(f.paid_partnership, "true");
  assert.equal(f.facebook_sponsor_id, "987654321");
  assert.equal(f.pinterest_sponsor_id, "555");
  assert.equal(result.ignored_platform_options, undefined, "no warning when every key is known");
  console.log("check-commercial-disclosure: ok (SDK sends the fields)");
} else {
  // upload-post < 2.20.0: the SDK has no mapping yet. The server must say so.
  assert.equal(f.paid_partnership, undefined);
  assert.deepEqual(
    [...result.ignored_platform_options].sort(),
    ["facebookSponsorId", "paidPartnership", "pinterestSponsorId"]
  );
  assert.match(result.platform_options_warning, /NOT sent/);
  console.log("check-commercial-disclosure: ok (installed upload-post predates the fields: reported as not sent)");
}
