#!/usr/bin/env node
/**
 * Regression check for WhatsApp DMs (the profile's own WhatsApp Business number):
 *   - ChatGPT keeps send_dm with Instagram and Bluesky only and gets no
 *     WhatsApp tools (its reviewed surface); every other client gets platform
 *     'whatsapp', its fields, and the template / business tools;
 *   - descriptions say WhatsApp is available to every account (no rollout or
 *     allowlist wording), while Messenger is not available yet;
 *   - every WhatsApp field reaches POST /uploadposts/dms/send under the API's
 *     names, nothing dropped; what the API would refuse never reaches it;
 *   - templates, business profile and QR codes hit their routes, with user /
 *     platform in the query on GET and DELETE and in the body on POST;
 *   - sends, template sends, reactions, deletions and profile changes preview
 *     first; read receipts and typing do not.
 * The HTTP layer is replaced by an in-memory fake. Run after `npm run build`.
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { UploadPostMcpClient } from "../dist/client.js";
import { NETWORKS } from "../dist/tools/networks.js";

async function connect(name) {
  const calls = [];
  const upClient = new UploadPostMcpClient({ apiKey: "test", baseUrl: "https://example.invalid/api" });
  upClient.http.request = async (cfg) => {
    calls.push(cfg);
    return { status: 200, data: { success: true } };
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

const isPreview = (r) => r.structuredContent?.result?.status === "confirmation_required";
const WA_FIELDS = ["template", "contacts", "list", "cta_url", "header", "footer", "typing", "location"];
const WA_TOOLS = ["manage_whatsapp_templates", "manage_whatsapp_business"];

{
  const s = await connect("openai-mcp");
  const send = s.tools.get("send_dm");
  assert.deepEqual(send.inputSchema.properties.platform.enum, ["instagram", "bluesky"]);
  for (const field of WA_FIELDS) assert.equal(send.inputSchema.properties[field], undefined, `ChatGPT: no ${field}`);
  for (const tool of WA_TOOLS) assert.ok(!s.tools.has(tool), `ChatGPT: no ${tool} before review`);
  const r = await s.call("send_dm", { user: "brand", platform: "whatsapp", recipient_id: "+34600111222", message: "hi" });
  assert.ok(r.isError, "ChatGPT cannot send a WhatsApp DM");
  assert.equal(s.calls.length, 0);
  await s.close();
}

const s = await connect("claude-ai");
const send = s.tools.get("send_dm");
assert.ok(send.inputSchema.properties.platform.enum.includes("whatsapp"));
for (const field of WA_FIELDS) assert.ok(send.inputSchema.properties[field], `send_dm accepts ${field}`);
for (const tool of WA_TOOLS) assert.ok(s.tools.has(tool), `${tool} is offered`);
assert.match(send.description, /available to every account/);
assert.match(send.description, /131047/);
assert.match(send.description, /template/);
const list = s.tools.get("list_dm_conversations");
assert.match(list.description, /WhatsApp \(available to every account\)/);
assert.match(list.inputSchema.properties.platform.description, /Messenger is not available yet/, "Messenger not available until Meta approves");
assert.match(s.tools.get("get_connect_link").description, /\['whatsapp'\]/);
const waText = [send, list, ...WA_TOOLS.map((t) => s.tools.get(t))].map((t) => t.description).join(" ");
assert.doesNotMatch(waText, /WhatsApp[^.]*(limited|allowlist|not generally available|rollout)/i, "no WhatsApp availability warning");
assert.ok(NETWORKS.some((n) => n.id === "whatsapp"), "the connect view has a WhatsApp card");

// Every WhatsApp field reaches /dms/send as given.
const interactive = {
  user: "brand",
  platform: "whatsapp",
  recipient_id: "+34600111222",
  message: "Pick one",
  header: "Menu",
  footer: "Reply anytime",
  buttons: [{ title: "Yes", id: "yes" }, { title: "No", id: "no" }],
  reply_to: "wamid.IN1",
};
let r = await s.call("send_dm", interactive);
assert.ok(isPreview(r), "a WhatsApp DM asks first");
assert.match(JSON.stringify(r.structuredContent), /WhatsApp DM/);
assert.equal(s.calls.length, 0);
r = await s.call("send_dm", { ...interactive, confirmed: true });
assert.ok(!r.isError, JSON.stringify(r.content));
assert.equal(s.calls[0].method, "POST");
assert.equal(s.calls[0].url, "/uploadposts/dms/send");
assert.deepEqual(s.calls[0].data, interactive);

const bodies = [
  { message: "Our menu", list: { button: "See", sections: [{ title: "Food", rows: [{ id: "p", title: "Pizza", description: "Big" }] }] } },
  { message: "Book now", cta_url: { display_text: "Book", url: "https://example.com/book" } },
  { template: { name: "order_update", language: "es_ES", components: [{ type: "body", parameters: [{ type: "text", text: "42" }] }] } },
  { message: "Here", attachments: [{ type: "image", url: "https://example.com/a.jpg", caption: "A" }, { type: "document", media_id: "123", filename: "x.pdf" }] },
  { location: { latitude: 40.4, longitude: -3.7, name: "Shop", address: "Main St 1" } },
  { contacts: [{ name: { formatted_name: "Ana" }, phones: [{ phone: "+34600000000" }] }] },
  { reaction: "👍", message_id: "wamid.IN1" },
  { reaction: { message_id: "wamid.IN1", emoji: "" } },
];
for (const extra of bodies) {
  s.calls.length = 0;
  const dm = { user: "brand", platform: "whatsapp", recipient_id: "+34600111222", ...extra };
  r = await s.call("send_dm", dm);
  assert.ok(isPreview(r), `${Object.keys(extra).join("+")} previews first`);
  r = await s.call("send_dm", { ...dm, confirmed: true });
  assert.ok(!r.isError, JSON.stringify(r.content));
  assert.deepEqual(s.calls[0].data, dm, `${Object.keys(extra).join("+")} is sent as given`);
}
s.calls.length = 0;
r = await s.call("send_dm", { user: "brand", platform: "whatsapp", recipient_id: "+34600111222", template: { name: "promo" } });
assert.match(r.structuredContent.result.action, /template "promo"/);

// Read receipts and typing run straight away.
for (const action of ["mark_read", "typing_on"]) {
  s.calls.length = 0;
  const dm = { user: "brand", platform: "whatsapp", recipient_id: "+34600111222", sender_action: action, message_id: "wamid.IN1" };
  r = await s.call("send_dm", dm);
  assert.ok(!r.isError && !isPreview(r), `${action} needs no preview`);
  assert.deepEqual(s.calls[0].data, dm);
}

// Refused before the API.
s.calls.length = 0;
const refused = [
  [{ message: "hi" }, "recipient_id is required"],
  [{ recipient_id: "+34600111222", conversation_id: "c1", message: "hi" }, "conversation_id is Bluesky only"],
  [{ recipient_id: "+34600111222" }, "something to send"],
  [{ recipient_id: "+34600111222", sender_action: "react", message_id: "w" }, "react is a reaction, not a sender_action"],
  [{ recipient_id: "+34600111222", sender_action: "mark_read" }, "mark_read needs message_id"],
  [{ recipient_id: "+34600111222", reaction: "👍" }, "a reaction needs message_id"],
  [{ recipient_id: "+34600111222", buttons: [{ title: "Yes" }] }, "buttons need a body"],
  [{ recipient_id: "+34600111222", message: "x", buttons: [{ title: "Yes" }], attachments: [{ type: "image", url: "https://e.com/a.jpg" }] }, "no attachments on interactive"],
  [{ recipient_id: "+34600111222", message: "x", parse_mode: "HTML" }, "parse_mode is Telegram only"],
];
for (const [extra, why] of refused) {
  r = await s.call("send_dm", { user: "brand", platform: "whatsapp", confirmed: true, ...extra });
  assert.ok(r.isError, why);
}
r = await s.call("send_dm", { user: "brand", platform: "instagram", recipient_id: "1", message: "hi", template: { name: "t" }, confirmed: true });
assert.ok(r.isError, "template is WhatsApp only");
r = await s.call("send_dm", { user: "brand", platform: "telegram", recipient_id: "42", message: "hi", footer: "f", confirmed: true });
assert.ok(r.isError, "footer is WhatsApp only");
assert.equal(s.calls.length, 0);

// The stored inbox.
r = await s.call("list_dm_conversations", { user: "brand", platform: "whatsapp", participant_id: "+34600111222", messages_limit: 5 });
assert.ok(!r.isError, JSON.stringify(r.content));
assert.equal(s.calls[0].url, "/uploadposts/dms/conversations");
assert.deepEqual(s.calls[0].params, { user: "brand", platform: "whatsapp", participant_id: "+34600111222", messages_limit: 5 });

// Templates.
s.calls.length = 0;
r = await s.call("manage_whatsapp_templates", { action: "list", user: "brand", status: "APPROVED" });
assert.ok(!r.isError, JSON.stringify(r.content));
assert.equal(s.calls[0].method, "GET");
assert.equal(s.calls[0].url, "/uploadposts/dms/templates");
assert.deepEqual(s.calls[0].params, { user: "brand", status: "APPROVED", platform: "whatsapp" });

s.calls.length = 0;
const template = {
  action: "create",
  user: "brand",
  name: "order_ready",
  category: "UTILITY",
  language: "en_US",
  body: "Hi {{1}}, order {{2}} is ready",
  examples: ["Ana", "42"],
  buttons: [{ text: "Track", url: "https://example.com/t" }],
};
r = await s.call("manage_whatsapp_templates", template);
assert.ok(!r.isError && !isPreview(r), "creating a template goes to Meta's review, no preview");
assert.equal(s.calls[0].method, "POST");
const { action: _a, ...templateBody } = template;
assert.deepEqual(s.calls[0].data, { ...templateBody, platform: "whatsapp" });

s.calls.length = 0;
r = await s.call("manage_whatsapp_templates", { action: "delete", user: "brand", name: "order_ready" });
assert.ok(isPreview(r), "deleting a template asks first");
assert.equal(s.calls.length, 0);
r = await s.call("manage_whatsapp_templates", { action: "delete", user: "brand", name: "order_ready", confirmed: true });
assert.ok(!r.isError, JSON.stringify(r.content));
assert.equal(s.calls[0].method, "DELETE");
assert.deepEqual(s.calls[0].params, { user: "brand", name: "order_ready", platform: "whatsapp" });
assert.equal(s.calls[0].data, undefined, "DELETE carries its fields in the query");

// Business profile and QR codes.
s.calls.length = 0;
r = await s.call("manage_whatsapp_business", { action: "get_profile", user: "brand" });
assert.ok(!r.isError, JSON.stringify(r.content));
assert.equal(s.calls[0].url, "/uploadposts/dms/whatsapp/profile");
assert.deepEqual(s.calls[0].params, { user: "brand" });

s.calls.length = 0;
const profile = { action: "update_profile", user: "brand", about: "Open 9-18", websites: ["https://example.com"] };
r = await s.call("manage_whatsapp_business", profile);
assert.ok(isPreview(r), "the public profile change asks first");
r = await s.call("manage_whatsapp_business", { ...profile, confirmed: true });
assert.ok(!r.isError, JSON.stringify(r.content));
assert.equal(s.calls[0].method, "POST");
assert.deepEqual(s.calls[0].data, { user: "brand", about: "Open 9-18", websites: ["https://example.com"] });

s.calls.length = 0;
r = await s.call("manage_whatsapp_business", { action: "create_qr_code", user: "brand", prefilled_message: "Hi!" });
assert.ok(!r.isError && !isPreview(r));
assert.equal(s.calls[0].url, "/uploadposts/dms/whatsapp/qr");
assert.deepEqual(s.calls[0].data, { user: "brand", prefilled_message: "Hi!" });

s.calls.length = 0;
r = await s.call("manage_whatsapp_business", { action: "delete_qr_code", user: "brand", code: "ABC123" });
assert.ok(isPreview(r));
r = await s.call("manage_whatsapp_business", { action: "delete_qr_code", user: "brand", code: "ABC123", confirmed: true });
assert.equal(s.calls[0].method, "DELETE");
assert.deepEqual(s.calls[0].params, { user: "brand", code: "ABC123" });

await s.close();
console.log("check-whatsapp-dms: ok");
