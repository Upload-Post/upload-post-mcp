#!/usr/bin/env node
/**
 * Regression check for send_feedback:
 *   - the tool posts to /uploadposts/feedback with the API's field names;
 *   - the server instructions mention it;
 *   - an API error carrying the HTTP `feedback` block reaches the model with
 *     the MCP wording (call send_feedback), not the HTTP URL it cannot call.
 * The HTTP layer is replaced by an in-memory fake. Run after `npm run build`.
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { UploadPostMcpClient, MCP_FEEDBACK_HINT } from "../dist/client.js";

const calls = [];
const upClient = new UploadPostMcpClient({ apiKey: "test", baseUrl: "https://example.invalid/api" });
upClient.http.request = async (cfg) => {
  calls.push(cfg);
  if (cfg.url === "/uploadposts/feedback") {
    return { status: 201, data: { success: true, id: "f1", duplicate: false } };
  }
  return {
    status: 400,
    data: {
      success: false,
      message: "job_id is required",
      feedback: { message: "AI agents: ... POST https://api.upload-post.com/api/uploadposts/feedback ...", url: "https://api.upload-post.com/api/uploadposts/feedback" },
    },
  };
};

const server = buildServer(upClient);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: "claude-ai", version: "0.0.0-test" });
await client.connect(clientTransport);

assert.match(client.getInstructions() ?? "", /send_feedback/, "instructions mention send_feedback");
const { tools } = await client.listTools();
const tool = tools.find((t) => t.name === "send_feedback");
assert.ok(tool, "send_feedback is listed for Claude");
assert.equal(tool.annotations.destructiveHint, false);
assert.match(tool.description, /never include credentials/i);

const res = await client.callTool({
  name: "send_feedback",
  arguments: { message: "retry_post said job_id is required but I passed requestId", category: "error_message", tool: "retry_post", requestId: "abc", agent: "Claude" },
});
assert.notEqual(res.isError, true, res.content?.[0]?.text);
const sent = calls.find((c) => c.url === "/uploadposts/feedback");
assert.equal(sent.method, "POST");
assert.deepEqual(sent.data, {
  message: "retry_post said job_id is required but I passed requestId",
  category: "error_message",
  endpoint: "mcp:retry_post",
  request_id: "abc",
  agent: "Claude",
});

const short = await client.callTool({ name: "send_feedback", arguments: { message: "bad" } });
assert.equal(short.isError, true, "messages under 10 characters are rejected before any call");
assert.equal(calls.filter((c) => c.url === "/uploadposts/feedback").length, 1);

const failed = await client.callTool({ name: "retry_post", arguments: { requestId: "r1" } });
const text = failed.content.map((c) => c.text).join("\n");
assert.equal(failed.isError, true);
assert.ok(text.includes(JSON.stringify(MCP_FEEDBACK_HINT)), "API feedback block rewritten for MCP");
assert.ok(!text.includes("api.upload-post.com/api/uploadposts/feedback"), "no HTTP feedback URL through MCP");
assert.ok(text.includes("job_id is required"), "original error kept");

await client.close();
await server.close();
console.log("check-feedback: ok");
