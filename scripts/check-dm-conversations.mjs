#!/usr/bin/env node
/**
 * Regression check for list_dm_conversations (Neo #6972):
 *   - ChatGPT and every other client see cursor, since, participant_id and
 *     messages_limit, so a caller can follow `pagination.next_cursor`;
 *   - they reach GET /uploadposts/dms/conversations under the API's names,
 *     and unset ones are not sent;
 *   - the API's answer (attachments with url/type, pagination) comes back as is.
 * The HTTP layer is replaced by an in-memory fake. Run after `npm run build`.
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { UploadPostMcpClient } from "../dist/client.js";

const apiAnswer = {
  success: true,
  conversations: [
    {
      id: "c1",
      updated_time: "2026-11-08T10:00:00+0000",
      participants: { data: [{ id: "111", username: "creator" }, { id: "222", username: "talkiid", is_me: true }] },
      messages: {
        data: [
          {
            id: "m1",
            message: "",
            attachments: [{ type: "image", url: "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1", width: 1080, height: 1920 }],
          },
        ],
      },
    },
  ],
  pagination: { next_cursor: "QVFIUk5", has_more: true },
};

const calls = [];
const upClient = new UploadPostMcpClient({ apiKey: "test", baseUrl: "https://example.invalid/api" });
upClient.http.request = async (cfg) => {
  calls.push(cfg);
  return { status: 200, data: apiAnswer };
};

async function connect(name, apiClient) {
  const server = buildServer(apiClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name, version: "0.0.0-test" });
  await client.connect(clientTransport);
  return { client, server };
}

const NEW_FIELDS = ["cursor", "since", "participant_id", "messages_limit"];

for (const name of ["openai-mcp", "claude-ai"]) {
  const { client, server } = await connect(name, upClient);
  const tool = (await client.listTools()).tools.find((t) => t.name === "list_dm_conversations");
  assert.ok(tool, `${name}: list_dm_conversations is listed`);
  const props = tool.inputSchema.properties;
  for (const field of ["user", "platform", "limit", ...NEW_FIELDS]) {
    assert.ok(props[field], `${name}: list_dm_conversations accepts ${field}`);
    assert.ok(props[field].description, `${name}: ${field} has a description`);
  }
  assert.deepEqual(tool.inputSchema.required, ["user"], `${name}: only user is required, as before`);
  assert.equal(props.messages_limit.maximum, 25, "messages_limit is capped like the API (25)");
  assert.match(tool.description, /next_cursor/, "the description explains how to page");
  assert.match(tool.description, /attachments/, "the description says where media comes back");
  await client.close();
  await server.close();
}

const { client, server } = await connect("openai-mcp", upClient);

// Second page of one thread, recent activity only.
calls.length = 0;
const page = await client.callTool({
  name: "list_dm_conversations",
  arguments: {
    user: "talkiid",
    platform: "instagram",
    limit: 20,
    cursor: "QVFIUk5",
    since: "2026-11-01T00:00:00Z",
    participant_id: "111",
    messages_limit: 25,
  },
});
assert.ok(!page.isError, `call failed: ${JSON.stringify(page.content)}`);
assert.equal(calls.length, 1);
assert.equal(calls[0].method, "GET");
assert.equal(calls[0].url, "/uploadposts/dms/conversations");
assert.deepEqual(calls[0].params, {
  user: "talkiid",
  platform: "instagram",
  limit: 20,
  cursor: "QVFIUk5",
  since: "2026-11-01T00:00:00Z",
  participant_id: "111",
  messages_limit: 25,
});
// The API's answer reaches the model untouched: attachments and pagination included.
assert.deepEqual(page.structuredContent.result, apiAnswer);

// A Unix timestamp is a valid `since` too.
calls.length = 0;
const byTimestamp = await client.callTool({
  name: "list_dm_conversations",
  arguments: { user: "talkiid", platform: "instagram", since: 1762000000 },
});
assert.ok(!byTimestamp.isError, `call failed: ${JSON.stringify(byTimestamp.content)}`);
assert.equal(calls[0].params.since, 1762000000);

// Old-style call (WhatsApp, no new fields): nothing extra is sent.
calls.length = 0;
const plain = await client.callTool({
  name: "list_dm_conversations",
  arguments: { user: "talkiid", platform: "whatsapp", limit: 5 },
});
assert.ok(!plain.isError);
assert.deepEqual(calls[0].params, { user: "talkiid", platform: "whatsapp", limit: 5 });

// The API's own limit is enforced by the schema: 26 messages is refused before any call.
calls.length = 0;
const tooMany = await client.callTool({
  name: "list_dm_conversations",
  arguments: { user: "talkiid", platform: "instagram", messages_limit: 26 },
});
assert.ok(tooMany.isError, "messages_limit above 25 is rejected");
assert.equal(calls.length, 0);

await client.close();
await server.close();
console.log("check-dm-conversations: ok");
