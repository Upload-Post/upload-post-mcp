#!/usr/bin/env node
/**
 * Regression check for the webhook delivery tools:
 *   - list_webhook_deliveries sends the API's filter names and caps
 *     (limit 1-100, page 1-50) and drops unset filters;
 *   - get_webhook_delivery / redeliver_webhook hit the per-delivery routes with
 *     the id URL-encoded;
 *   - redeliver_webhook needs `confirmed: true` (it re-sends an event to the
 *     user's server); the reads run straight away;
 *   - ChatGPT does not see these tools yet (not in its reviewed surface).
 * The HTTP layer is replaced by an in-memory fake. Run after `npm run build`.
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { UploadPostMcpClient } from "../dist/client.js";

const TOOLS = ["list_webhook_deliveries", "get_webhook_delivery", "redeliver_webhook"];

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

// --- ChatGPT keeps its reviewed surface ----------------------------------------
{
  const s = await connect("openai-mcp");
  for (const name of TOOLS) assert.ok(!s.tools.has(name), `ChatGPT must not see ${name} yet`);
  await s.close();
}

const s = await connect("claude-ai");
for (const name of TOOLS) assert.ok(s.tools.has(name), `claude-ai sees ${name}`);

const list = s.tools.get("list_webhook_deliveries");
assert.equal(list.annotations.readOnlyHint, true);
assert.equal(list.annotations.destructiveHint, false);
assert.deepEqual(list.inputSchema.properties.status.enum, ["pending", "delivered", "failed", "cancelled"]);
assert.equal(list.inputSchema.properties.limit.maximum, 100);
assert.equal(list.inputSchema.properties.page.maximum, 50, "the API refuses page > 50");
assert.match(list.description, /7 days/);
const redeliver = s.tools.get("redeliver_webhook");
assert.equal(redeliver.annotations.readOnlyHint, false);
assert.ok(redeliver.inputSchema.properties.confirmed, "redeliver_webhook is behind the confirmation step");

// list: API names, unset filters left out
s.calls.length = 0;
let r = await s.call("list_webhook_deliveries", {
  status: "failed",
  event: "upload_completed",
  request_id: "req1",
  include_payload: true,
  limit: 50,
  page: 2,
});
assert.ok(!r.isError, JSON.stringify(r.content));
assert.equal(s.calls.length, 1);
assert.equal(s.calls[0].method, "GET");
assert.equal(s.calls[0].url, "/uploadposts/webhooks/deliveries");
assert.deepEqual(s.calls[0].params, {
  status: "failed",
  event: "upload_completed",
  request_id: "req1",
  include_payload: true,
  limit: 50,
  page: 2,
});

// page above the API's cap never reaches it
s.calls.length = 0;
r = await s.call("list_webhook_deliveries", { page: 51 });
assert.ok(r.isError, "page 51 is rejected");
assert.equal(s.calls.length, 0);

// detail
s.calls.length = 0;
r = await s.call("get_webhook_delivery", { delivery_id: "dlv/1" });
assert.ok(!r.isError);
assert.equal(s.calls[0].method, "GET");
assert.equal(s.calls[0].url, "/uploadposts/webhooks/deliveries/dlv%2F1");

// redeliver: preview first, nothing sent
s.calls.length = 0;
r = await s.call("redeliver_webhook", { delivery_id: "dlv1" });
assert.ok(!r.isError);
assert.equal(r.structuredContent.result.status, "confirmation_required");
assert.equal(s.calls.length, 0, "no redelivery without confirmed");

r = await s.call("redeliver_webhook", { delivery_id: "dlv1", confirmed: true });
assert.ok(!r.isError);
assert.equal(s.calls.length, 1);
assert.equal(s.calls[0].method, "POST");
assert.equal(s.calls[0].url, "/uploadposts/webhooks/deliveries/dlv1/redeliver");

await s.close();
console.log("check-webhooks: ok");
