#!/usr/bin/env node
/**
 * Regression check for sessions that outlive the process that opened them:
 *   - a session id is signed by the server and carries the client's
 *     `initialize`; a second server with the same secret (a restart, a deploy,
 *     another replica) serves it without the client re-initializing, with the
 *     same tool surface the client had (ChatGPT keeps ChatGPT's, the rest
 *     theirs);
 *   - the id only opens again for the key it was issued to, and never without
 *     a credential; a tampered or unknown id still gets the 404;
 *   - ids from before (plain UUIDs) are served too, shaped by the User-Agent;
 *   - a session that left the in-memory cache (cap, idle sweep) keeps working;
 *   - concurrent requests of one session rebuild it once;
 *   - DELETE of a session this process does not hold is a no-op 200.
 * Runs two real servers against a fake API on localhost. Run after `npm run build`.
 */
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { randomUUID } from "node:crypto";

// key-slow answers late, so requests that wait for its check resume together.
const KEYS = new Set(["key-a", "key-b", "key-slow"]);
const fakeApi = createServer((req, res) => {
  req.resume();
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/uploadposts/me") {
    const key = String(req.headers.authorization ?? "").replace(/^Apikey /, "");
    const ok = KEYS.has(key);
    res.statusCode = ok ? 200 : 401;
    return setTimeout(() => res.end(JSON.stringify({ success: ok })), key === "key-slow" ? 300 : 0);
  }
  res.statusCode = 200;
  res.end(JSON.stringify({ success: true, request_id: "r1", profiles: [] }));
});
await new Promise((r) => fakeApi.listen(0, "127.0.0.1", r));
const apiPort = fakeApi.address().port;

process.env.UPLOAD_POST_MCP_ACCESS_LOG = "off";
process.env.UPLOAD_POST_MCP_REQUIRE_SESSION_AUTH = "true";
process.env.UPLOAD_POST_MCP_SESSION_SECRET = "check-session-rehydrate";
process.env.UPLOAD_POST_MCP_MAX_SESSIONS = "6";
process.env.UPLOAD_POST_MCP_AUTH_FAIL_MAX = "0";
process.env.OAUTH_ISSUER = "";

const quiet = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) =>
  String(chunk).startsWith("[upload-post-mcp]") ? true : quiet(chunk, ...rest);

const { runHttp } = await import("../dist/transport/http.js");
const { buildServer } = await import("../dist/server.js");
const base = 20000 + Math.floor(Math.random() * 20000);
const A = base;
const B = base + 1;
for (const port of [A, B]) {
  await runHttp({ port, baseUrl: `http://127.0.0.1:${apiPort}/api`, buildServer });
}

function call(port, { method = "POST", headers = {}, body } = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "content-length": Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          const line = data.split("\n").find((l) => l.startsWith("data: "));
          let json;
          try {
            json = JSON.parse(line ? line.slice(6) : data);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode, headers: res.headers, json, raw: data });
        });
      }
    );
    req.on("error", reject);
    req.end(payload);
  });
}

const auth = (key) => ({ authorization: `Apikey ${key}` });
const health = async (port) =>
  new Promise((resolve) => {
    request({ host: "127.0.0.1", port, path: "/health" }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(JSON.parse(data)));
    }).end();
  });

