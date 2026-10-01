#!/usr/bin/env node
/**
 * Regression check for new-account onboarding.
 *
 * Accounts created from ChatGPT/Claude start with no profile and no connected
 * social account. list_users, get_connect_link and the upload_* errors must
 * hand the model a link to connect and tell it to wait, instead of a bare
 * "Username not associated with any profile". Run after `npm run build`.
 *
 * The Upload-Post SDK is replaced by an in-memory fake, so nothing leaves the
 * process.
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { UploadPostMcpClient } from "../dist/client.js";

const MANAGE = "https://app.upload-post.com/manage-users";
const SIGNED = "https://app.upload-post.com/connect?token=FAKE.JWT.TOKEN";
const NOT_ASSOCIATED = "Upload-Post API error: Username not associated with any profile";

/** In-memory stand-in for the Upload-Post account behind the API key. */
function fakeAccount({ profiles = [], createError, uploadError, uploadResult } = {}) {
  const calls = [];
  const state = { profiles: structuredClone(profiles) };
  const sdk = {
    async listUsers() {
      calls.push(["listUsers"]);
      return { success: true, plan: "default", limit: 2, profiles: state.profiles };
    },
    async createUser(username) {
      calls.push(["createUser", username]);
      if (createError) throw new Error(createError);
      if (state.profiles.some((p) => p.username === username)) {
        throw new Error("Upload-Post API error: Username already in use");
      }
      state.profiles.push({ username, social_accounts: { tiktok: "" } });
      return { success: true, profile: { username } };
    },
    async generateJwt(username, options) {
      calls.push(["generateJwt", username, options]);
      if (!state.profiles.some((p) => p.username === username)) {
        throw new Error(`Upload-Post API error: Profile '${username}' not found for this user.`);
      }
      return { success: true, access_url: SIGNED, duration: "48h" };
    },
  };
  for (const m of ["upload", "uploadPhotos", "uploadText", "uploadDocument"]) {
    sdk[m] = async (...args) => {
      calls.push([m, ...args]);
      if (uploadError) throw new Error(uploadError);
      return uploadResult ?? { success: true, request_id: "req_1" };
    };
  }
  return { sdk, calls, state };
}

