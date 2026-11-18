#!/usr/bin/env node
/**
 * Regression check for the OAuth surface:
 *   - the protected resource metadata (RFC 9728) is served at every shape
 *     clients build its URL with, including /mcp/.well-known/... (suffix);
 *   - /token takes the client_id from Authorization: Basic when the form
 *     has none (public client: the secret is not used).
 * Runs the real server against a fake backend on localhost. Run after `npm run build`.
 */
import assert from "node:assert/strict";
import { createServer, request } from "node:http";

const tokenCalls = [];
const fakeApi = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/uploadposts/oauth/token") {
      const form = Object.fromEntries(new URLSearchParams(raw));
      tokenCalls.push(form);
      if (!form.client_id) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: "invalid_request" }));
      }
      return res.end(JSON.stringify({ access_token: "up_oauth_x", token_type: "Bearer" }));
    }
    res.statusCode = 404;
    res.end();
  });
});
await new Promise((r) => fakeApi.listen(0, "127.0.0.1", r));
const apiPort = fakeApi.address().port;

const mcpPort = 20000 + Math.floor(Math.random() * 20000);
process.env.UPLOAD_POST_MCP_ACCESS_LOG = "off";
process.env.OAUTH_ISSUER = `http://127.0.0.1:${mcpPort}`;
process.env.OAUTH_DASHBOARD_AUTHORIZE_URL = "http://127.0.0.1:1/oauth/authorize";
process.env.OAUTH_UPSTREAM_BASE_URL = `http://127.0.0.1:${apiPort}`;
process.env.OAUTH_INTERNAL_SECRET = "secret";

const { runHttp } = await import("../dist/transport/http.js");
const { buildServer } = await import("../dist/server.js");
await runHttp({ port: mcpPort, baseUrl: `http://127.0.0.1:${apiPort}/api`, buildServer });

function call(method, path, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: mcpPort,
        path,
        method,
        headers: { ...(body !== undefined ? { "content-length": Buffer.byteLength(body) } : {}), ...headers },
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

async function main() {
  // RFC 9728 metadata: plain, path-inserted and path-suffixed shapes.
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/mcp/.well-known/oauth-protected-resource",
  ]) {
    const r = await call("GET", path);
    assert.equal(r.status, 200, path);
    assert.equal(JSON.parse(r.body).resource, `${process.env.OAUTH_ISSUER}/mcp`, path);
  }

  // /token with client credentials in Authorization: Basic (RFC 6749 §2.3.1:
  // each part form-urlencoded, then base64). A public client: secret ignored.
  const form = "grant_type=refresh_token&refresh_token=rt";
  const basic = (id, secret) =>
    "Basic " + Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64");
  const formHeaders = { "content-type": "application/x-www-form-urlencoded" };
  let r = await call("POST", "/token", { ...formHeaders, authorization: basic("cl:id/1", "s3cr:et") }, form);
  assert.equal(r.status, 200, r.body);
  assert.equal(tokenCalls.at(-1).client_id, "cl:id/1");
  assert.equal(tokenCalls.at(-1).client_secret, undefined, "the secret is not forwarded");
  // A client_id in the body wins over the header.
  r = await call("POST", "/token", { ...formHeaders, authorization: basic("other", "") }, `${form}&client_id=body-id`);
  assert.equal(r.status, 200, r.body);
  assert.equal(tokenCalls.at(-1).client_id, "body-id");
  // Without either, the backend's 400 is relayed as before.
  r = await call("POST", "/token", formHeaders, form);
  assert.equal(r.status, 400, r.body);
  // A Basic header that is not valid is ignored.
  r = await call("POST", "/token", { ...formHeaders, authorization: "Basic !!!" }, form);
  assert.equal(r.status, 400, r.body);
}

main().then(
  () => {
    console.log("check-oauth-edges: ok");
    process.exit(0);
  },
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
