#!/usr/bin/env node
/**
 * Regression check for the account-wide Instagram AutoDM rule tools:
 *   - create_autodm_rule says it sends DMs automatically, is behind the
 *     confirmation step and posts the API's field names to /autodms/rules;
 *   - its schema mirrors the API (four triggers, whole-hour cooldown 0-720);
 *   - list / pause / resume / delete reach their routes with `rule_id`;
 *   - the per-post AutoDM tools point to the rules for "every post";
 *   - ChatGPT does not see the rule tools yet (not in its reviewed surface).
 * The HTTP layer is replaced by an in-memory fake. Run after `npm run build`.
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { UploadPostMcpClient } from "../dist/client.js";

const TOOLS = ["create_autodm_rule", "list_autodm_rules", "pause_autodm_rule", "resume_autodm_rule", "delete_autodm_rule"];

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

{
  const s = await connect("openai-mcp");
  for (const name of TOOLS) assert.ok(!s.tools.has(name), `ChatGPT must not see ${name} yet`);
  assert.ok(s.tools.has("start_autodm"), "ChatGPT keeps the per-post AutoDM tools");
  await s.close();
}

const s = await connect("claude-ai");
for (const name of TOOLS) assert.ok(s.tools.has(name), `claude-ai sees ${name}`);

const create = s.tools.get("create_autodm_rule");
assert.match(create.description, /AUTOMATICALLY sends private Instagram DMs/);
assert.match(create.description, /never expires/);
assert.ok(create.inputSchema.properties.confirmed, "create_autodm_rule is behind the confirmation step");
assert.equal(create.annotations.readOnlyHint, false);
assert.equal(create.annotations.openWorldHint, true);
assert.deepEqual(create.inputSchema.properties.triggers.items.enum, ["comment", "story_reply", "story_mention", "dm_keyword"]);
assert.equal(create.inputSchema.properties.per_user_cooldown_hours.type, "integer");
assert.equal(create.inputSchema.properties.per_user_cooldown_hours.maximum, 720);
assert.deepEqual(create.inputSchema.required.sort(), ["profile_username", "reply_message"]);
assert.equal(s.tools.get("list_autodm_rules").annotations.readOnlyHint, true);
assert.equal(s.tools.get("delete_autodm_rule").annotations.destructiveHint, true);
assert.match(s.tools.get("resume_autodm_rule").description, /AUTOMATICALLY sends Instagram DMs/);
assert.match(s.tools.get("start_autodm").description, /create_autodm_rule/);
assert.match(s.tools.get("list_autodms").description, /list_autodm_rules/);

const rule = {
  profile_username: "brand",
  reply_message: "Here is the guide: https://example.com/guide",
  triggers: ["comment", "dm_keyword"],
  trigger_keywords: ["guide"],
  per_user_cooldown_hours: 48,
};

// Preview first: nothing is created.
s.calls.length = 0;
let r = await s.call("create_autodm_rule", rule);
assert.ok(!r.isError, JSON.stringify(r.content));
assert.equal(r.structuredContent.result.status, "confirmation_required");
assert.match(r.structuredContent.result.action, /account-wide Instagram rule/);
assert.equal(s.calls.length, 0);

r = await s.call("create_autodm_rule", { ...rule, confirmed: true });
assert.ok(!r.isError, JSON.stringify(r.content));
assert.equal(s.calls.length, 1);
assert.equal(s.calls[0].method, "POST");
assert.equal(s.calls[0].url, "/uploadposts/autodms/rules");
assert.deepEqual(s.calls[0].data, rule, "the body carries the API's names and no `confirmed`");

// The API takes whole hours only: 1.5 is refused before any call.
s.calls.length = 0;
r = await s.call("create_autodm_rule", { ...rule, per_user_cooldown_hours: 1.5, confirmed: true });
assert.ok(r.isError);
r = await s.call("create_autodm_rule", { ...rule, triggers: ["likes"], confirmed: true });
assert.ok(r.isError, "unknown trigger is rejected");
assert.equal(s.calls.length, 0);

// List, with and without the profile filter.
s.calls.length = 0;
await s.call("list_autodm_rules", {});
await s.call("list_autodm_rules", { profile_username: "brand" });
assert.equal(s.calls[0].method, "GET");
assert.equal(s.calls[0].url, "/uploadposts/autodms/rules");
assert.deepEqual(s.calls[0].params, {});
assert.deepEqual(s.calls[1].params, { profile_username: "brand" });

// pause / resume / delete run straight away (no new DM goes out on its own).
s.calls.length = 0;
for (const action of ["pause", "resume", "delete"]) {
  r = await s.call(`${action}_autodm_rule`, { rule_id: "rule_1" });
  assert.ok(!r.isError, `${action}: ${JSON.stringify(r.content)}`);
}
assert.deepEqual(
  s.calls.map((c) => [c.method, c.url, c.data]),
  [
    ["POST", "/uploadposts/autodms/rules/pause", { rule_id: "rule_1" }],
    ["POST", "/uploadposts/autodms/rules/resume", { rule_id: "rule_1" }],
    ["POST", "/uploadposts/autodms/rules/delete", { rule_id: "rule_1" }],
  ]
);

await s.close();
console.log("check-autodm-rules: ok");
