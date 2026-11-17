#!/usr/bin/env node
/**
 * Regression check for Bluesky DMs in send_dm and list_dm_conversations:
 *   - send_dm takes platform 'bluesky' with a handle or conversation_id, a
 *     shared post, reply_to and sender actions, and still needs confirmation
 *     before a message or a visible reaction goes out (read receipts do not);
 *   - Instagram calls behave as before, and Bluesky-only fields are refused
 *     there instead of being sent;
 *   - list_dm_conversations forwards the Bluesky-only filters, for ChatGPT too.
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

const BLUESKY_LIST_FIELDS = ["conversation_id", "messages_cursor", "status", "read_state"];

for (const name of ["openai-mcp", "claude-ai"]) {
  const s = await connect(name);
  const send = s.tools.get("send_dm");
  assert.deepEqual(send.inputSchema.properties.platform.enum, ["instagram", "bluesky"], `${name}: send_dm platforms`);
  for (const field of ["conversation_id", "attachments", "reply_to", "sender_action", "message_id", "reaction"]) {
    assert.ok(send.inputSchema.properties[field], `${name}: send_dm accepts ${field}`);
  }
  assert.deepEqual(send.inputSchema.required.sort(), ["platform", "user"], `${name}: message/recipient no longer schema-required`);
  assert.match(send.description, /bluesky_dm_scope_missing/);
  assert.match(send.description, /direct messages/);
  const list = s.tools.get("list_dm_conversations");
  for (const field of BLUESKY_LIST_FIELDS) assert.ok(list.inputSchema.properties[field], `${name}: list accepts ${field}`);
  assert.match(list.inputSchema.properties.platform.description, /bluesky/);
  await s.close();
}

// ChatGPT has no confirmation step (it asks before every write itself): a DM runs on the first call.
{
  const s = await connect("openai-mcp");
  const r = await s.call("send_dm", { user: "brand", platform: "bluesky", recipient_id: "alice.bsky.social", message: "hi" });
  assert.ok(!r.isError, JSON.stringify(r.content));
  assert.equal(s.calls.length, 1);
  await s.close();
}

const s = await connect("claude-ai");

// Bluesky text DM: preview, then sent with the API's names.
let r = await s.call("send_dm", {
  user: "brand",
  platform: "bluesky",
  recipient_id: "alice.bsky.social",
  message: "Hi @alice.bsky.social https://example.com #launch",
  reply_to: "msg0",
});
assert.equal(r.structuredContent.result.status, "confirmation_required");
assert.match(r.structuredContent.result.action, /Bluesky DM/);
assert.equal(s.calls.length, 0);
r = await s.call("send_dm", {
  user: "brand",
  platform: "bluesky",
  recipient_id: "alice.bsky.social",
  message: "Hi @alice.bsky.social https://example.com #launch",
  reply_to: "msg0",
  confirmed: true,
});
assert.ok(!r.isError, JSON.stringify(r.content));
assert.equal(s.calls[0].method, "POST");
assert.equal(s.calls[0].url, "/uploadposts/dms/send");
assert.deepEqual(s.calls[0].data, {
  user: "brand",
  platform: "bluesky",
  recipient_id: "alice.bsky.social",
  message: "Hi @alice.bsky.social https://example.com #launch",
  reply_to: "msg0",
});

// Share a post into a conversation, no text.
s.calls.length = 0;
const share = {
  user: "brand",
  platform: "bluesky",
  conversation_id: "convo1",
  attachments: { type: "post", url: "https://bsky.app/profile/alice.bsky.social/post/3k" },
  confirmed: true,
};
r = await s.call("send_dm", share);
assert.ok(!r.isError, JSON.stringify(r.content));
const { confirmed: _c, ...shareBody } = share;
assert.deepEqual(s.calls[0].data, shareBody);

// A reaction is visible to the other person: preview first.
s.calls.length = 0;
r = await s.call("send_dm", {
  user: "brand", platform: "bluesky", conversation_id: "convo1", sender_action: "react", message_id: "m1", reaction: "🔥",
});
assert.equal(r.structuredContent.result.status, "confirmation_required");
assert.equal(s.calls.length, 0);

// A read receipt or mute runs straight away.
r = await s.call("send_dm", { user: "brand", platform: "bluesky", conversation_id: "convo1", sender_action: "mark_read" });
assert.ok(!r.isError, JSON.stringify(r.content));
assert.equal(s.calls.length, 1);
assert.deepEqual(s.calls[0].data, { user: "brand", platform: "bluesky", conversation_id: "convo1", sender_action: "mark_read" });

// Missing target or content: refused before the API.
s.calls.length = 0;
r = await s.call("send_dm", { user: "brand", platform: "bluesky", message: "hi", confirmed: true });
assert.ok(r.isError);
r = await s.call("send_dm", { user: "brand", platform: "bluesky", recipient_id: "alice.bsky.social", confirmed: true });
assert.ok(r.isError);
r = await s.call("send_dm", {
  user: "brand", platform: "bluesky", recipient_id: "alice.bsky.social", message: "hi",
  buttons: [{ title: "Go", url: "https://example.com" }], confirmed: true,
});
assert.ok(r.isError, "Bluesky has no buttons");
assert.equal(s.calls.length, 0);

// Instagram is unchanged: recipient_id + message (+ buttons) go out as before.
r = await s.call("send_dm", {
  user: "brand", platform: "instagram", recipient_id: "123", message: "hi",
  buttons: [{ title: "Go", url: "https://example.com" }], confirmed: true,
});
assert.ok(!r.isError, JSON.stringify(r.content));
assert.deepEqual(s.calls[0].data, {
  user: "brand", platform: "instagram", recipient_id: "123", message: "hi",
  buttons: [{ title: "Go", url: "https://example.com" }],
});
s.calls.length = 0;
r = await s.call("send_dm", { user: "brand", platform: "instagram", recipient_id: "123", confirmed: true });
assert.ok(r.isError, "Instagram still needs a message");
r = await s.call("send_dm", { user: "brand", platform: "instagram", recipient_id: "123", message: "hi", reply_to: "m1", confirmed: true });
assert.ok(r.isError, "Bluesky-only fields are refused on Instagram");
assert.equal(s.calls.length, 0);

// Conversations: the Bluesky filters reach the API under its names.
r = await s.call("list_dm_conversations", {
  user: "brand", platform: "bluesky", conversation_id: "convo1", messages_cursor: "c2", messages_limit: 25,
});
assert.ok(!r.isError);
assert.deepEqual(s.calls[0].params, {
  user: "brand", platform: "bluesky", conversation_id: "convo1", messages_cursor: "c2", messages_limit: 25,
});
s.calls.length = 0;
r = await s.call("list_dm_conversations", { user: "brand", platform: "bluesky", status: "request", read_state: "unread", limit: 25 });
assert.ok(!r.isError);
assert.deepEqual(s.calls[0].params, { user: "brand", platform: "bluesky", status: "request", read_state: "unread", limit: 25 });
r = await s.call("list_dm_conversations", { user: "brand", platform: "bluesky", status: "pending" });
assert.ok(r.isError, "status is request or accepted");

await s.close();
console.log("check-bluesky-dms: ok");
