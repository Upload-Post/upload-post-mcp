#!/usr/bin/env node
/**
 * Regression check for the "Your social accounts" MCP Apps view.
 *
 * - who gets it: hosts that declare MCP Apps in `initialize`, never ChatGPT
 *   (its surface is the reviewed one) and never hosts that do not render it;
 * - what each card says per network (connected / reconnect / not connected);
 * - the signed link is minted on the click, one per network, never on render;
 * - an expired connection gets the signed link too, not the login page;
 * - the auto-refresh stops at its cap.
 *
 * The Upload-Post SDK is replaced by an in-memory fake, so nothing leaves the
 * process. Run after `npm run build`.
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { UploadPostMcpClient } from "../dist/client.js";
import {
  NETWORKS,
  NETWORKS_TOOL,
  NETWORK_LINK_TOOL,
  NETWORKS_VIEW_URI,
  POLL,
  pollDecision,
  networkState,
  networksViewHtmlForTests,
} from "../dist/tools/networks.js";

const MCP_APP_MIME = "text/html;profile=mcp-app";
const APPS = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [MCP_APP_MIME] } } };
const SIGNED = "https://app.upload-post.com/connect?token=FAKE.JWT.TOKEN";
const MANAGE = "https://app.upload-post.com/manage-users";

function fakeAccount({ profiles = [], uploadError } = {}) {
  const calls = [];
  const state = { profiles: structuredClone(profiles) };
  const sdk = {
    async listUsers() {
      calls.push(["listUsers"]);
      return { success: true, plan: "default", limit: 2, profiles: state.profiles };
    },
    async createUser(username) {
      calls.push(["createUser", username]);
      state.profiles.push({ username, social_accounts: { tiktok: "" } });
      return { success: true, profile: { username } };
    },
    async generateJwt(username, options) {
      calls.push(["generateJwt", username, options]);
      return { success: true, access_url: `${SIGNED}&n=${calls.length}`, duration: "48h" };
    },
  };
  for (const m of ["upload", "uploadPhotos", "uploadText", "uploadDocument"]) {
    sdk[m] = async (...args) => {
      calls.push([m, ...args]);
      if (uploadError) throw new Error(uploadError);
      return { success: true, request_id: "req_1" };
    };
  }
  return { sdk, calls, state };
}

async function session(clientName, capabilities, account = fakeAccount()) {
  const upClient = new UploadPostMcpClient({ apiKey: "test", baseUrl: "https://example.invalid" });
  Object.assign(upClient.sdk, account.sdk);
  const server = buildServer(upClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: clientName, version: "0.0.0-test" }, capabilities ? { capabilities } : undefined);
  await client.connect(clientTransport);
  const tools = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
  const resources = (await client.listResources()).resources;
  return {
    client,
    tools,
    resources,
    account,
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
    async close() {
      await client.close();
      await server.close();
    },
  };
}

// --- who sees the view -------------------------------------------------------
{
  const claude = await session("claude-ai", APPS);
  const view = claude.tools.get(NETWORKS_TOOL);
  assert.ok(view, "an MCP Apps host gets the social accounts tool");
  assert.equal(view._meta.ui.resourceUri, NETWORKS_VIEW_URI, "the tool points at its ui:// view");
  assert.deepEqual(view._meta.ui.visibility, ["model", "app"]);
  assert.equal(view.annotations.readOnlyHint, true, "showing the cards changes nothing");
  assert.ok(!/https?:\/\//.test(view.description), "no URLs in the description");
  const link = claude.tools.get(NETWORK_LINK_TOOL);
  assert.ok(link, "the click helper is registered for the view");
  assert.deepEqual(link._meta.ui.visibility, ["app"], "the click helper is for the view only, not the model");
  assert.deepEqual(
    claude.resources.map((r) => [r.uri, r.mimeType]),
    [[NETWORKS_VIEW_URI, MCP_APP_MIME]],
    "only the standard view is listed; the ChatGPT-only Studio stays hidden"
  );
  const read = await claude.client.readResource({ uri: NETWORKS_VIEW_URI });
  assert.equal(read.contents[0].mimeType, MCP_APP_MIME);
  assert.equal(read.contents[0]._meta.ui.domain, undefined, "no ui.domain: each host has its own format");
  assert.match(read.contents[0].text, /ui\/initialize/);
  assert.match(read.contents[0].text, /ui\/open-link/);
  const withView = [...claude.tools.keys()];
  await claude.close();

  for (const [name, caps] of [
    ["claude-ai", undefined],
    ["cursor-vscode", undefined],
    ["Claude Code", { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html+other"] } } }],
  ]) {
    const s = await session(name, caps);
    assert.ok(!s.tools.has(NETWORKS_TOOL), `${name} without MCP Apps does not get the view tool`);
    assert.ok(!s.tools.has(NETWORK_LINK_TOOL), `${name} without MCP Apps does not get the click helper`);
    assert.equal(s.resources.length, 0, `${name} without MCP Apps lists no ui:// resource`);
    assert.deepEqual(
      [...s.tools.keys()],
      withView.filter((t) => t !== NETWORKS_TOOL && t !== NETWORK_LINK_TOOL),
      `${name} keeps exactly the tools it had`
    );
    await s.close();
  }

  const chatgpt = await session("openai-mcp", APPS);
  assert.ok(!chatgpt.tools.has(NETWORKS_TOOL) && !chatgpt.tools.has(NETWORK_LINK_TOOL), "ChatGPT: not before review");
  assert.deepEqual(chatgpt.resources.map((r) => r.uri), ["ui://upload-post/video-upload-studio.html"]);
  await chatgpt.close();

  process.env.UPLOAD_POST_MCP_APPS = "off";
  const off = await session("claude-ai", APPS);
  assert.ok(!off.tools.has(NETWORKS_TOOL), "UPLOAD_POST_MCP_APPS=off turns the view off");
  assert.equal(off.resources.length, 0);
  await off.close();
  delete process.env.UPLOAD_POST_MCP_APPS;
}

// --- state per network -----------------------------------------------------------
{
  const account = fakeAccount({
    profiles: [
      {
        username: "default",
        social_accounts: {
          tiktok: { display_name: "Ana Clips", handle: "anaclips", reauth_required: false },
          x: { display_name: "Ana", handle: "ana", reauth_required: true },
          instagram: "",
          youtube: {},
        },
      },
    ],
  });
  const s = await session("claude-ai", APPS, account);
  const res = await s.call(NETWORKS_TOOL, { platforms: ["instagram", "twitter"] });
  const sc = res.structuredContent;
  assert.equal(sc.view, "social_accounts");
  assert.equal(sc.selected, "default");
  assert.deepEqual(sc.profiles[0].accounts, {
    tiktok: { state: "connected", name: "Ana Clips" },
    x: { state: "reconnect", name: "Ana" },
  });
  assert.deepEqual(sc.highlight, ["instagram", "x"], "asked-for networks first, aliases normalised");
  assert.equal(sc.one_click, true, "the default profile gets signed links");
  const accounts = sc.profiles[0].accounts;
  assert.equal(networkState(accounts, "tiktok"), "connected");
  assert.equal(networkState(accounts, "x"), "reconnect");
  assert.equal(networkState(accounts, "instagram"), "not_connected");
  assert.equal(networkState(accounts, "youtube"), "not_connected", "an empty object is not a connection");
  assert.equal(networkState({}, "reddit", false), "unavailable");
  assert.equal(networkState({}, "reddit", true), "not_connected");
  assert.equal(networkState({ reddit: { state: "reconnect" } }, "reddit", false), "unavailable", "no Reconnect button while Reddit is down");
  assert.equal(networkState({ reddit: { state: "connected" } }, "reddit", false), "connected");
  const text = res.content[0].text;
  assert.match(text, /Connected: TikTok \(Ana Clips\)\./);
  assert.match(text, /Needs reconnecting before publishing: X\./);
  assert.match(text, /Asked for but not ready yet: Instagram, X\./);
  assert.ok(
    !s.account.calls.some(([m]) => m === "generateJwt" || m === "createUser"),
    "rendering the cards creates no link and no profile"
  );
  await s.close();
}

// --- the link is created on the click, per network ------------------------------
{
  const s = await session("claude-ai", APPS, fakeAccount());
  const view = await s.call(NETWORKS_TOOL);
  assert.equal(view.structuredContent.selected, null, "a new account has no profile yet");
  assert.match(view.content[0].text, /no profile and no connected social account/);
  assert.deepEqual(s.account.calls, [["listUsers"]], "nothing is created before a click");

  const tiktok = (await s.call(NETWORK_LINK_TOOL, { platform: "tiktok" })).structuredContent.result;
  assert.equal(tiktok.signed, true);
  assert.equal(tiktok.created_profile, true, "the first click creates the default profile");
  assert.deepEqual(s.account.calls.filter(([m]) => m !== "listUsers"), [
    ["createUser", "default"],
    ["generateJwt", "default", { platforms: ["tiktok"] }],
  ]);

  const instagram = (await s.call(NETWORK_LINK_TOOL, { platform: "instagram", profile: "default" })).structuredContent
    .result;
  assert.notEqual(instagram.connect_url, tiktok.connect_url, "each click mints its own link");
  assert.deepEqual(s.account.calls.at(-1), ["generateJwt", "default", { platforms: ["instagram"] }]);

  const bluesky = (await s.call(NETWORK_LINK_TOOL, { platform: "bluesky", profile: "default" })).structuredContent
    .result;
  assert.equal(bluesky.mode, "form");
  assert.deepEqual(s.account.calls.at(-1), ["generateJwt", "default", {}], "credential networks open the full page");

  const reddit = await s.call(NETWORK_LINK_TOOL, { platform: "reddit", profile: "default" });
  assert.equal(reddit.isError, true, "Reddit stays off while it is unavailable");
  await s.close();
}

// Profiles the MCP does not own keep their white-label settings: dashboard link.
{
  const s = await session(
    "claude-ai",
    APPS,
    fakeAccount({ profiles: [{ username: "brand", social_accounts: {} }, { username: "client2", social_accounts: {} }] })
  );
  const view = await s.call(NETWORKS_TOOL, { profile: "client2" });
  assert.equal(view.structuredContent.selected, "client2");
  assert.equal(view.structuredContent.one_click, false);
  const link = (await s.call(NETWORK_LINK_TOOL, { platform: "tiktok", profile: "client2" })).structuredContent.result;
  assert.equal(link.connect_url, MANAGE);
  assert.equal(link.signed, false);
  assert.ok(!s.account.calls.some(([m]) => m === "generateJwt"), "no JWT for a profile the MCP does not own");
  await s.close();
}

// --- reconnect uses the signed link -----------------------------------------------
{
  const account = fakeAccount({
    uploadError:
      "Upload-Post API error: Authentication issue. Please reconnect your instagram account at https://app.upload-post.com/manage-users.",
    profiles: [{ username: "default", social_accounts: { instagram: { handle: "m", reauth_required: true } } }],
  });
  const s = await session("claude-ai", undefined, account);
  const res = await s.call("upload_photos", {
    confirmed: true,
    user: "default",
    platforms: ["instagram"],
    photosPathsOrUrls: ["https://example.com/a.jpg"],
  });
  const text = res.content.map((c) => c.text).join("\n");
  assert.equal(res.isError, true);
  assert.match(text, /connection has expired and must be reconnected/);
  assert.match(text, /connect\?token=FAKE\.JWT\.TOKEN/, "reconnect gets the one-click link");
  assert.ok(!text.includes(`Open this link to connect instagram to Upload-Post: ${MANAGE}`), "not the login page");
  assert.deepEqual(account.calls.at(-1), ["generateJwt", "default", { platforms: ["instagram"] }]);
  await s.close();
}

// --- onboarding: list_users points MCP Apps hosts at the cards ------------------------
{
  const apps = await session("claude-ai", APPS, fakeAccount());
  const withView = (await apps.call("list_users")).structuredContent.result.next_step;
  assert.match(withView, new RegExp(`call ${NETWORKS_TOOL}`));
  await apps.close();
  for (const [name, caps] of [["claude-ai", undefined], ["openai-mcp", APPS]]) {
    const s = await session(name, caps, fakeAccount());
    const next = (await s.call("list_users")).structuredContent.result.next_step;
    assert.ok(!next.includes(NETWORKS_TOOL), `${name}: no pointer to a view it does not have`);
    await s.close();
  }
}

// --- auto-refresh cap ---------------------------------------------------------------
{
  const start = 1_000_000;
  assert.equal(pollDecision({ startedAt: start, polls: 0, total: 0, pending: 1 }, start, POLL), "poll");
  assert.equal(pollDecision({ startedAt: start, polls: 3, total: 3, pending: 0 }, start, POLL), "done");
  assert.equal(pollDecision({ startedAt: start, polls: POLL.maxPolls, total: 0, pending: 1 }, start, POLL), "limit");
  assert.equal(pollDecision({ startedAt: start, polls: 1, total: 1, pending: 1 }, start + POLL.maxMs, POLL), "limit");
  assert.equal(pollDecision({ startedAt: start, polls: 0, total: POLL.maxTotalPolls, pending: 1 }, start, POLL), "limit");

  // A network that never connects: the view stops by itself.
  let polls = 0;
  let total = 0;
  let now = start;
  while (pollDecision({ startedAt: start, polls, total, pending: 1 }, now, POLL) === "poll") {
    polls++;
    total++;
    now += POLL.intervalMs;
    assert.ok(polls < 1000, "runaway polling");
  }
  assert.ok(polls <= POLL.maxPolls && (polls - 1) * POLL.intervalMs < POLL.maxMs, `stopped after ${polls} checks`);
  assert.ok(POLL.intervalMs >= 3000, "no tighter than every 3 s");

  // Clicking again restarts the window, never the lifetime cap.
  let lifetime = 0;
  for (let click = 0; click < 10; click++) {
    let p = 0;
    while (pollDecision({ startedAt: 0, polls: p, total: lifetime, pending: 1 }, p * POLL.intervalMs, POLL) === "poll") {
      p++;
      lifetime++;
    }
  }
  assert.equal(lifetime, POLL.maxTotalPolls, "one view never checks more than maxTotalPolls times");

  // The view runs this exact function and these limits.
  const html = networksViewHtmlForTests();
  assert.ok(html.includes(pollDecision.toString()), "the view inlines pollDecision");
  assert.ok(html.includes(JSON.stringify(POLL)), "the view uses POLL");
  assert.ok(html.includes(JSON.stringify(NETWORKS)), "the view knows every network");
}

console.log("check-networks-widget: ok");
