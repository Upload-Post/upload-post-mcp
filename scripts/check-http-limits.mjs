#!/usr/bin/env node
/**
 * Regression check for the HTTP transport's input limits:
 *   - a pasted API key is checked once against GET /uploadposts/me (cached,
 *     including rejections) before a session is built for it;
 *   - /mcp request bodies over UPLOAD_POST_MCP_MAX_BODY_MB get a 413;
 *   - one credential cannot hold more than UPLOAD_POST_MCP_MAX_SESSIONS_PER_KEY
 *     sessions (its own oldest is recycled).
 * Runs the real server against a fake API on localhost. Run after `npm run build`.
 */
import assert from "node:assert/strict";
import { createServer, request } from "node:http";

const GOOD_KEY = "good-key";
let meCalls = 0;
let upstreamDown = false;

const fakeApi = createServer((req, res) => {
  if (req.url === "/api/uploadposts/me") {
    meCalls++;
    if (upstreamDown) {
      res.statusCode = 502;
      return res.end("bad gateway");
    }
    const ok = req.headers.authorization === `Apikey ${GOOD_KEY}`;
    res.statusCode = ok ? 200 : 401;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ success: ok }));
  }
  res.statusCode = 404;
  res.end();
});
await new Promise((r) => fakeApi.listen(0, "127.0.0.1", r));
const apiPort = fakeApi.address().port;

const mcpPort = 20000 + Math.floor(Math.random() * 20000);
process.env.UPLOAD_POST_MCP_MAX_BODY_MB = String(16 / 1024); // 16 KB
process.env.UPLOAD_POST_MCP_MAX_SESSIONS_PER_KEY = "2";
process.env.UPLOAD_POST_MCP_ACCESS_LOG = "off";
process.env.OAUTH_ISSUER = "";

const { runHttp } = await import("../dist/transport/http.js");
const { buildServer } = await import("../dist/server.js");
await runHttp({ port: mcpPort, baseUrl: `http://127.0.0.1:${apiPort}/api`, buildServer });

function post(headers, body, { chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: mcpPort,
        path: "/mcp",
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(chunked ? { "transfer-encoding": "chunked" } : { "content-length": Buffer.byteLength(body) }),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on("error", reject);
    if (chunked) {
      // Several writes, no length announced up front.
      for (let i = 0; i < body.length; i += 4096) req.write(body.slice(i, i + 4096));
      req.end();
    } else {
      req.end(body);
    }
  });
}

const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "check", version: "0" } },
});
const auth = (key) => ({ authorization: `ApiKey ${key}` });

// The server installs process-wide rejection handlers that only log, so a
// failed assertion has to end the process explicitly.
async function main() {
  // 1. A key the API rejects never gets a session, and the rejection is cached.
  let r = await post(auth("junk-key"), initialize);
  assert.equal(r.status, 401, r.body);
  assert.equal(JSON.parse(r.body).error, "invalid_api_key");
  r = await post({ authorization: "Bearer junk-key" }, initialize);
  assert.equal(r.status, 401, r.body);
  assert.equal(meCalls, 1, "rejected key must be cached");

  // 2. A good key opens a session; the next session reuses the cached verdict.
  r = await post(auth(GOOD_KEY), initialize);
  assert.equal(r.status, 200, r.body);
  const first = r.headers["mcp-session-id"];
  assert.ok(first);
  r = await post(auth(GOOD_KEY), initialize);
  assert.equal(r.status, 200, r.body);
  assert.equal(meCalls, 2, "accepted key must be cached");

  // 3. Per-key cap (2): a third session recycles this key's oldest one.
  r = await post(auth(GOOD_KEY), initialize);
  assert.equal(r.status, 200, r.body);
  const ping = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });
  r = await post({ ...auth(GOOD_KEY), "mcp-session-id": first, "mcp-protocol-version": "2025-03-26" }, ping);
  assert.equal(r.status, 404, "oldest session of the key should have been recycled");

  // 4. Oversized bodies: 413 with a JSON-RPC error, with or without Content-Length.
  const big = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "initialize", params: { pad: "x".repeat(32 * 1024) } });
  r = await post(auth(GOOD_KEY), big);
  assert.equal(r.status, 413, r.body);
  assert.match(JSON.parse(r.body).error.message, /larger than/);
  r = await post(auth(GOOD_KEY), big, { chunked: true });
  assert.equal(r.status, 413, r.body);

  // 5. The API being down is a 503 (retry), never a 401 (bad key).
  upstreamDown = true;
  r = await post(auth("another-key"), initialize);
  assert.equal(r.status, 503, r.body);
}

main().then(
  () => {
    console.log("check-http-limits: ok");
    process.exit(0);
  },
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
