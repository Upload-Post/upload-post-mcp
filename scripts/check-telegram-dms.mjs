#!/usr/bin/env node
/**
 * Regression check for Telegram DMs (the profile's own bot, private chats):
 *   - ChatGPT keeps send_dm with Instagram and Bluesky only (its reviewed
 *     surface); every other client gets platform 'telegram' and its fields;
 *   - send_dm and list_dm_conversations reach /uploadposts/dms/* under the
 *     API's names; a Telegram DM without recipient_id never reaches the API,
 *     and Telegram-only fields are refused on the other networks;
 *   - a Telegram delete previews as gone for both sides.
 * The HTTP layer is replaced by an in-memory fake. Run after `npm run build`.
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { UploadPostMcpClient } from "../dist/client.js";

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
const TELEGRAM_FIELDS = ["business_connection_id", "parse_mode", "location", "contact", "checklist", "message_ids"];

{
  const s = await connect("openai-mcp");
  const send = s.tools.get("send_dm");
  assert.deepEqual(send.inputSchema.properties.platform.enum, ["instagram", "bluesky"]);
  for (const field of TELEGRAM_FIELDS) assert.equal(send.inputSchema.properties[field], undefined, `ChatGPT: no ${field}`);
  assert.doesNotMatch(send.description, /Telegram/);
  const r = await s.call("send_dm", { user: "brand", platform: "telegram", recipient_id: "42", message: "hi" });
  assert.ok(r.isError, "ChatGPT cannot send a Telegram DM");
  assert.equal(s.calls.length, 0);
  await s.close();
}

const s = await connect("claude-ai");
const send = s.tools.get("send_dm");
assert.deepEqual(send.inputSchema.properties.platform.enum, ["instagram", "bluesky", "telegram"]);
for (const field of TELEGRAM_FIELDS) assert.ok(send.inputSchema.properties[field], `send_dm accepts ${field}`);
assert.match(send.description, /telegram_recipient_not_started/);
assert.match(send.description, /telegram_private_chats_only/);
const list = s.tools.get("list_dm_conversations");
assert.match(list.inputSchema.properties.platform.description, /'telegram'/);
assert.match(list.description, /telegram_updates_not_enabled/);
assert.doesNotMatch(list.description + send.description, /Not generally available/, "Telegram DMs are on: no availability warning");

// A text DM with inline buttons and a reply: confirmed, then sent as is.
const dm = {
  user: "brand",
  platform: "telegram",
  recipient_id: "42",
  message: "*Hi*",
  parse_mode: "MarkdownV2",
  reply_to: 7,
  buttons: [[{ text: "Shop", url: "https://example.com" }], [{ text: "Yes", callback_data: "yes" }]],
};
let r = await s.call("send_dm", dm);
assert.ok(isPreview(r), "a Telegram DM asks first");
assert.match(JSON.stringify(r.structuredContent), /Telegram DM/);
assert.equal(s.calls.length, 0);
r = await s.call("send_dm", { ...dm, confirmed: true });
assert.ok(!r.isError, JSON.stringify(r.content));
assert.equal(s.calls[0].method, "POST");
assert.equal(s.calls[0].url, "/uploadposts/dms/send");
assert.deepEqual(s.calls[0].data, dm);

// An album of files by file_id.
s.calls.length = 0;
const album = {
  user: "brand",
  platform: "telegram",
  recipient_id: "42",
  attachments: [{ type: "photo", media_id: "AgAD1" }, { type: "video", url: "https://example.com/v.mp4", caption: "clip" }],
  confirmed: true,
};
r = await s.call("send_dm", album);
assert.ok(!r.isError, JSON.stringify(r.content));
assert.deepEqual(s.calls[0].data.attachments, album.attachments);

// Delete previews as gone for both sides.
s.calls.length = 0;
r = await s.call("send_dm", { user: "brand", platform: "telegram", recipient_id: "42", sender_action: "delete", message_ids: [5, 6] });
assert.ok(isPreview(r));
assert.match(JSON.stringify(r.structuredContent), /for both sides/);

// Refused before the API: no recipient, Bluesky's conversation_id, Telegram fields elsewhere.
r = await s.call("send_dm", { user: "brand", platform: "telegram", message: "hi", confirmed: true });
assert.ok(r.isError, "recipient_id is required on Telegram");
r = await s.call("send_dm", { user: "brand", platform: "telegram", recipient_id: "42", conversation_id: "c1", message: "hi", confirmed: true });
assert.ok(r.isError, "conversation_id is Bluesky only");
r = await s.call("send_dm", { user: "brand", platform: "telegram", recipient_id: "42", confirmed: true });
assert.ok(r.isError, "a Telegram DM needs something to send");
r = await s.call("send_dm", { user: "brand", platform: "instagram", recipient_id: "1", message: "hi", parse_mode: "HTML", confirmed: true });
assert.ok(r.isError, "parse_mode is Telegram only");
r = await s.call("send_dm", { user: "brand", platform: "bluesky", recipient_id: "a.bsky.social", message: "hi", location: { latitude: 1, longitude: 2 }, confirmed: true });
assert.ok(r.isError, "location is Telegram only");
assert.equal(s.calls.length, 0);

// Conversations of the bot, with the Telegram-only filters.
r = await s.call("list_dm_conversations", { user: "brand", platform: "telegram", participant_id: "42", include_profile_photos: true, business_connection_id: "bc1" });
assert.ok(!r.isError, JSON.stringify(r.content));
assert.equal(s.calls[0].url, "/uploadposts/dms/conversations");
assert.deepEqual(s.calls[0].params, { user: "brand", platform: "telegram", participant_id: "42", include_profile_photos: true, business_connection_id: "bc1" });

await s.close();
console.log("check-telegram-dms: ok");
