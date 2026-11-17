#!/usr/bin/env node
/**
 * ChatGPT's tool surface is the one OpenAI reviewed: same tools, names,
 * descriptions, schemas and annotations. This compares the tools/list ChatGPT
 * gets now with the snapshot in scripts/fixtures/chatgpt-tools.json (taken
 * from 0.23.0). New tools and new parameters for existing tools reach every
 * other client only; they join ChatGPT with the next app submission, and the
 * snapshot is refreshed then (`node scripts/check-chatgpt-surface.mjs --update`).
 * Run after `npm run build`, without UPLOAD_POST_* variables set.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { UploadPostMcpClient } from "../dist/client.js";

const FIXTURE = new URL("./fixtures/chatgpt-tools.json", import.meta.url);

async function toolsFor(name) {
  const upClient = new UploadPostMcpClient({ apiKey: "test", baseUrl: "https://example.invalid/api" });
  const server = buildServer(upClient, { name, version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  // As it goes over the wire: undefined keys are not sent.
  return JSON.parse(JSON.stringify(tools));
}

const now = await toolsFor("openai-mcp");
if (process.argv.includes("--update")) {
  writeFileSync(FIXTURE, JSON.stringify(now, null, 1));
  console.log(`check-chatgpt-surface: snapshot updated (${now.length} tools)`);
  process.exit(0);
}

const reviewed = JSON.parse(readFileSync(FIXTURE, "utf8"));
const names = (list) => list.map((t) => t.name);
assert.deepEqual(names(now), names(reviewed), "ChatGPT sees exactly the reviewed tools, in the same order");
for (const tool of reviewed) {
  assert.deepEqual(now.find((t) => t.name === tool.name), tool, `ChatGPT's ${tool.name} is unchanged`);
}
assert.equal(JSON.stringify(now, null, 1), JSON.stringify(reviewed, null, 1), "byte-identical tools/list");

// The other clients do get more: the check would pass by accident if nothing were added.
const other = await toolsFor("claude-ai");
assert.ok(other.length > now.length, "other clients see the tools ChatGPT does not");

console.log(`check-chatgpt-surface: ok (${now.length} tools, identical to the reviewed surface)`);