async function open(port, key, name, userAgent) {
  const res = await call(port, {
    headers: { ...auth(key), ...(userAgent ? { "user-agent": userAgent } : {}) },
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: { roots: { listChanged: true } },
        clientInfo: { name, version: "1.0.0" },
      },
    },
  });
  assert.equal(res.status, 200, `initialize: ${res.raw}`);
  const sid = res.headers["mcp-session-id"];
  assert.ok(sid, "initialize returns a session id");
  await call(port, {
    headers: { ...auth(key), "mcp-session-id": sid },
    body: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  return sid;
}

let nextId = 100;
async function tools(port, key, sid, extra = {}) {
  // One id per request: concurrent requests of a session must not share it.
  const res = await call(port, {
    headers: { ...(key ? auth(key) : {}), "mcp-session-id": sid, ...extra },
    body: { jsonrpc: "2.0", id: nextId++, method: "tools/list" },
  });
  return { status: res.status, names: res.json?.result?.tools?.map((t) => t.name).sort() };
}

// A failed assertion must end the run: the two servers keep the process alive.
process.on("uncaughtException", (err) => {
  console.error(err);
  process.exit(1);
});
try {
// 1. Signed ids, and the same surface on another process.
const chatgpt = await open(A, "key-a", "openai-mcp", "openai-mcp/1.0.0");
const claude = await open(A, "key-a", "claude-ai", "Claude-User");
assert.match(chatgpt, /^s1\./, "session ids are signed tokens");
assert.notEqual(chatgpt, await open(A, "key-a", "openai-mcp", "openai-mcp/1.0.0"), "ids are unique");
const chatgptOnA = await tools(A, "key-a", chatgpt, { "user-agent": "openai-mcp/1.0.0" });
const claudeOnA = await tools(A, "key-a", claude, { "user-agent": "Claude-User" });
assert.equal(chatgptOnA.status, 200);
assert.notDeepEqual(chatgptOnA.names, claudeOnA.names, "ChatGPT and the rest see different tools");

const chatgptOnB = await tools(B, "key-a", chatgpt, { "user-agent": "openai-mcp/1.0.0" });
assert.equal(chatgptOnB.status, 200, "a session opened on A is served by B");
assert.deepEqual(chatgptOnB.names, chatgptOnA.names, "ChatGPT keeps its surface after a rebuild");
const claudeOnB = await tools(B, "key-a", claude, { "user-agent": "Claude-User" });
assert.deepEqual(claudeOnB.names, claudeOnA.names, "other clients keep theirs");
// The surface comes from the id, not from the User-Agent of the request.
const claudeNoAgent = await tools(B, "key-a", await open(A, "key-a", "claude-ai"), {});
assert.deepEqual(claudeNoAgent.names, claudeOnA.names);

// A tool call works on the rebuilt session.
const listUsers = await call(B, {
  headers: { ...auth("key-a"), "mcp-session-id": chatgpt },
  body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_users", arguments: {} } },
});
assert.equal(listUsers.status, 200);
assert.ok(listUsers.json?.result, `tools/call on a rebuilt session: ${listUsers.raw.slice(0, 200)}`);

// 2. Not a credential.
const other = await open(A, "key-a", "claude-ai");
assert.equal((await tools(B, "key-b", other)).status, 404, "another key cannot open the session");
assert.equal((await tools(B, undefined, other)).status, 404, "no credential, no rebuild");
assert.equal((await tools(B, "key-a", other)).status, 200, "the right key still can");
const tampered = other.slice(0, -3) + (other.endsWith("AAA") ? "BBB" : "AAA");
assert.equal((await tools(B, "key-a", tampered)).status, 404, "a tampered id is unknown");
assert.equal((await tools(B, "key-a", "not-a-session")).status, 404, "an unknown id is unknown");
const [prefix, payload, signature] = other.split(".");
const forged = Buffer.from(
  JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url")), c: { name: "openai-mcp" } })
).toString("base64url");
assert.equal((await tools(B, "key-a", `${prefix}.${forged}.${signature}`)).status, 404, "the payload is signed");

// 3. Ids from before (plain UUIDs) keep working, shaped by the User-Agent.
const legacyChatgpt = await tools(B, "key-a", randomUUID(), { "user-agent": "openai-mcp/1.0.0 (ChatGPT)" });
assert.equal(legacyChatgpt.status, 200, "a legacy id is served");
assert.deepEqual(legacyChatgpt.names, chatgptOnA.names, "a legacy ChatGPT session keeps ChatGPT's surface");
const legacyClaude = await tools(B, "key-a", randomUUID(), { "user-agent": "Claude-User" });
assert.deepEqual(legacyClaude.names, claudeOnA.names, "a legacy session of another client keeps its surface");

// 4. Leaving the cache (cap of 6 here) ends nothing.
const first = await open(A, "key-a", "claude-ai");
for (let i = 0; i < 12; i++) await open(A, "key-b", "claude-ai");
assert.ok((await health(A)).sessions <= 6, "the cache stays within its cap");
assert.equal((await tools(A, "key-a", first)).status, 200, "an evicted session is rebuilt on its next request");

// 5. Concurrent requests of one session rebuild it once.
// B has not checked key-slow yet: the eight requests wait for that one check
// and reach the rebuild in the same turn.
const burst = await open(A, "key-slow", "claude-ai");
const before = await health(B);
const answers = await Promise.all(Array.from({ length: 8 }, () => tools(B, "key-slow", burst)));
assert.ok(answers.every((a) => a.status === 200), "every concurrent request is served");
const after = await health(B);
assert.equal(after.rebuilt - before.rebuilt, 1, "one rebuild for eight concurrent requests");

// 6. DELETE of a session this process does not hold.
const gone = await open(A, "key-a", "claude-ai");
assert.equal((await call(B, { method: "DELETE", headers: { ...auth("key-a"), "mcp-session-id": gone } })).status, 200);
assert.equal((await call(B, { method: "DELETE", headers: { "mcp-session-id": "not-a-session" } })).status, 404);

console.log("check-session-rehydrate: ok");
process.exit(0);
} catch (err) {
  console.error(err);
  process.exit(1);
}
