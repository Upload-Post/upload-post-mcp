#!/usr/bin/env node
/**
 * Regression check for the Upload-Post phone number tools:
 *   - ChatGPT sees none of them (its surface is the reviewed one);
 *   - each tool hits the documented route with the API's field names;
 *   - buying, sending an SMS and releasing wait for the confirmation step, and
 *     the release still carries the API's own confirm=true;
 *   - a 202 kyc_required / pending_regulatory purchase comes back with a next_step;
 *   - the descriptions say what an agent must know before calling (paid plans,
 *     no emergency calls, US/CA cannot send SMS, the WhatsApp phone-call flow,
 *     release is final) and never name the carrier or an internal switch.
 * The HTTP layer is replaced by an in-memory fake. Run after `npm run build`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { UploadPostMcpClient } from "../dist/client.js";

const TOOLS = ["phone_numbers_read", "purchase_phone_number", "send_sms", "manage_phone_number", "release_phone_number"];
const P = "/uploadposts/phone-numbers";

async function connect(name, { respond, allowLocalFiles = true } = {}) {
  const calls = [];
  const upClient = new UploadPostMcpClient({ apiKey: "test", baseUrl: "https://example.invalid/api", allowLocalFiles });
  upClient.http.request = async (cfg) => {
    calls.push(cfg);
    return respond ? respond(cfg) : { status: 200, data: { success: true } };
  };
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
const result = (r) => r.structuredContent?.result;

// --- ChatGPT keeps its reviewed surface ----------------------------------------
{
  const s = await connect("openai-mcp");
  for (const name of TOOLS) assert.ok(!s.tools.has(name), `ChatGPT must not see ${name}`);
  assert.doesNotMatch(JSON.stringify([...s.tools.values()]), /phone_number|sms_received/, "nothing about phone numbers reaches ChatGPT");
  await s.close();
}

const s = await connect("claude-ai");
for (const name of TOOLS) assert.ok(s.tools.has(name), `claude-ai sees ${name}`);
const ann = (name) => s.tools.get(name).annotations;
const desc = (name) => s.tools.get(name).description;

// --- annotations -------------------------------------------------------------------
assert.deepEqual(
  { r: ann("phone_numbers_read").readOnlyHint, d: ann("phone_numbers_read").destructiveHint, i: ann("phone_numbers_read").idempotentHint },
  { r: true, d: false, i: true },
  "phone_numbers_read is read-only"
);
assert.equal(ann("purchase_phone_number").readOnlyHint, false);
assert.equal(ann("purchase_phone_number").idempotentHint, true, "purchase is idempotent on purchase_intent_id");
assert.equal(ann("send_sms").idempotentHint, false, "each send_sms call sends another message");
assert.equal(ann("manage_phone_number").destructiveHint, false);
assert.equal(ann("release_phone_number").destructiveHint, true, "release is destructive");
for (const name of TOOLS) assert.equal(ann(name).openWorldHint, true, `${name} reaches the outside world`);

// --- what the descriptions must say ---------------------------------------------
const all = TOOLS.map(desc).join(" ");
assert.match(desc("purchase_phone_number"), /Paid plans only/);
assert.match(desc("purchase_phone_number"), /emergency services \(112 \/ 911\)/);
assert.match(desc("purchase_phone_number"), /kyc_required/);
assert.match(desc("purchase_phone_number"), /purchase_intent_id/);
assert.match(desc("send_sms"), /US and Canadian numbers cannot send SMS yet/);
assert.match(desc("manage_phone_number"), /\*\*Phone call\*\* \(not SMS\)/);
assert.match(desc("manage_phone_number"), /poll phone_numbers_read `codes`/);
assert.match(desc("release_phone_number"), /FINAL and cannot be undone/);
assert.match(desc("phone_numbers_read"), /sms_received, call_received, voicemail_received/);
assert.doesNotMatch(all, /USD cents|totals? in USD|_usd\b/, "prices and usage are in the billing currency, not USD");
assert.match(desc("phone_numbers_read"), /billing currency[\s\S]*409 phone_numbers_currency_unsupported/);
assert.match(desc("phone_numbers_read"), /`total`, and `today` against the account's `daily_cap`/);
assert.match(desc("purchase_phone_number"), /never a profile JWT/);
assert.match(desc("purchase_phone_number"), /202 pending_payment/);
for (const name of ["phone_numbers_read", "purchase_phone_number"]) {
  assert.match(desc(name), /varies by country and number type|vary by country and number type/, `${name}: prices vary`);
  assert.match(desc(name), /1\.5 times[\s\S]*2\.40 gives 3\.60, so 4[\s\S]*7\.30 gives 10\.95, so 11/, `${name}: the price formula`);
}
assert.doesNotMatch(all, /3 to 30/, "no fixed price range suggested as the price");
assert.equal(s.tools.get("phone_numbers_read").inputSchema.properties.limit.type, "integer", "limit is an integer");
for (const name of TOOLS) assert.match(desc(name), /403 phone_numbers_not_available/, `${name} states the availability gate`);
assert.doesNotMatch(all, /tel[n]yx/i, "the carrier is never named");
assert.doesNotMatch(all, /[A-Z][A-Z0-9]*_[A-Z0-9_]*(ENABLED|ALLOWLIST|SCOPES)|PHONE_NUMBERS_|UPLOADPOSTS_/, "no internal switch is named");
assert.match(s.tools.get("create_webhook_subscription").description, /sms_received/, "subscriptions list the phone events");

// --- reads --------------------------------------------------------------------------
await s.call("phone_numbers_read", { action: "config" });
assert.equal(last(s).method, "GET");
assert.equal(last(s).url, `${P}/config`);
await s.call("phone_numbers_read", { action: "search_available", country: "ES", number_type: "mobile", contains: "77", sms: true, limit: 5, number_id: "pn_x" });
assert.equal(last(s).url, `${P}/available`);
assert.deepEqual(last(s).params, { country: "ES", number_type: "mobile", contains: "77", sms: true, limit: 5 }, "only the action's own fields");
let n = s.calls.length;
let r = await s.call("phone_numbers_read", { action: "search_available" });
assert.equal(r.isError, true, "search_available needs a country");
assert.equal(s.calls.length, n, "nothing sent without a country");
await s.call("phone_numbers_read", { action: "kyc_fields", country: "DE", number_type: "local" });
assert.equal(last(s).url, `${P}/kyc`);
await s.call("phone_numbers_read", { action: "list", status: "active", profile_username: "brand" });
assert.equal(last(s).url, P);
assert.deepEqual(last(s).params, { status: "active", profile_username: "brand" });
await s.call("phone_numbers_read", { action: "get", number_id: "pn_1" });
assert.equal(last(s).url, `${P}/pn_1`);
await s.call("phone_numbers_read", { action: "messages", number_id: "pn_1", limit: 20, before: "2026-11-27T10:00:00Z" });
assert.equal(last(s).url, `${P}/pn_1/messages`);
assert.deepEqual(last(s).params, { limit: 20, before: "2026-11-27T10:00:00Z" });
await s.call("phone_numbers_read", { action: "calls", number_id: "pn_1" });
assert.equal(last(s).url, `${P}/pn_1/calls`);
await s.call("phone_numbers_read", { action: "codes", number_id: "pn_1", since: "2026-11-27T10:00:00Z" });
assert.equal(last(s).url, `${P}/pn_1/codes`);
assert.deepEqual(last(s).params, { since: "2026-11-27T10:00:00Z" });
await s.call("phone_numbers_read", { action: "usage", from: "2026-11-01", to: "2026-11-27" });
assert.equal(last(s).url, `${P}/usage`);
await s.call("phone_numbers_read", { action: "port_out_info", number_id: "pn_1" });
assert.equal(last(s).url, `${P}/pn_1/port-out`);
r = await s.call("phone_numbers_read", { action: "codes" });
assert.equal(r.isError, true, "codes needs number_id");

// --- purchase: preview, then the API call -------------------------------------------
const endUser = {
  type: "business",
  first_name: "Ana",
  last_name: "García",
  business_name: "Acme SL",
  phone: "+34600111222",
  address: { street_address: "Calle Mayor 1", locality: "Madrid", postal_code: "28013", country_code: "ES" },
};
const buy = {
  profile_username: "brand",
  country: "ES",
  number_type: "local",
  phone_number: "+34911234567",
  purchase_intent_id: "intent-0001",
  end_user: endUser,
  accept_terms: true,
  terms_version: "2026-11-27",
};
n = s.calls.length;
r = await s.call("purchase_phone_number", buy);
assert.ok(isPreview(r), "buying waits for confirmation");
assert.match(result(r).action, /Buys phone number \+34911234567 in ES for profile "brand"/);
assert.match(result(r).action, /charged/);
assert.equal(s.calls.length, n, "nothing bought before confirmation");
await s.call("purchase_phone_number", { ...buy, confirmed: true });
assert.equal(last(s).method, "POST");
assert.equal(last(s).url, `${P}/purchase`);
assert.deepEqual(last(s).data, buy, "the API's own field names, nothing added");
r = await s.call("purchase_phone_number", { ...buy, accept_terms: false, confirmed: true });
assert.equal(r.isError, true, "accept_terms must be true");
r = await s.call("purchase_phone_number", { ...buy, purchase_intent_id: "short", confirmed: true });
assert.equal(r.isError, true, "purchase_intent_id is 8-100 characters");
await s.close();

// 202 answers come back as successes with what to do next.
for (const [status, re] of [
  ["kyc_required", /Nothing has been bought or charged[\s\S]*kyc_fields[\s\S]*SAME arguments and purchase_intent_id/],
  ["pending_regulatory", /Paid and waiting/],
  ["pending_payment", /Paid, and the order[\s\S]*Do not buy again[\s\S]*phone_numbers_read `get`[\s\S]*same purchase_intent_id returns this same number/],
]) {
  const k = await connect("claude-ai", { respond: () => ({ status: 202, data: { success: true, status } }) });
  const res = await k.call("purchase_phone_number", { ...buy, confirmed: true });
  assert.equal(res.isError, undefined, `${status} is not an error`);
  assert.equal(result(res).status, status);
  assert.match(result(res).next_step, re, `${status} carries its next_step`);
  await k.close();
}

// The identity step goes to POST /kyc with values and documents (base64 or a local file).
{
  const k = await connect("claude-ai");
  const dir = mkdtempSync(join(tmpdir(), "phone-kyc-"));
  const file = join(dir, "passport.pdf");
  writeFileSync(file, "%PDF-1.4 test");
  const kycArgs = {
    ...buy,
    values: { req_tax: "B12345678" },
    documents: { req_id: { path: file }, req_addr: { filename: "bill.png", content_base64: "aGVsbG8=" } },
  };
  const preview = await k.call("purchase_phone_number", kycArgs);
  assert.ok(isPreview(preview));
  assert.match(result(preview).action, /identity and documents \(req_id, req_addr\)/);
  assert.equal(result(preview).preview.documents.req_addr.content_base64, "<8 base64 characters>", "file bytes are not echoed in the preview");
  await k.call("purchase_phone_number", { ...kycArgs, confirmed: true });
  assert.equal(last(k).url, `${P}/kyc`);
  assert.deepEqual(last(k).data.values, { req_tax: "B12345678" });
  assert.deepEqual(last(k).data.documents, {
    req_id: { filename: "passport.pdf", content_base64: Buffer.from("%PDF-1.4 test").toString("base64") },
    req_addr: { filename: "bill.png", content_base64: "aGVsbG8=" },
  });
  assert.equal(last(k).data.purchase_intent_id, "intent-0001", "same intent as the purchase");
  await k.close();

  // The hosted server cannot read paths.
  const h = await connect("claude-ai", { allowLocalFiles: false });
  const before = h.calls.length;
  const res = await h.call("purchase_phone_number", { ...kycArgs, confirmed: true });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /cannot read file paths/);
  assert.equal(h.calls.length, before, "nothing sent with a server path");
  await h.close();
}

// --- SMS, voice settings, WhatsApp, release -----------------------------------------
{
  const t = await connect("claude-ai");
  let res = await t.call("send_sms", { number_id: "pn_1", to: "+34600111222", text: "Hola" });
  assert.ok(isPreview(res), "an SMS waits for confirmation");
  assert.equal(t.calls.length, 0);
  await t.call("send_sms", { number_id: "pn_1", to: "+34600111222", text: "Hola", confirmed: true });
  assert.equal(last(t).method, "POST");
  assert.equal(last(t).url, `${P}/pn_1/sms`);
  assert.deepEqual(last(t).data, { to: "+34600111222", text: "Hola" });

  res = await t.call("manage_phone_number", { action: "update_voice", number_id: "pn_1", forward_to: "+34 600 111 222", recording_enabled: true });
  assert.notEqual(result(res)?.status, "confirmation_required", "settings run at once");
  assert.equal(last(t).method, "PATCH");
  assert.equal(last(t).url, `${P}/pn_1/voice`);
  assert.deepEqual(last(t).data, { forward_to: "tel:+34600111222", recording_enabled: true });
  await t.call("manage_phone_number", { action: "update_voice", number_id: "pn_1", forward_to: null });
  assert.deepEqual(last(t).data, { forward_to: null }, "null stops forwarding");
  await t.call("manage_phone_number", { action: "prepare_whatsapp", number_id: "pn_1", language: "es", recording_enabled: true });
  assert.equal(last(t).method, "POST");
  assert.equal(last(t).url, `${P}/pn_1/whatsapp/prepare`);
  assert.deepEqual(last(t).data, { language: "es" }, "only the action's own fields");

  const sent = t.calls.length;
  res = await t.call("release_phone_number", { number_id: "pn_1", confirm: true });
  assert.ok(isPreview(res), "a release waits for confirmation");
  assert.match(result(res).action, /cannot be undone/);
  assert.equal(t.calls.length, sent);
  await t.call("release_phone_number", { number_id: "pn_1", confirm: true, confirmed: true });
  assert.equal(last(t).method, "DELETE");
  assert.equal(last(t).url, `${P}/pn_1`);
  assert.deepEqual(last(t).params, { confirm: true }, "the API's confirm=true goes along");
  await t.call("release_phone_number", { number_id: "pn_2", confirmed: true });
  assert.deepEqual(last(t).params, {}, "without confirm the API refuses it (400 confirmation_required)");
  await t.close();
}

console.log(`check-phone-numbers: ok (${TOOLS.length} tools, none in ChatGPT)`);
