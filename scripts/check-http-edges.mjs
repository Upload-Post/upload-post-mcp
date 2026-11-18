#!/usr/bin/env node
/**
 * Regression check for requests on /mcp that cannot be served by a session:
 *   - without Mcp-Session-Id, only `initialize` opens one. Anything else gets
 *     the 400 the SDK transport gives an uninitialized server, without a
 *     server being built for it and without pushing a live session out of
 *     the cache; a 401 still comes first when there is no credential;
 *   - /mcp. and /mcp/ (with or without a query) are the MCP endpoint too;
 *   - a new GET stream of a session replaces the previous one (no 409), and
 *     server messages go to the new one.
 * Runs the real server against a fake API on localhost. Run after `npm run build`.
 */
import assert from "node:assert/strict";
import { createServer, request } from "node:http";

const GOOD_KEY = "good-key";

const fakeApi = createServer((req, res) => {
  req.resume();
  if (req.url === "/api/uploadposts/me") {
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
process.env.UPLOAD_POST_MCP_MAX_SESSIONS_PER_KEY = "2";
process.env.UPLOAD_POST_MCP_ACCESS_LOG = "off";
process.env.OAUTH_ISSUER = "";

const { runHttp } = await import("../dist/transport/http.js");
const { buildServer } = await import("../dist/server.js");
let builds = 0;
let lastServer;
await runHttp({
  port: mcpPort,
  baseUrl: `http://127.0.0.1:${apiPort}/api`,
  buildServer: (...args) => {
    builds++;
    return (lastServer = buildServer(...args));
  },
});

function call(method, path, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: mcpPort,
        path,
        method,
        headers: {
          ...(body !== undefined
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) }
            : {}),
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

function cachedSessions() {
  return call("GET", "/health").then((r) => JSON.parse(r.body).sessions);
}

const ACCEPT = { accept: "application/json, text/event-stream" };
const auth = { authorization: `ApiKey ${GOOD_KEY}` };
const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "check", version: "0" } },
});
const toolsList = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });
const NOT_INITIALIZED = JSON.stringify({
  jsonrpc: "2.0",
  error: { code: -32000, message: "Bad Request: Server not initialized" },
  id: null,
});

async function main() {
  // Fill this key's cache (cap 2).
  for (let i = 0; i < 2; i++) {
    const r = await call("POST", "/mcp", { ...ACCEPT, ...auth }, initialize);
    assert.equal(r.status, 200, r.body);
  }
  assert.equal(await cachedSessions(), 2);
  builds = 0;

  // No credential: still the 401 that starts OAuth / asks for a key.
  let r = await call("POST", "/mcp", ACCEPT, toolsList);
  assert.equal(r.status, 401, r.body);

  // No session id and not `initialize`: the SDK's 400, nothing built or evicted.
  r = await call("POST", "/mcp", { ...ACCEPT, ...auth }, toolsList);
  assert.equal(r.status, 400, r.body);
  assert.equal(r.body, NOT_INITIALIZED);
  assert.match(String(r.headers["content-type"]), /application\/json/);
  r = await call("POST", "/mcp", { ...ACCEPT, ...auth }, JSON.stringify([JSON.parse(toolsList)]));
  assert.equal(r.status, 400, r.body);
  assert.equal(r.body, NOT_INITIALIZED);
  r = await call("GET", "/mcp", { accept: "text/event-stream", ...auth });
  assert.equal(r.status, 400, r.body);
  assert.equal(r.body, NOT_INITIALIZED);
  r = await call("DELETE", "/mcp", auth);
  assert.equal(r.status, 400, r.body);
  assert.equal(r.body, NOT_INITIALIZED);
  assert.equal(await cachedSessions(), 2, "no live session is pushed out for it");
  assert.equal(builds, 0, "no server is built for a request that cannot open a session");

  // What the SDK answers to malformed requests is unchanged.
  r = await call("POST", "/mcp", { accept: "application/json", ...auth }, toolsList);
  assert.equal(r.status, 406, r.body);
  r = await call("GET", "/mcp", { accept: "application/json", ...auth });
  assert.equal(r.status, 406, r.body);
  r = await call("POST", "/mcp", { ...ACCEPT, ...auth }, JSON.stringify({ hello: "world" }));
  assert.equal(r.status, 400, r.body);
  assert.equal(JSON.parse(r.body).error.code, -32700);

  // `initialize` still opens a session (and the per-key cap still applies).
  r = await call("POST", "/mcp", { ...ACCEPT, ...auth }, initialize);
  assert.equal(r.status, 200, r.body);
  assert.ok(r.headers["mcp-session-id"]);
  assert.equal(await cachedSessions(), 2);

  // The endpoint URL pasted with a trailing dot or slash, or with a query.
  for (const path of ["/mcp.", "/mcp/", "/mcp?source=x", "/mcp.?source=x", "/mcp/?source=x"]) {
    r = await call("POST", path, { ...ACCEPT, ...auth }, initialize);
    assert.equal(r.status, 200, `${path}: ${r.body}`);
    const sid = r.headers["mcp-session-id"];
    assert.ok(sid, path);
    r = await call(
      "POST",
      path,
      { ...ACCEPT, ...auth, "mcp-session-id": sid, "mcp-protocol-version": "2025-03-26" },
      toolsList
    );
    assert.equal(r.status, 200, `${path}: ${r.body}`);
  }
  for (const path of ["/mcpx", "/mcp..", "/mcp/x", "/mcp./"]) {
    r = await call("POST", path, { ...ACCEPT, ...auth }, initialize);
    assert.equal(r.status, 404, path);
  }

  // A second GET stream of a session replaces the first one (a client that
  // reconnects after losing it) instead of getting 409.
  r = await call("POST", "/mcp", { ...ACCEPT, ...auth }, initialize);
  const sid = r.headers["mcp-session-id"];
  const sseHeaders = { accept: "text/event-stream", ...auth, "mcp-session-id": sid, "mcp-protocol-version": "2025-03-26" };
  const first = await openStream(sseHeaders);
  assert.equal(first.status, 200);
  const second = await openStream(sseHeaders);
  assert.equal(second.status, 200, "the new stream is accepted");
  await Promise.race([
    first.ended,
    new Promise((_, reject) => setTimeout(() => reject(new Error("the old stream was not closed")), 2000)),
  ]);
  // The new stream is the live one: a server-initiated message reaches it.
  const got = new Promise((resolve, reject) => {
    let seen = "";
    second.res.on("data", (c) => {
      seen += c;
      if (seen.includes("notifications/tools/list_changed")) resolve();
    });
    setTimeout(() => reject(new Error("the new stream got no server message")), 2000);
  });
  lastServer.sendToolListChanged();
  await got;
  r = await call(
    "POST",
    "/mcp",
    { ...ACCEPT, ...auth, "mcp-session-id": sid, "mcp-protocol-version": "2025-03-26" },
    toolsList
  );
  assert.equal(r.status, 200, r.body);
  second.res.destroy();
}

function openStream(headers) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: mcpPort, path: "/mcp", method: "GET", headers }, (res) => {
      const ended = new Promise((done) => res.on("close", done));
      res.on("data", () => {});
      resolve({ status: res.statusCode, res, ended });
    });
    req.on("error", reject);
    req.end();
  });
}

main().then(
  () => {
    console.log("check-http-edges: ok");
    process.exit(0);
  },
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
