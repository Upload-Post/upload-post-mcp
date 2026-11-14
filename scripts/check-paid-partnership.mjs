#!/usr/bin/env node
/**
 * Native commercial disclosure (paid partnership / branded content, TT-988).
 *
 * - The upload tools advertise paidPartnership, facebookSponsorId and
 *   pinterestSponsorId, and the YouTube option no longer promises FTC compliance.
 * - The values reach the API form under the API field names. The SDK builds the
 *   form from a whitelist: with an SDK older than the release that added these
 *   keys, they are dropped and the result must say so (ignored_platform_options)
 *   instead of pretending they were applied. Both states are checked, so the
 *   check stays true while the dependency is being upgraded.
 * Run after `npm run build`.
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

// 1) The tool schemas advertise the new keys (platformOptions is flat).
const tools = (await client.listTools()).tools;
const schemaText = (name) => JSON.stringify(tools.find((t) => t.name === name)?.inputSchema ?? {});
for (const name of ["upload_video", "upload_photos"]) {
  const text = schemaText(name);
  for (const key of ["paidPartnership", "facebookSponsorId", "pinterestSponsorId"]) {
    assert.ok(text.includes(`"${key}"`), `${name} schema lists ${key}`);
  }
}
assert.ok(schemaText("upload_text").includes('"paidPartnership"'), "upload_text schema lists paidPartnership");
assert.ok(!schemaText("upload_video").includes("FTC compliance"), "no FTC-compliance promise");

// 2) The values reach the API form, or are reported as not sent.
const keys = sdkOptionKeys();
const sdkKnows = ["paidPartnership", "facebookSponsorId", "pinterestSponsorId"].every((k) => keys.has(k));
const result = parse(
  await client.callTool({
    name: "upload_video",
    arguments: {
      videoPathOrUrl: "https://example.com/v.mp4",
      user: "demo",
      platforms: ["tiktok", "youtube", "facebook", "pinterest"],
      title: "Sponsored",
      platformOptions: {
        paidPartnership: true,
        facebookPageId: "123",
        facebookMediaType: "VIDEO",
        facebookSponsorId: "987654321",
        pinterestBoardId: "b1",
        pinterestSponsorId: "555",
      },
      confirmed: true,
    },
  })
);
assert.equal(sent.length, 1);
const f = sent[0].fields;
if (sdkKnows) {
  assert.equal(f.paid_partnership, "true");
  assert.equal(f.facebook_sponsor_id, "987654321");
  assert.equal(f.pinterest_sponsor_id, "555");
  assert.equal(result.ignored_platform_options, undefined, "nothing dropped when the SDK knows the keys");
} else {
  assert.equal(f.paid_partnership, undefined);
  assert.deepEqual(
    [...(result.ignored_platform_options ?? [])].sort(),
    ["facebookSponsorId", "paidPartnership", "pinterestSponsorId"],
    "an SDK that drops the keys says so",
  );
}

console.log(`check-paid-partnership: ok (installed SDK ${sdkKnows ? "forwards" : "does not yet forward"} the keys)`);
