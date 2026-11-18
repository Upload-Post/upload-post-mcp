#!/usr/bin/env node
/**
 * Regression check for what the server tells the model about polling an async
 * upload: the statuses named are the ones GET /api/uploadposts/status returns
 * (there is no `success` status), with an interval and a limit, both in the
 * server instructions and in get_status (outside the reviewed ChatGPT surface,
 * which keeps its snapshot). Run after `npm run build`.
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { UploadPostMcpClient } from "../dist/client.js";

const upClient = new UploadPostMcpClient({ apiKey: "test", baseUrl: "https://example.invalid/api" });
const server = buildServer(upClient);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: "claude-ai", version: "0.0.0-test" });
await client.connect(clientTransport);

const terminal = ["completed", "failed", "retryable"];
const instructions = client.getInstructions();
assert.doesNotMatch(instructions, /until success/i, "instructions: no `success` status");
for (const status of terminal) assert.match(instructions, new RegExp(`\\b${status}\\b`), `instructions name ${status}`);
assert.match(instructions, /\d+\s*(s|seconds)\b/, "instructions give a polling interval");

const { tools } = await client.listTools();
const description = tools.find((t) => t.name === "get_status").description;
assert.doesNotMatch(description, /'success'|`success`/, "get_status: no `success` status");
for (const status of [...terminal, "in_progress", "pending_approval", "not_found"]) {
  assert.match(description, new RegExp(`\\b${status}\\b`), `get_status names ${status}`);
}
assert.match(description, /\d+\s*(s|seconds)\b/, "get_status gives a polling interval");
assert.match(description, /\d+\s*min/, "get_status gives a polling limit");

console.log("check-status-guidance: ok");
process.exit(0);
