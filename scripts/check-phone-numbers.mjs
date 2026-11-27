#!/usr/bin/env node
/**
 * Regression check for the Upload-Post phone number tools:
 *   - ChatGPT sees none of them (its surface is the reviewed one);
 *   - each tool hits the documented route with the API's field names;
 *   - buying, sending an SMS and releasing wait for the confirmation step, and
 *     the release still carries the API's own confirm=true;
 *   - a 202 kyc_required / pending_regulatory purchase comes back with a next_step;
 *   - round 2: the identity review can be read (kyc_review) and fixed or answered
 *     (fix_phone_number_kyc, gated, never charges again), shareable KYC links are
 *     listed (kyc_links) and created / revoked (manage_phone_kyc_links, gated);
 *     a declined review keeps the payment for 30 days instead of being refunded
 *     at once, and no text (tools, next_steps, README) still says otherwise;
 *   - the descriptions say what an agent must know before calling (paid plans,
 *     no emergency calls, US/CA cannot send SMS, the WhatsApp phone-call flow,
 *     release is final) and never name the carrier or an internal switch.
 * The HTTP layer is replaced by an in-memory fake. Run after `npm run build`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { UploadPostMcpClient } from "../dist/client.js";

const TOOLS = [
  "phone_numbers_read",
  "purchase_phone_number",
  "send_sms",
  "manage_phone_number",
  "release_phone_number",
  "fix_phone_number_kyc",
  "manage_phone_kyc_links",
];
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
  assert.doesNotMatch(JSON.stringify([...s.tools.values()]), /phone_number|sms_received|phone_kyc|kyc_review|kyc_links/, "nothing about phone numbers reaches ChatGPT");
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
assert.deepEqual(
  { r: ann("fix_phone_number_kyc").readOnlyHint, d: ann("fix_phone_number_kyc").destructiveHint, i: ann("fix_phone_number_kyc").idempotentHint },
  { r: false, d: false, i: false },
  "fixing a review changes data, removes nothing, and each reply is another message"
);
assert.deepEqual(
  { r: ann("manage_phone_kyc_links").readOnlyHint, d: ann("manage_phone_kyc_links").destructiveHint, i: ann("manage_phone_kyc_links").idempotentHint },
  { r: false, d: true, i: false },
  "KYC links: each create is another link, revoke cannot be undone"
);
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

// --- round 2: declined keeps the payment; remediation and KYC links ---------------
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const OLD_DECLINED = [/declined review is refunded/i, /if declined the charge is refunded/i, /declined[^.]*\brefunded\b/i];
for (const re of OLD_DECLINED) {
  assert.doesNotMatch(all, re, `no tool says a declined review is refunded at once (${re})`);
  assert.doesNotMatch(readme, re, `README does not say a declined review is refunded at once (${re})`);
}
for (const name of ["phone_numbers_read", "purchase_phone_number", "fix_phone_number_kyc"]) {
  assert.match(desc(name), /keeps the payment and pauses the monthly charge/, `${name}: declined keeps the payment`);
  assert.match(desc(name), /within 30 days, or the number is released, the purchase is cancelled and refunded/, `${name}: 30 days or release = refund`);
  assert.match(desc(name), /fix_phone_number_kyc `resubmit`, which never charges again/, `${name}: the fix never charges again`);
}
assert.match(readme, /keeps the payment[\s\S]{0,200}monthly charge is paused/, "README: declined keeps the payment");
assert.match(readme, /30 days/, "README: the 30-day window");
for (const name of ["phone_numbers_read", "purchase_phone_number", "fix_phone_number_kyc"]) {
  assert.match(desc(name), /remediation_deadline_at \(declined_at \+ 30 days[^)]*\) is the last day to fix it: tell the user that date/, `${name}: show the user the deadline`);
}
assert.match(desc("phone_numbers_read"), /only while regulatory_declined declined_at and remediation_deadline_at \(declined_at \+ 30 days/, "the number fields include the deadline");
assert.match(readme, /`declined_at` and `remediation_deadline_at`/, "README: the deadline fields");
assert.match(desc("phone_numbers_read"), /kyc_review \(number_id; owner only\)[\s\S]*needs_fix/);
assert.match(desc("phone_numbers_read"), /kyc_links \(owner only\)[\s\S]*active \| used \| expired \| revoked/);
assert.match(desc("release_phone_number"), /declined \(regulatory_declined\) cancels the purchase and refunds it/);
assert.match(desc("fix_phone_number_kyc"), /409 phone_number_unavailable with keeps_payment: true/);
assert.match(desc("fix_phone_number_kyc"), /hosted server refuses paths/);
assert.match(desc("fix_phone_number_kyc"), /Needs the user's approval/, "fixing a review is gated");
assert.match(desc("manage_phone_kyc_links"), /BOUGHT AND BILLED TO THIS ACCOUNT/);
assert.match(desc("manage_phone_kyc_links"), /Single use, valid 7 days/);
assert.match(desc("manage_phone_kyc_links"), /At most 20 active links \(409 phone_kyc_links_limit\)/);
assert.match(desc("manage_phone_kyc_links"), /409 phone_kyc_link_used\): release the number/);
assert.match(desc("manage_phone_kyc_links"), /Needs the user's approval/, "creating and revoking links is gated");
assert.doesNotMatch(all, /\/api\/phone-kyc|phone-kyc\/\{token\}/, "the public page endpoints are not offered as calls");
for (const name of ["phone_numbers_read", "create_webhook_subscription", "manage_webhook_settings"]) {
  assert.match(s.tools.get(name).description, /phone_number_kyc_comment[\s\S]*phone_number_kyc_resubmitted/, `${name} lists the new webhook events`);
}
assert.match(readme, /phone_number_kyc_comment[\s\S]*phone_number_kyc_resubmitted/, "README lists the new webhook events");
assert.doesNotMatch(readme, /tel[n]yx/i, "README never names the carrier");
// UPDATE 2: consumer consent, terms 2026-11-28, remediation errors, the KYC link guide.
const CONSENT = "I ask Upload-Post to start providing this number now, within the 14-day withdrawal period.";
assert.ok(desc("purchase_phone_number").includes(CONSENT), "purchase quotes the consent text to show the user");
assert.match(desc("purchase_phone_number"), /immediate_start_consent: true[\s\S]*ignored for a business[\s\S]*400 immediate_start_consent_required/);
assert.match(s.tools.get("purchase_phone_number").inputSchema.properties.terms_version.description, /2026-11-28/);
assert.ok(s.tools.get("purchase_phone_number").inputSchema.properties.immediate_start_consent, "purchase takes immediate_start_consent");
assert.match(desc("fix_phone_number_kyc"), /409 phone_number_remediation_in_progress/);
assert.match(desc("fix_phone_number_kyc"), /503 phone_numbers_capacity[^.]*; the payment is kept, try again later and do not buy again/);
assert.match(desc("fix_phone_number_kyc"), /order_unknown \(our carrier did not confirm the new order in time; it is resolved automatically and no second order/);
assert.match(desc("manage_phone_kyc_links"), /immediate-start consent[\s\S]*on the page/);
assert.ok(readme.includes("https://docs.upload-post.com/guides/phone-number-kyc-link"), "README links the KYC link guide");
assert.match(readme, /immediate_start_consent: true/, "README: consumer consent");

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
await s.call("phone_numbers_read", { action: "kyc_review", number_id: "pn_1" });
assert.equal(last(s).method, "GET");
assert.equal(last(s).url, `${P}/pn_1/remediate`);
await s.call("phone_numbers_read", { action: "kyc_links", number_id: "pn_1" });
assert.equal(last(s).method, "GET");
assert.equal(last(s).url, `${P}/kyc/share`);
assert.deepEqual(last(s).params ?? {}, {}, "kyc_links takes no fields");
r = await s.call("phone_numbers_read", { action: "kyc_review" });
assert.equal(r.isError, true, "kyc_review needs number_id");

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
  terms_version: "2026-11-28",
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
  ["pending_regulatory", /Paid and waiting[\s\S]*payment is kept and the monthly charge paused[\s\S]*fix_phone_number_kyc `resubmit` \(no second charge\)[\s\S]*remediation_deadline_at, and tell the user that date[\s\S]*30 days[\s\S]*cancelled and refunded/],
  ["pending_payment", /Paid, and the order[\s\S]*Do not buy again[\s\S]*phone_numbers_read `get`[\s\S]*same purchase_intent_id returns this same number/],
]) {
  const k = await connect("claude-ai", { respond: () => ({ status: 202, data: { success: true, status } }) });
  const res = await k.call("purchase_phone_number", { ...buy, confirmed: true });
  assert.equal(res.isError, undefined, `${status} is not an error`);
  assert.equal(result(res).status, status);
  assert.match(result(res).next_step, re, `${status} carries its next_step`);
  await k.close();
}

// A consumer purchase without immediate_start_consent is refused before anything is sent, preview included.
{
  const k = await connect("claude-ai");
  const consumer = { ...buy, end_user: { ...endUser, type: "individual", business_name: undefined } };
  for (const extra of [{}, { confirmed: true }, { confirmed: true, immediate_start_consent: false }, { confirmed: true, values: { req_tax: "X" } }]) {
    const res = await k.call("purchase_phone_number", { ...consumer, ...extra });
    assert.equal(res.isError, true, `consumer without consent is refused (${JSON.stringify(extra)})`);
    assert.match(res.content[0].text, /immediate_start_consent_required: nothing was sent[\s\S]*Show the user this text exactly and ask[\s\S]*14-day withdrawal period[\s\S]*immediate_start_consent: true/);
  }
  assert.equal(k.calls.length, 0, "nothing sent without the consumer's consent");
  const preview = await k.call("purchase_phone_number", { ...consumer, immediate_start_consent: true });
  assert.ok(isPreview(preview), "with consent the purchase previews as usual");
  assert.match(result(preview).action, /a consumer, asks for the service to start now, within the 14-day withdrawal period/);
  await k.call("purchase_phone_number", { ...consumer, immediate_start_consent: true, confirmed: true });
  assert.equal(last(k).url, `${P}/purchase`);
  assert.equal(last(k).data.immediate_start_consent, true, "the consent goes to the API");
  assert.equal(last(k).data.terms_version, "2026-11-28");
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

// --- fixing a declined review: resubmit and reply ---------------------------------
{
  const t = await connect("claude-ai");
  const dir = mkdtempSync(join(tmpdir(), "phone-fix-"));
  const file = join(dir, "id-card.png");
  writeFileSync(file, "png bytes");
  const fix = {
    action: "resubmit",
    number_id: "pn_1",
    values: { req_tax: "B87654321" },
    documents: { req_id: { path: file }, req_addr: { filename: "bill.pdf", content_base64: "aGVsbG8=" } },
    end_user: endUser,
    phone_number: "+34911000000",
  };
  let res = await t.call("fix_phone_number_kyc", fix);
  assert.ok(isPreview(res), "resubmitting waits for confirmation");
  assert.match(result(res).action, /phone number pn_1[\s\S]*values \(req_tax\), documents \(req_id, req_addr\), the end user with a new address, replacement number \+34911000000\. No new charge\./);
  assert.equal(result(res).preview.documents.req_addr.content_base64, "<8 base64 characters>", "file bytes are not echoed");
  assert.equal(t.calls.length, 0, "nothing sent before confirmation");
  await t.call("fix_phone_number_kyc", { ...fix, confirmed: true });
  assert.equal(last(t).method, "POST");
  assert.equal(last(t).url, `${P}/pn_1/remediate`);
  assert.deepEqual(
    last(t).data,
    {
      values: { req_tax: "B87654321" },
      documents: {
        req_id: { filename: "id-card.png", content_base64: Buffer.from("png bytes").toString("base64") },
        req_addr: { filename: "bill.pdf", content_base64: "aGVsbG8=" },
      },
      end_user: endUser,
      phone_number: "+34911000000",
    },
    "only the corrections, in the API's names"
  );
  const n0 = t.calls.length;
  res = await t.call("fix_phone_number_kyc", { action: "resubmit", number_id: "pn_1", confirmed: true });
  assert.equal(res.isError, true, "resubmit needs a correction");
  assert.equal(t.calls.length, n0, "nothing sent without a correction");

  res = await t.call("fix_phone_number_kyc", { action: "reply", number_id: "pn_1", text: "Attached the new bill", attachments: [{ path: file }] });
  assert.ok(isPreview(res), "a reply to the reviewer waits for confirmation");
  assert.match(result(res).action, /identity reviewer about phone number pn_1 with 1 attachment: Attached the new bill/);
  await t.call("fix_phone_number_kyc", { action: "reply", number_id: "pn_1", text: "Attached the new bill", attachments: [{ path: file }], values: { x: "y" }, confirmed: true });
  assert.equal(last(t).method, "POST");
  assert.equal(last(t).url, `${P}/pn_1/remediate/reply`);
  assert.deepEqual(last(t).data, { text: "Attached the new bill", attachments: [{ filename: "id-card.png", content_base64: Buffer.from("png bytes").toString("base64") }] });
  const n1 = t.calls.length;
  res = await t.call("fix_phone_number_kyc", { action: "reply", number_id: "pn_1", confirmed: true });
  assert.equal(res.isError, true, "reply needs text");
  assert.equal(t.calls.length, n1);
  await t.close();

  // The number is gone: the error says what to send, and that the payment is kept.
  const g = await connect("claude-ai", {
    respond: () => ({ status: 409, data: { success: false, error_code: "phone_number_unavailable", keeps_payment: true } }),
  });
  res = await g.call("fix_phone_number_kyc", { action: "resubmit", number_id: "pn_1", values: { req_tax: "B1" }, confirmed: true });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /keeps_payment[\s\S]*next_step: The payment is kept[\s\S]*search_available[\s\S]*phone_number set to it\. Do not buy a new number\./);
  await g.close();

  // Capacity: the payment is kept, try later, never buy again.
  const c = await connect("claude-ai", {
    respond: () => ({ status: 503, data: { success: false, error_code: "phone_numbers_capacity" } }),
  });
  res = await c.call("fix_phone_number_kyc", { action: "resubmit", number_id: "pn_1", values: { req_tax: "B1" }, confirmed: true });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /phone_numbers_capacity[\s\S]*next_step: The payment is kept[\s\S]*try fix_phone_number_kyc `resubmit` again later[\s\S]*Do not buy a new number\./);
  await c.close();

  // The hosted server refuses file paths, for documents and attachments alike.
  const h = await connect("claude-ai", { allowLocalFiles: false });
  res = await h.call("fix_phone_number_kyc", { ...fix, confirmed: true });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /documents\.req_id: this hosted server cannot read file paths/);
  res = await h.call("fix_phone_number_kyc", { action: "reply", number_id: "pn_1", text: "hi", attachments: [{ path: file }], confirmed: true });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /attachments\[0\]: this hosted server cannot read file paths/);
  assert.equal(h.calls.length, 0, "nothing sent with a server path");
  await h.close();
}

// --- shareable KYC links: create and revoke ------------------------------------------
{
  const t = await connect("claude-ai");
  const link = {
    action: "create",
    profile_username: "brand",
    country: "ES",
    number_type: "mobile",
    phone_number: "+34600000001",
    branding: { company_name: "Acme", logo_url: "https://acme.example/logo.png", brand_color: "#4F46E5" },
    redirect_url: "https://acme.example/done",
    language: "es",
  };
  let res = await t.call("manage_phone_kyc_links", link);
  assert.ok(isPreview(res), "creating a link waits for confirmation");
  assert.match(result(res).action, /single-use KYC link \(valid 7 days\) for profile "brand"[\s\S]*phone number \+34600000001 in ES[\s\S]*BILLED TO THIS ACCOUNT/);
  assert.equal(t.calls.length, 0);
  await t.call("manage_phone_kyc_links", { ...link, link_id: "kl_ignored", confirmed: true });
  assert.equal(last(t).method, "POST");
  assert.equal(last(t).url, `${P}/kyc/share`);
  const { action: _action, ...linkBody } = link;
  assert.deepEqual(last(t).data, linkBody, "the API's own field names, nothing added");
  const n0 = t.calls.length;
  res = await t.call("manage_phone_kyc_links", { ...link, redirect_url: undefined, confirmed: true });
  assert.equal(res.isError, true, "create needs redirect_url");
  assert.match(res.content[0].text, /`redirect_url`/);
  res = await t.call("manage_phone_kyc_links", { ...link, branding: { brand_color: "blue" }, confirmed: true });
  assert.equal(res.isError, true, "brand_color is #RRGGBB");
  res = await t.call("manage_phone_kyc_links", { ...link, language: "fr", confirmed: true });
  assert.equal(res.isError, true, "the page speaks en, es or pt-BR");
  assert.equal(t.calls.length, n0, "nothing sent for an invalid link");

  res = await t.call("manage_phone_kyc_links", { action: "revoke", link_id: "kl_1" });
  assert.ok(isPreview(res), "revoking waits for confirmation");
  assert.match(result(res).action, /Revokes KYC link kl_1[\s\S]*cannot be undone/);
  await t.call("manage_phone_kyc_links", { action: "revoke", link_id: "kl_1", profile_username: "brand", confirmed: true });
  assert.equal(last(t).method, "DELETE");
  assert.equal(last(t).url, `${P}/kyc/share/kl_1`);
  assert.equal(last(t).data, undefined, "revoke sends no body");
  const n1 = t.calls.length;
  res = await t.call("manage_phone_kyc_links", { action: "revoke", confirmed: true });
  assert.equal(res.isError, true, "revoke needs link_id");
  assert.equal(t.calls.length, n1);
  await t.close();
}

console.log(`check-phone-numbers: ok (${TOOLS.length} tools, none in ChatGPT)`);
