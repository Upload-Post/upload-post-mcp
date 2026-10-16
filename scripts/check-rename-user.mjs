#!/usr/bin/env node
/**
 * Regression check for profile renaming.
 *
 * The profile username is the `user` value of every publish call and never
 * changes. rename_user only sets `display_name`, and create_user forwards an
 * optional display_name. Run after `npm run build`.
 *
 * HTTP is replaced by an in-memory fake, so nothing leaves the process.
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { UploadPostMcpClient } from "../dist/client.js";

const requests = [];
const sdkCalls = [];
const upClient = new UploadPostMcpClient({ apiKey: "test", baseUrl: "https://example.invalid" });
upClient.request = async (method, path, options = {}) => {
  requests.push({ method, path, body: options.body });
  return { success: true, profile: { username: "client-acme", display_name: options.body?.display_name || null } };
};
upClient.sdk.createUser = async (username) => {
  sdkCalls.push(["createUser", username]);
  return { success: true, profile: { username } };
};

const server = buildServer(upClient);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: "check-rename", version: "0.0.0-test" });
await client.connect(clientTransport);
const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  assert.notEqual(res.isError, true, res.content.map((c) => c.text).join("\n"));
  return res;
};

const tools = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
assert.ok(tools.has("rename_user"), "rename_user must be exposed");
assert.equal(tools.get("rename_user").annotations.destructiveHint, false);
assert.match(tools.get("rename_user").description, /`username` does not change/i);
assert.match(tools.get("list_users").description, /display_name/);
assert.match(tools.get("list_users").description, /never the display_name/);

// rename_user: PATCH on the profile path, only display_name in the body.
await call("rename_user", { username: "me@brand", display_name: "Acme Corp" });
assert.deepEqual(requests.at(-1), {
  method: "PATCH",
  path: "/uploadposts/users/me%40brand",
  body: { display_name: "Acme Corp" },
});

// Empty string clears it.
await call("rename_user", { username: "client-acme", display_name: "" });
assert.deepEqual(requests.at(-1).body, { display_name: "" });

// Over 100 characters is rejected before reaching the API.
const before = requests.length;
const tooLong = await client.callTool({ name: "rename_user", arguments: { username: "x", display_name: "a".repeat(101) } });
assert.equal(tooLong.isError, true);
assert.equal(requests.length, before);

// create_user with display_name sends both fields; without it, the SDK path is unchanged.
await call("create_user", { username: "client-acme", display_name: "Acme Corp" });
assert.deepEqual(requests.at(-1), {
  method: "POST",
  path: "/uploadposts/users",
  body: { username: "client-acme", display_name: "Acme Corp" },
});
await call("create_user", { username: "plain" });
assert.deepEqual(sdkCalls, [["createUser", "plain"]]);

await client.close();
await server.close();
console.log("rename user OK");