async function connect(account, clientName = "claude-ai") {
  const upClient = new UploadPostMcpClient({ apiKey: "test", baseUrl: "https://example.invalid" });
  Object.assign(upClient.sdk, account.sdk);
  const server = buildServer(upClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: clientName, version: "0.0.0-test" });
  await client.connect(clientTransport);
  return {
    client,
    async call(name, args = {}) {
      const res = await client.callTool({ name, arguments: args });
      return {
        isError: res.isError === true,
        text: res.content.map((c) => c.text).join("\n"),
        result: res.structuredContent?.result,
      };
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

const called = (account, method) => account.calls.filter((c) => c[0] === method);

// --- server instructions ----------------------------------------------------
{
  const s = await connect(fakeAccount());
  const instructions = s.client.getInstructions();
  assert.match(instructions, /list_users/);
  assert.match(instructions, /get_connect_link/);
  assert.match(instructions, /never invent a profile name/i);
  const tools = new Map((await s.client.listTools()).tools.map((t) => [t.name, t]));
  assert.ok(tools.has("get_connect_link"), "get_connect_link must be exposed");
  assert.match(tools.get("list_users").description, /connect_url/);
  assert.equal(tools.get("list_users").annotations.readOnlyHint, true, "list_users stays read-only");
  await s.close();
}

// --- list_users: brand-new account ------------------------------------------
{
  const account = fakeAccount();
  const s = await connect(account);
  const r = await s.call("list_users", { platforms: ["tiktok"] });
  assert.equal(r.isError, false);
  assert.deepEqual(r.result.profiles, []);
  assert.equal(r.result.connect_url, MANAGE);
  assert.match(r.result.next_step, /no profile and no connected social account/);
  assert.match(r.result.next_step, /get_connect_link/);
  assert.match(r.result.next_step, /Open this link to connect tiktok to Upload-Post/);
  assert.match(r.result.next_step, /wait for the user to confirm/);
  assert.equal(called(account, "createUser").length, 0, "list_users must never create anything");
  console.log("list_users (empty) →", JSON.stringify(r.result, null, 2));
  await s.close();
}

// --- list_users: profile exists but the platform is not connected ------------
{
  const account = fakeAccount({
    profiles: [
      {
        username: "marca",
        social_accounts: {
          tiktok: "",
          instagram: { handle: "marca", display_name: "Marca", reauth_required: true },
          youtube: { handle: "marcatv", display_name: "Marca TV" },
        },
      },
    ],
  });
  const s = await connect(account);
  const r = await s.call("list_users", { platforms: ["tiktok", "instagram", "youtube"] });
  assert.equal(r.result.connect_url, MANAGE);
  assert.match(r.result.next_step, /tiktok is not connected to any profile/);
  assert.match(r.result.next_step, /instagram \(profile "marca"\) connection expired/);
  assert.doesNotMatch(r.result.next_step, /youtube/);
  console.log("list_users (tiktok missing, instagram expired) →", r.result.next_step);

  const ok = await s.call("list_users", { platforms: ["youtube"] });
  assert.equal(ok.result.next_step, undefined, "no guidance when the platform is connected");
  assert.equal(ok.result.connect_url, undefined);
  const plain = await s.call("list_users");
  assert.equal(plain.result.next_step, undefined, "no guidance when something is connected and nothing was asked");
  await s.close();
}

// --- list_users: profiles exist, nothing connected ---------------------------
{
  const s = await connect(fakeAccount({ profiles: [{ username: "default", social_accounts: { tiktok: "" } }] }));
  const r = await s.call("list_users");
  assert.match(r.result.next_step, /None of this account's profiles has a connected social account yet/);
  await s.close();
}

// --- get_connect_link: creates "default" and returns a signed link ----------
{
  const account = fakeAccount();
  const s = await connect(account);
  const r = await s.call("get_connect_link", { platforms: ["tiktok", "instagram"] });
  assert.equal(r.isError, false);
  assert.equal(r.result.connect_url, SIGNED);
  assert.equal(r.result.signed, true);
  assert.equal(r.result.profile, "default");
  assert.equal(r.result.created_profile, true);
  assert.deepEqual(called(account, "createUser"), [["createUser", "default"]]);
  assert.deepEqual(called(account, "generateJwt")[0][2], { platforms: ["tiktok", "instagram"] });
  assert.match(r.result.next_step, /Open this link to connect tiktok and instagram to Upload-Post: https:\/\/app\.upload-post\.com\/connect\?token=/);
  console.log("get_connect_link (empty account) →", JSON.stringify(r.result, null, 2));

  // Second call reuses the profile it created instead of creating another.
  const again = await s.call("get_connect_link", {});
  assert.equal(again.result.connect_url, SIGNED);
  assert.equal(again.result.created_profile, false);
  assert.equal(called(account, "createUser").length, 1);
  await s.close();
}

// --- get_connect_link: never mints a JWT for someone else's profile ----------
{
  const account = fakeAccount({
    profiles: [
      { username: "cliente-a", social_accounts: { tiktok: "" } },
      { username: "cliente-b", social_accounts: {} },
    ],
  });
  const s = await connect(account);
  const r = await s.call("get_connect_link", { profile: "cliente-a", platforms: ["tiktok"] });
  assert.equal(r.result.connect_url, MANAGE);
  assert.equal(r.result.signed, false);
  assert.equal(called(account, "generateJwt").length, 0, "generate_jwt resets white-label settings");
  assert.equal(called(account, "createUser").length, 0);
  await s.close();
}

// --- get_connect_link: plan limit → dashboard link, no error ----------------
{
  const account = fakeAccount({ createError: "Upload-Post API error: You have reached the limit of 2 profiles" });
  const s = await connect(account);
  const r = await s.call("get_connect_link", {});
  assert.equal(r.isError, false);
  assert.equal(r.result.connect_url, MANAGE);
  assert.equal(called(account, "generateJwt").length, 0);
  await s.close();
}

// --- upload_*: unknown profile on a brand-new account -----------------------
{
  const account = fakeAccount({ uploadError: NOT_ASSOCIATED });
  const s = await connect(account);
  const r = await s.call("upload_text", { user: "my_profile", platforms: ["x"], title: "hola" });
  assert.equal(r.isError, true);
  assert.match(r.text, /Username not associated with any profile/, "keeps the original API error");
  assert.match(r.text, /the profile "default" was just created/);
  assert.match(r.text, /Open this link to connect x to Upload-Post: https:\/\/app\.upload-post\.com\/connect\?token=FAKE\.JWT\.TOKEN/);
  assert.match(r.text, /publish with user "default"/);
  assert.equal(r.result.connect_url, SIGNED);
  console.log("upload_text (no profiles) →\n" + r.text);
  await s.close();
}

// --- upload_*: unknown profile when other profiles exist --------------------
{
  const account = fakeAccount({
    uploadError: NOT_ASSOCIATED,
    profiles: [{ username: "marca", social_accounts: { tiktok: { handle: "marca" } } }],
  });
  const s = await connect(account);
  const r = await s.call("upload_photos", {
    user: "Marca Oficial",
    platforms: ["tiktok"],
    photosPathsOrUrls: ["https://example.com/a.jpg"],
  });
  assert.equal(r.isError, true);
  assert.match(r.text, /Profile "Marca Oficial" does not exist/);
  assert.match(r.text, /"marca" \(tiktok\)/);
  assert.equal(called(account, "createUser").length, 0, "must not create a profile when the user already has one");
  console.log("upload_photos (wrong profile name) →\n" + r.text);
  await s.close();
}

// --- upload_*: wrong name, and the only profile is the empty "default" -----
{
  const account = fakeAccount({
    uploadError: NOT_ASSOCIATED,
    profiles: [{ username: "default", social_accounts: { tiktok: "" } }],
  });
  const s = await connect(account);
  const r = await s.call("upload_text", { user: "juan", platforms: ["linkedin"], title: "x" });
  assert.match(r.text, /None of them has a connected social account yet/);
  assert.equal(r.result.connect_url, SIGNED, "the MCP-owned default profile gets a one-click link");
  assert.equal(called(account, "createUser").length, 0);
  await s.close();
}

// --- upload_*: platform not connected ---------------------------------------
{
  const account = fakeAccount({
    uploadError:
      'Upload-Post API error: None of the requested platforms are valid for profile "marca". Profile marca has no TikTok account configured',
    profiles: [{ username: "marca", social_accounts: { tiktok: "", youtube: { handle: "m" } } }],
  });
  const s = await connect(account);
  const r = await s.call("upload_video", {
    user: "marca",
    platforms: ["tiktok"],
    videoPathOrUrl: "https://example.com/v.mp4",
  });
  assert.equal(r.isError, true);
  assert.match(r.text, /tiktok is not connected to profile "marca"/);
  assert.match(r.text, new RegExp(`Open this link to connect tiktok to Upload-Post: ${MANAGE}`));
  console.log("upload_video (tiktok not connected) →\n" + r.text);
  await s.close();
}

// --- upload_*: expired connection -------------------------------------------
{
  const account = fakeAccount({
    uploadError:
      "Upload-Post API error: Authentication issue. Please reconnect your instagram account at https://app.upload-post.com/manage-users.",
    profiles: [{ username: "marca", social_accounts: { instagram: { handle: "m", reauth_required: true } } }],
  });
  const s = await connect(account);
  const r = await s.call("upload_text", { user: "marca", platforms: ["threads"], title: "x" });
  assert.match(r.text, /connection has expired and must be reconnected/);
  assert.match(r.text, /manage-users/);
  await s.close();
}

// --- upload_*: partial success with a skipped platform ----------------------
{
  const account = fakeAccount({
    profiles: [{ username: "marca", social_accounts: { youtube: { handle: "m" } } }],
    uploadResult: {
      success: true,
      results: {
        youtube: { success: true, url: "https://youtu.be/x" },
        tiktok: {
          success: false,
          skipped: true,
          skip_reason: "profile_platform_not_configured",
          error: "Profile marca has no TikTok account configured",
        },
      },
    },
  });
  const s = await connect(account);
  const r = await s.call("upload_video", {
    user: "marca",
    platforms: ["youtube", "tiktok"],
    videoPathOrUrl: "https://example.com/v.mp4",
  });
  assert.equal(r.isError, false);
  assert.equal(r.result.results.youtube.success, true, "original payload is preserved");
  assert.match(r.result.next_step, /tiktok was skipped because it is not connected/);
  assert.equal(r.result.connect_url, MANAGE);
  await s.close();
}

// --- unrelated errors pass through untouched --------------------------------
{
  const account = fakeAccount({ uploadError: "Upload-Post API error: Daily limit reached" });
  const s = await connect(account);
  const r = await s.call("upload_text", { user: "marca", platforms: ["x"], title: "x" });
  assert.equal(r.text, "Upload-Post API error: Daily limit reached");
  assert.equal(called(account, "listUsers").length, 0);
  await s.close();
}

// --- Upload Studio: script parses and wires the connect button --------------
{
  const s = await connect(fakeAccount(), "openai-mcp");
  const res = await s.client.readResource({ uri: "ui://upload-post/video-upload-studio.html" });
  const html = res.contents[0].text;
  assert.match(html, /id="connectButton"/);
  const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
  assert.doesNotThrow(() => new Function(script), "Studio script must be valid JavaScript");
  // Run the page's own link detector against a real upload_* error.
  const start = script.indexOf("function findConnectUrl");
  const end = script.indexOf("function showConnect");
  const findConnectUrl = new Function(
    "resultText",
    `${script.slice(start, end)}; return findConnectUrl;`
  )((r) => r.content.map((c) => c.text).join("\n"));
  const asText = (text) => ({ isError: true, content: [{ type: "text", text }] });
  assert.equal(findConnectUrl(asText(`Open this link: ${SIGNED}. Then`)), SIGNED);
  assert.equal(findConnectUrl(asText(`reconnect at ${MANAGE}.`)), MANAGE);
  assert.equal(findConnectUrl(asText("Daily limit reached")), "");
  assert.equal(
    findConnectUrl({ isError: true, content: [], structuredContent: { result: { connect_url: SIGNED } } }),
    SIGNED
  );
  await s.close();
}

console.log("connect guidance OK");
