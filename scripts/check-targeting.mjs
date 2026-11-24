#!/usr/bin/env node
/**
 * Regression check for country / audience targeting (0.27.4):
 *   - every client but ChatGPT sees facebookTargeting / facebookFeedTargeting
 *     and the linkedinTarget* keys on upload_video / upload_photos /
 *     upload_text, and the linkedinTarget* keys on upload_document;
 *   - the { countries: [...] } shortcut reaches the form as Graph's
 *     { geo_locations: { countries } } (UK sent as GB), raw Graph JSON and the
 *     snake_case spelling pass through, LinkedIn URNs reach the form;
 *   - a country that is not an ISO 3166-1 alpha-2 code is refused before
 *     anything is sent.
 * The SDK's HTTP call is replaced by an in-memory fake. Run after `npm run build`.
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { UploadPostMcpClient } from "../dist/client.js";
import { normalizeFacebookTargeting } from "../dist/targeting.js";

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
  const client = new Client({ name, version: "0.0.0-test" });
  await client.connect(clientTransport);
  const tools = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
  return { client, sent, tools };
}

const parse = (res) => JSON.parse(res.content[0].text);

// ---- Pure normalization ------------------------------------------------------
assert.deepEqual(normalizeFacebookTargeting("f", { countries: ["uk", "US", "GB"] }), {
  geo_locations: { countries: ["GB", "US"] },
});
assert.deepEqual(normalizeFacebookTargeting("f", ["ES"]), { geo_locations: { countries: ["ES"] } });
assert.deepEqual(normalizeFacebookTargeting("f", '{"countries":"fr, de"}'), {
  geo_locations: { countries: ["FR", "DE"] },
});
assert.deepEqual(
  normalizeFacebookTargeting("f", { countries: ["DE"], geo_locations: { countries: ["FR"], cities: [{ key: "1" }] }, age_min: 18 }),
  { geo_locations: { countries: ["FR", "DE"], cities: [{ key: "1" }] }, age_min: 18 },
  "shortcut merges into raw geo_locations, other keys kept"
);
const raw = { geo_locations: { countries: ["US"] }, locales: [6] };
assert.deepEqual(normalizeFacebookTargeting("f", raw), raw, "raw Graph targeting passes untouched");
assert.throws(() => normalizeFacebookTargeting("f", { countries: ["USA"] }), /ISO 3166-1 alpha-2/);
assert.throws(() => normalizeFacebookTargeting("f", { countries: [] }), /empty/);
assert.throws(() => normalizeFacebookTargeting("f", "not json"), /must be an object/);

// ---- ChatGPT keeps the reviewed schemas --------------------------------------
{
  const { client, tools } = await connect("openai-mcp");
  const opts = tools.get("upload_video").inputSchema.properties.platformOptions.properties;
  assert.equal(opts.facebookTargeting, undefined, "ChatGPT does not see facebookTargeting yet");
  assert.equal(opts.linkedinTargetGeoLocations, undefined);
  await client.close();
}

// ---- Other clients -----------------------------------------------------------
const { client, sent, tools } = await connect("claude-ai");
for (const name of ["upload_video", "upload_photos", "upload_text"]) {
  const opts = tools.get(name).inputSchema.properties.platformOptions.properties;
  for (const key of ["facebookTargeting", "facebookFeedTargeting", "linkedinTargetGeoLocations", "linkedinTargetIndustries", "linkedinTargetCheckAudience"]) {
    assert.ok(opts[key], `${name} platformOptions has ${key}`);
  }
  assert.match(opts.facebookTargeting.description, /only for UK and US/);
}
const docProps = tools.get("upload_document").inputSchema.properties;
assert.ok(docProps.linkedinTargetGeoLocations, "upload_document has linkedinTargetGeoLocations");
assert.equal(docProps.facebookTargeting, undefined, "upload_document is LinkedIn only");

// Photos to Facebook + LinkedIn, countries shortcut.
const photo = parse(
  await client.callTool({
    name: "upload_photos",
    arguments: {
      photosPathsOrUrls: ["https://example.com/a.jpg"],
      user: "demo",
      platforms: ["facebook", "linkedin"],
      title: "t",
      platformOptions: {
        facebookPageId: "123",
        facebookTargeting: { countries: ["UK", "us"] },
        facebookFeedTargeting: { geo_locations: { countries: ["FR"] }, age_min: 21 },
        targetLinkedinPageId: "456",
        linkedinTargetGeoLocations: ["urn:li:geo:103644278", "urn:li:geo:101165590"],
        linkedinTargetCheckAudience: true,
      },
      confirmed: true,
    },
  })
);
assert.equal(sent.length, 1);
let f = sent[0].fields;
assert.deepEqual(JSON.parse(f.facebook_targeting), { geo_locations: { countries: ["GB", "US"] } });
assert.deepEqual(JSON.parse(f.facebook_feed_targeting), { geo_locations: { countries: ["FR"] }, age_min: 21 });
assert.deepEqual(JSON.parse(f.linkedin_target_geo_locations), ["urn:li:geo:103644278", "urn:li:geo:101165590"]);
assert.equal(f.linkedin_target_check_audience, "true");
assert.equal(photo.ignored_platform_options, undefined, "targeting keys are not reported as ignored");

// Video, same shortcut.
await client.callTool({
  name: "upload_video",
  arguments: {
    videoPathOrUrl: "https://example.com/v.mp4",
    user: "demo",
    platforms: ["facebook"],
    title: "t",
    platformOptions: { facebookPageId: "123", facebookMediaType: "REELS", facebookTargeting: { countries: ["GB", "US"] } },
    confirmed: true,
  },
});
f = sent[1].fields;
assert.deepEqual(JSON.parse(f.facebook_targeting), { geo_locations: { countries: ["GB", "US"] } });

// Text, snake_case key as a JSON string (what an agent copying the REST docs sends).
await client.callTool({
  name: "upload_text",
  arguments: {
    title: "hello",
    user: "demo",
    platforms: ["facebook", "linkedin"],
    platformOptions: {
      facebook_targeting: '{"countries":["DE"]}',
      linkedinTargetGeoLocations: "urn:li:geo:101282230",
      linkedinTargetSeniorities: ["urn:li:seniority:8"],
    },
    confirmed: true,
  },
});
f = sent[2].fields;
assert.deepEqual(JSON.parse(f.facebook_targeting), { geo_locations: { countries: ["DE"] } });
assert.equal(f.linkedin_target_geo_locations, "urn:li:geo:101282230");
assert.deepEqual(JSON.parse(f.linkedin_target_seniorities), ["urn:li:seniority:8"]);

// Document: top-level LinkedIn targeting.
await client.callTool({
  name: "upload_document",
  arguments: {
    documentPathOrUrl: "https://example.com/d.pdf",
    title: "Deck",
    user: "demo",
    targetLinkedinPageId: "456",
    linkedinTargetGeoLocations: ["urn:li:geo:103644278"],
    confirmed: true,
  },
});
f = sent[3].fields;
assert.deepEqual(JSON.parse(f.linkedin_target_geo_locations), ["urn:li:geo:103644278"]);

// A bad country code is refused and nothing is sent.
const bad = await client.callTool({
  name: "upload_text",
  arguments: {
    title: "hello",
    user: "demo",
    platforms: ["facebook"],
    platformOptions: { facebookTargeting: { countries: ["USA"] } },
    confirmed: true,
  },
});
assert.match(bad.content[0].text, /ISO 3166-1 alpha-2/);
assert.equal(sent.length, 4, "nothing sent for an invalid country code");

await client.close();
console.log("check-targeting: ok");
