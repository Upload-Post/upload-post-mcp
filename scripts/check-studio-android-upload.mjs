#!/usr/bin/env node
/**
 * Upload Studio on ChatGPT for Android (tickets 7427, 7481). Android's photo
 * picker gives the WebView proxy files whose metadata changes between reads, so
 * Chromium aborts the PUT of the File itself ("Failed to fetch"), mostly on a
 * second upload of the same selection. The studio copies the bytes into memory
 * right after the pick and uploads that copy; elsewhere it retries once with a
 * copy when sending the File fails. This runs the page's own staging code
 * (between the <staging-body> markers) against a fake File and fetch.
 * Run after `npm run build`.
 */
import assert from "node:assert/strict";
import vm from "node:vm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { UploadPostMcpClient } from "../dist/client.js";

async function studioScript() {
  const upClient = new UploadPostMcpClient({ apiKey: "test", baseUrl: "https://example.invalid/api" });
  const server = buildServer(upClient, { name: "openai-mcp", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "openai-mcp", version: "1.0.0" });
  await client.connect(clientTransport);
  const res = await client.readResource({ uri: "ui://upload-post/video-upload-studio.html" });
  await client.close();
  await server.close();
  const html = res.contents[0].text;
  return html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
}

const script = await studioScript();
assert.doesNotThrow(() => new Function(script), "Studio script must be valid JavaScript");
assert.ok(!/CORS or widget CSP/.test(script), "the user-facing error no longer blames CORS/CSP");

const start = script.indexOf("function originFromUrl");
const end = script.indexOf("// </staging-body>");
assert.ok(start > 0 && end > start, "staging block markers present");
const block = script.slice(start, end);
// Wiring: the pick starts the copy, and staging uploads through putSelectedFile.
assert.match(script, /snapshot: SNAPSHOT_ON_PICK \? snapshotFile\(file\) : null/);
assert.match(script, /put = await putSelectedFile\(item, created\.upload_url,/);
assert.doesNotMatch(script.slice(script.indexOf("async function stageLocalFile")), /body: file\b/);

// A picked file that reads fine once (the in-memory copy) but that the
// browser can't send as a File body, like Android's proxy picker files.
function proxyFile(bytes, { readable = true } = {}) {
  const data = new Uint8Array(bytes);
  return {
    name: "1000060134.jpg",
    type: "image/jpeg",
    size: data.length,
    reads: 0,
    arrayBuffer() {
      this.reads += 1;
      return readable ? Promise.resolve(data.buffer.slice(0)) : Promise.reject(new Error("NotReadableError"));
    },
  };
}

function load(userAgent, fetchImpl) {
  const ctx = {
    window: { navigator: { userAgent }, location: { origin: "https://x.oaiusercontent.com" } },
    console: { warn() {} },
    URL,
    Blob,
    fetch: fetchImpl,
  };
  vm.createContext(ctx);
  vm.runInContext(
    `${block}; this.api = { snapshotFile, putSelectedFile, explainBrowserUploadFailure, SNAPSHOT_ON_PICK, SNAPSHOT_MAX_BYTES };`,
    ctx,
  );
  return ctx.api;
}

// fetch that fails like Chromium does when the body is the File itself.
function fakeFetch(log) {
  return async (url, init) => {
    log.push(init.body);
    if (!(init.body instanceof Blob)) throw new TypeError("Failed to fetch");
    assert.equal(init.method, "PUT");
    assert.equal(init.headers["Content-Type"], "image/jpeg");
    return { ok: true, status: 200, bytes: (await init.body.arrayBuffer()).byteLength };
  };
}
const INIT = { method: "PUT", mode: "cors", headers: { "Content-Type": "image/jpeg" } };
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36";
const DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36";

// 1. Android: copied at pick time; both uploads of the same selection send the copy.
{
  const log = [];
  const api = load(ANDROID, fakeFetch(log));
  assert.equal(api.SNAPSHOT_ON_PICK, true);
  const file = proxyFile([1, 2, 3, 4]);
  const item = { file, snapshot: api.SNAPSHOT_ON_PICK ? api.snapshotFile(file) : null };
  const first = await api.putSelectedFile(item, "https://r2.example/b/k", INIT);
  const second = await api.putSelectedFile(item, "https://r2.example/b/k2", INIT);
  assert.equal(first.ok && second.ok, true);
  assert.equal(first.bytes, 4);
  assert.equal(log.length, 2, "no failed attempt: the File itself is never sent");
  assert.ok(log.every((body) => body instanceof Blob));
  assert.equal(file.reads, 1, "the file is read once, at pick time");
}

// 2. Desktop: no copy at pick time; the File goes as is, and if the browser
//    can't send it the studio copies it and retries once.
{
  const log = [];
  const api = load(DESKTOP, fakeFetch(log));
  assert.equal(api.SNAPSHOT_ON_PICK, false);
  const file = proxyFile([9, 9]);
  const item = { file, snapshot: null };
  const res = await api.putSelectedFile(item, "https://r2.example/b/k", INIT);
  assert.equal(res.ok, true);
  assert.equal(log.length, 2);
  assert.equal(log[0], file, "first attempt sends the File, as before");
  assert.ok(log[1] instanceof Blob);
  // The copy is kept for a later upload of the same selection.
  await api.putSelectedFile(item, "https://r2.example/b/k2", INIT);
  assert.equal(file.reads, 1);
}

// 3. Healthy browser: the File is sent once and never read into memory.
{
  const log = [];
  const api = load(DESKTOP, async (url, init) => { log.push(init.body); return { ok: true, status: 200 }; });
  const file = proxyFile([1]);
  await api.putSelectedFile({ file, snapshot: null }, "https://r2.example/b/k", INIT);
  assert.deepEqual(log, [file]);
  assert.equal(file.reads, 0);
}

// 4. Unreadable file: the original network error comes back, explained for a person.
{
  const api = load(DESKTOP, fakeFetch([]));
  const file = proxyFile([1], { readable: false });
  await assert.rejects(
    api.putSelectedFile({ file, snapshot: null }, "https://r2.example/b/k", INIT),
    (error) => error instanceof TypeError && error.message === "Failed to fetch",
  );
  const message = api.explainBrowserUploadFailure(new TypeError("Failed to fetch"), "https://r2.example/b/k").message;
  assert.match(message, /Failed to fetch/);
  assert.match(message, /select the file again/);
  assert.doesNotMatch(message, /CORS|CSP/);
}

// 5. A pick that can't be read, or is too big, has no copy and falls back to the File.
{
  const api = load(ANDROID, fakeFetch([]));
  assert.equal(await api.snapshotFile(proxyFile([1], { readable: false })), null);
  assert.equal(await api.snapshotFile({ size: api.SNAPSHOT_MAX_BYTES + 1, type: "video/mp4", arrayBuffer() { throw new Error("must not read"); } }), null);
  assert.equal(await api.snapshotFile(null), null);
}

console.log("check-studio-android-upload: ok");
