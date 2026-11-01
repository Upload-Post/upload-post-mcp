#!/usr/bin/env node
/**
 * Regression check for the auth-failure limiter on /mcp:
 *   - a source that keeps getting 401s is answered 429 + Retry-After past
 *     UPLOAD_POST_MCP_AUTH_FAIL_MAX, and held requests never reach the API;
 *   - while held, one probe per interval still goes through the normal path;
 *   - a session or API key already verified is never held, even from a held
 *     source (shared IPs: NAT, VPN egress, hosted agents);
 *   - other sources are unaffected;
 *   - X-Forwarded-For is only believed from a private peer.
 * Runs the real server against a fake API on localhost. Run after `npm run build`.
 */
import assert from "node:assert/strict";
import { createServer, request } from "node:http";

const GOOD_KEY = "good-key";
const FRESH_KEY = "fresh-key"; // valid, but nobody has used it yet
let meCalls = 0;

const fakeApi = createServer((req, res) => {
  req.resume();
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/uploadposts/me") {
    meCalls++;
    const ok = [GOOD_KEY, FRESH_KEY].some((k) => req.headers.authorization === `Apikey ${k}`);
    res.statusCode = ok ? 200 : 401;
    return res.end(JSON.stringify({ success: ok }));
  }
  res.statusCode = 404;
  res.end();
});
await new Promise((r) => fakeApi.listen(0, "127.0.0.1", r));
const apiPort = fakeApi.address().port;

const mcpPort = 20000 + Math.floor(Math.random() * 20000);
process.env.UPLOAD_POST_MCP_AUTH_FAIL_MAX = "3";
process.env.UPLOAD_POST_MCP_AUTH_FAIL_WINDOW_S = "60";
process.env.UPLOAD_POST_MCP_AUTH_FAIL_PROBE_S = "1";
process.env.UPLOAD_POST_MCP_ACCESS_LOG = "off";
process.env.OAUTH_ISSUER = "";
delete process.env.UPLOAD_POST_MCP_TRUST_PROXY;

const { runHttp } = await import("../dist/transport/http.js");
const { buildServer } = await import("../dist/server.js");
const { clientAddress } = await import("../dist/transport/auth_failure_limiter.js");
await runHttp({ port: mcpPort, baseUrl: `http://127.0.0.1:${apiPort}/api`, buildServer });

const PROTO = "2025-03-26";
function post(from, headers, body) {
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
          "content-length": Buffer.byteLength(body),
          // The test talks over loopback, a private peer, so this is believed.
          "x-forwarded-for": from,
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
    req.end(body);
  });
}

const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: PROTO, capabilities: {}, clientInfo: { name: "check", version: "0" } },
});
const ping = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });
const auth = (key) => ({ authorization: `ApiKey ${key}` });
const HELD = "203.0.113.7";
const OTHER = "198.51.100.9";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 0. Who is the client: XFF only from a private peer, last hop wins.
  const fake = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: { "x-forwarded-for": xff } });
  assert.equal(clientAddress(fake("172.18.0.5", "1.1.1.1, 203.0.113.7"), "auto"), "203.0.113.7");
  assert.equal(clientAddress(fake("::ffff:10.0.1.2", "203.0.113.7"), "auto"), "203.0.113.7");
  assert.equal(clientAddress(fake("192.0.2.50", "203.0.113.7"), "auto"), "192.0.2.50");
  assert.equal(clientAddress(fake("172.18.0.5", "203.0.113.7"), "false"), "172.18.0.5");

  // A session opened before the source starts failing.
  let r = await post(HELD, auth(GOOD_KEY), initialize);
  assert.equal(r.status, 200, r.body);
  const sid = r.headers["mcp-session-id"];
  assert.ok(sid);

  // 1. A client stuck without credentials: 401 up to the limit, then 429.
  for (let i = 0; i < 3; i++) {
    r = await post(HELD, {}, initialize);
    assert.equal(r.status, 401, `attempt ${i + 1}: ${r.body}`);
  }
  r = await post(HELD, {}, initialize);
  assert.equal(r.status, 429, r.body);
  assert.equal(JSON.parse(r.body).error, "too_many_failed_auth");
  assert.ok(Number(r.headers["retry-after"]) >= 1, "429 must carry Retry-After");

  // 2. Held: new keys are not even looked up.
  const before = meCalls;
  r = await post(HELD, auth("guess-1"), initialize);
  assert.equal(r.status, 429, r.body);
  r = await post(HELD, auth("guess-2"), initialize);
  assert.equal(r.status, 429, r.body);
  assert.equal(meCalls, before, "held source must not reach the key check");

  // 3. Already-verified credentials are never held: the open session and a new
  //    session with the cached good key both go through.
  r = await post(HELD, { ...auth(GOOD_KEY), "mcp-session-id": sid, "mcp-protocol-version": PROTO }, ping);
  assert.equal(r.status, 200, r.body);
  r = await post(HELD, auth(GOOD_KEY), initialize);
  assert.equal(r.status, 200, r.body);

  // 4. Another source is unaffected.
  r = await post(OTHER, {}, initialize);
  assert.equal(r.status, 401, r.body);

  // 5. One probe per interval goes through the normal path (a 401 here), the
  //    next request is held again.
  await sleep(1100);
  r = await post(HELD, {}, initialize);
  assert.equal(r.status, 401, r.body);
  r = await post(HELD, {}, initialize);
  assert.equal(r.status, 429, r.body);

  // 6. A valid key nobody has verified yet waits for the next probe, then gets in.
  r = await post(HELD, auth(FRESH_KEY), initialize);
  assert.equal(r.status, 429, r.body);
  await sleep(1100);
  r = await post(HELD, auth(FRESH_KEY), initialize);
  assert.equal(r.status, 200, r.body);
}

main().then(
  () => {
    console.log("check-auth-failures: ok");
    process.exit(0);
  },
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
