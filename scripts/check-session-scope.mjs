#!/usr/bin/env node
/**
 * Regression check for how the HTTP transport scopes a session:
 *   - a session runs as the credential that opened it: a request carrying a
 *     different credential gets a 404 (re-initialize), the same one passes;
 *   - on the multi-tenant host, media given as a filesystem path is refused
 *     before the SDK opens it (the path would name a file of the server);
 *     http(s) URLs still go through, and stdio keeps local paths.
 * Runs the real server against a fake API on localhost. Run after `npm run build`.
 */
import assert from "node:assert/strict";
import { createServer, request } from "node:http";

const KEYS = new Set(["key-a", "key-b"]);
const apiCalls = [];

const fakeApi = createServer((req, res) => {
  apiCalls.push(req.url);
  req.resume();
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/uploadposts/me") {
    const ok = KEYS.has(String(req.headers.authorization ?? "").replace(/^Apikey /, ""));
    res.statusCode = ok ? 200 : 401;
    return res.end(JSON.stringify({ success: ok }));
  }
  res.statusCode = 200;
  res.end(JSON.stringify({ success: true, request_id: "r1", profiles: [] }));
});
await new Promise((r) => fakeApi.listen(0, "127.0.0.1", r));
const apiPort = fakeApi.address().port;

const mcpPort = 20000 + Math.floor(Math.random() * 20000);
process.env.UPLOAD_POST_MCP_ACCESS_LOG = "off";
process.env.OAUTH_ISSUER = "";
delete process.env.UPLOAD_POST_MCP_ALLOW_LOCAL_FILES;

const { runHttp } = await import("../dist/transport/http.js");
const { buildServer } = await import("../dist/server.js");
const { assertNoServerPaths } = await import("../dist/tools/upload.js");
await runHttp({ port: mcpPort, baseUrl: `http://127.0.0.1:${apiPort}/api`, buildServer });

function post(headers, body) {
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

/** JSON-RPC message out of a plain JSON or SSE response body. */
function rpc(body) {
  const line = body.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line ? line.slice(6) : body);
}

const auth = (key) => ({ authorization: `ApiKey ${key}` });
const PROTO = "2025-03-26";
const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: PROTO, capabilities: {}, clientInfo: { name: "check", version: "0" } },
});
const ping = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });
const call = (id, name, args) =>
  JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

async function main() {
  let r = await post(auth("key-a"), initialize);
  assert.equal(r.status, 200, r.body);
  const sid = r.headers["mcp-session-id"];
  assert.ok(sid);
  const inSession = (headers) => ({ ...headers, "mcp-session-id": sid, "mcp-protocol-version": PROTO });
  await post(inSession(auth("key-a")), JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));

  // 1. Another credential cannot drive this session.
  r = await post(inSession(auth("key-b")), ping);
  assert.equal(r.status, 404, `foreign credential must not reach the session: ${r.body}`);
  r = await post(inSession({ authorization: "Bearer key-b" }), ping);
  assert.equal(r.status, 404, r.body);

  // 2. The opening credential (either scheme) keeps working.
  r = await post(inSession(auth("key-a")), ping);
  assert.equal(r.status, 200, r.body);
  r = await post(inSession({ authorization: "Bearer key-a" }), ping);
  assert.equal(r.status, 200, r.body);

  // 3. A filesystem path is refused before the SDK reads it; nothing is uploaded.
  const before = apiCalls.length;
  for (const [i, [tool, args]] of [
    ["upload_document", { documentPathOrUrl: "/etc/hosts", title: "t", user: "u", confirmed: true }],
    ["upload_photos", { photosPathsOrUrls: ["/etc/hosts"], user: "u", platforms: ["x"], confirmed: true }],
    ["upload_video", { videoPathOrUrl: "/etc/hosts", user: "u", platforms: ["x"], title: "t", confirmed: true }],
    [
      "upload_photos",
      {
        photosPathsOrUrls: ["https://example.com/a.jpg"],
        user: "u",
        platforms: ["x"],
        confirmed: true,
        platformOptions: { firstCommentMedia: ["/etc/hosts"] },
      },
    ],
  ].entries()) {
    r = await post(inSession(auth("key-a")), call(10 + i, tool, args));
    assert.equal(r.status, 200, r.body);
    const msg = rpc(r.body);
    const text = JSON.stringify(msg);
    assert.ok(msg.result?.isError || msg.error, `${tool} with a path must fail: ${text}`);
    assert.match(text, /public http\(s\) URL/, text);
  }
  const uploads = apiCalls.slice(before).filter((u) => /upload/.test(u ?? ""));
  assert.deepEqual(uploads, [], "no upload may reach the API with a server path");

  // 4. The guard itself: URLs pass, stdio (allowLocalFiles) keeps paths.
  const hosted = { allowLocalFiles: false };
  assertNoServerPaths(hosted, { videoPathOrUrl: "https://example.com/v.mp4" }, {
    instagramCoverUrl: "HTTPS://example.com/c.jpg",
    youtubeSubtitles: [{ language: "en", url: "https://example.com/s.srt" }],
  });
  assert.throws(() => assertNoServerPaths(hosted, {}, { youtubeSubtitles: [{ language: "en", file: "/etc/hosts" }] }));
  assert.throws(() => assertNoServerPaths(hosted, {}, { instagramCoverUrl: "file:///etc/hosts" }));
  assert.throws(() => assertNoServerPaths(hosted, { photosPathsOrUrls: ["https://ok", "../x"] }));
  assertNoServerPaths({ allowLocalFiles: true }, { videoPathOrUrl: "/home/me/clip.mp4" });
}

main().then(
  () => {
    console.log("check-session-scope: ok");
    process.exit(0);
  },
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
