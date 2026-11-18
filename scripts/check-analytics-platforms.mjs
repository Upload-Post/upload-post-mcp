#!/usr/bin/env node
/**
 * Regression check for get_analytics: GET /api/analytics/<profile> answers 400
 * without `platforms`, so the tool asks for it (required in the schema outside
 * the reviewed ChatGPT surface) instead of sending a request that cannot work.
 * The SDK's HTTP call is replaced by an in-memory fake. Run after `npm run build`.
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { UploadPostMcpClient } from "../dist/client.js";

const sent = [];
const upClient = new UploadPostMcpClient({ apiKey: "test", baseUrl: "https://example.invalid/api" });
upClient.sdk._request = async (endpoint, method, params) => {
  sent.push({ endpoint, params });
  return { success: true };
};

const server = buildServer(upClient);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: "claude-ai", version: "0.0.0-test" });
await client.connect(clientTransport);

const { tools } = await client.listTools();
const schema = tools.find((t) => t.name === "get_analytics").inputSchema;
assert.ok(schema.required.includes("platforms"), "platforms is required");

const missing = await client.callTool({ name: "get_analytics", arguments: { profileUsername: "demo" } });
assert.ok(missing.isError, "a call without platforms is refused");
const empty = await client.callTool({ name: "get_analytics", arguments: { profileUsername: "demo", platforms: [] } });
assert.ok(empty.isError, "a call with no platforms is refused");
assert.equal(sent.length, 0, "nothing reaches the API");

const okRes = await client.callTool({
  name: "get_analytics",
  arguments: { profileUsername: "demo", platforms: ["instagram", "tiktok"] },
});
assert.ok(!okRes.isError, okRes.content?.[0]?.text);
assert.equal(sent.length, 1);
assert.equal(sent[0].endpoint, "/analytics/demo");
assert.equal(sent[0].params.platforms, "instagram,tiktok");

console.log("check-analytics-platforms: ok");
process.exit(0);
