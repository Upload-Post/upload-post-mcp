#!/usr/bin/env node
/**
 * Regression check for plan limits.
 *
 * When the monthly allowance is used up, or a Free-plan account publishes to
 * TikTok, the upload_* tools must hand the model `next_step` and
 * `upgrade_url` instead of a bare API error, and tell it not to retry. The
 * server instructions must warn about TikTok on the Free plan before anything
 * is prepared. Run after `npm run build`.
 *
 * The Upload-Post SDK is replaced by an in-memory fake, so nothing leaves the
 * process. The error strings are the ones the API sends today.
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { UploadPostMcpClient } from "../dist/client.js";
import { UPGRADE_URL, classifyPlanError, upgradeUrlFrom } from "../dist/plan.js";

const MONTHLY =
  "Upload-Post API error: This upload (3 platforms) would exceed your monthly limit of 10 uploads. " +
  `You have 2 upload(s) remaining this period. Paid plans have unlimited uploads: ${UPGRADE_URL}`;
const MONTHLY_NONE = MONTHLY.replace("You have 2 upload(s)", "You have 0 upload(s)");
const TIKTOK = `Upload-Post API error: TikTok uploads are not available on the Free plan. Please upgrade to a paid plan: ${UPGRADE_URL}`;
const RAW_BODY =
  'Upload-Post API POST /upload_text failed (429): {"success":false,"message":"Over the limit","error_code":"monthly_limit_reached","upgrade_url":"https://app.upload-post.com/pricing?plan=pro"}';

function fakeAccount(uploadError) {
  const calls = [];
  const sdk = {
    async listUsers() {
      calls.push(["listUsers"]);
      return { success: true, plan: "Default", profiles: [{ username: "marca", social_accounts: { tiktok: { handle: "m" } } }] };
    },
  };
  for (const m of ["upload", "uploadPhotos", "uploadText", "uploadDocument"]) {
    sdk[m] = async (...args) => {
      calls.push([m, ...args]);
      throw new Error(uploadError);
    };
  }
  return { sdk, calls };
}

async function connect(account) {
  const upClient = new UploadPostMcpClient({ apiKey: "test", baseUrl: "https://example.invalid" });
  Object.assign(upClient.sdk, account.sdk);
  const server = buildServer(upClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "claude-ai", version: "0.0.0-test" });
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

// --- classification ----------------------------------------------------------
assert.equal(classifyPlanError(MONTHLY), "monthly_limit");
assert.equal(classifyPlanError(TIKTOK), "tiktok_plan");
assert.equal(classifyPlanError(RAW_BODY), "monthly_limit", "error_code in a raw body counts too");
assert.equal(classifyPlanError("Upload-Post API error: Username not associated with any profile"), undefined);
assert.equal(classifyPlanError("Upload-Post API error: Too many requests. Please try again later."), undefined,
  "the per-minute rate limit is not a plan limit");
assert.equal(upgradeUrlFrom(MONTHLY), UPGRADE_URL);
assert.equal(upgradeUrlFrom(`Upgrade here: ${UPGRADE_URL}.`), UPGRADE_URL, "trailing full stop is not part of the link");
assert.equal(upgradeUrlFrom(RAW_BODY), "https://app.upload-post.com/pricing?plan=pro", "link from a JSON body");
assert.equal(upgradeUrlFrom("no link here"), UPGRADE_URL, "falls back to the Basic checkout");

// --- server instructions -------------------------------------------------------
{
  const s = await connect(fakeAccount("unused"));
  const instructions = s.client.getInstructions();
  assert.match(instructions, /"Default" is the Free plan/);
  assert.match(instructions, /cannot publish to TikTok/);
  assert.match(instructions, /before connecting it or preparing the post/);
  assert.ok(instructions.includes(UPGRADE_URL), "instructions carry the checkout link");
  assert.match(instructions, /do not retry it as is/);
  await s.close();
}

// --- monthly allowance used up, some uploads left -------------------------------
{
  const account = fakeAccount(MONTHLY);
  const s = await connect(account);
  const r = await s.call("upload_text", { confirmed: true, user: "marca", title: "Hola", platforms: ["x", "linkedin", "threads"] });
  assert.equal(r.isError, true);
  assert.equal(r.result.error_code, "monthly_limit_reached");
  assert.equal(r.result.upgrade_url, UPGRADE_URL);
  assert.equal(r.result.monthly_limit, 10);
  assert.equal(r.result.remaining, 2);
  assert.match(r.result.next_step, /used up its monthly uploads, so nothing was published\. Do not retry\./);
  assert.match(r.result.next_step, /2 upload\(s\) are left this period/);
  assert.match(r.result.next_step, /unlimited uploads/);
  assert.match(r.result.next_step, /fewer platforms/, "offers to stay within what is left");
  assert.ok(r.text.includes(MONTHLY), "the original API message is kept");
  assert.equal(account.calls.filter((c) => c[0] === "uploadText").length, 1, "no automatic retry");
  assert.equal(account.calls.filter((c) => c[0] === "listUsers").length, 0, "no connect lookup for a plan error");
  console.log("monthly limit →", r.result.next_step);
  await s.close();
}

// --- monthly allowance used up, nothing left -------------------------------------
{
  const s = await connect(fakeAccount(MONTHLY_NONE));
  const r = await s.call("upload_text", { confirmed: true, user: "marca", title: "Hola", platforms: ["x"] });
  assert.equal(r.result.remaining, 0);
  assert.doesNotMatch(r.result.next_step, /fewer platforms/, "nothing left to fit into");
  assert.match(r.result.next_step, /once they confirm they have upgraded\.$/);
  await s.close();
}

// --- TikTok on the Free plan, with other platforms in the same request ------------
{
  const account = fakeAccount(TIKTOK);
  const s = await connect(account);
  const r = await s.call("upload_photos", { confirmed: true,
    user: "marca",
    title: "Hola",
    photosPathsOrUrls: ["https://example.invalid/a.jpg"],
    platforms: ["tiktok", "instagram", "x"],
  });
  assert.equal(r.isError, true);
  assert.equal(r.result.error_code, "plan_required");
  assert.equal(r.result.plan_required_for, "tiktok");
  assert.equal(r.result.upgrade_url, UPGRADE_URL);
  assert.match(r.result.next_step, /Basic or higher/);
  assert.match(r.result.next_step, /not even to instagram, x/);
  assert.match(r.result.next_step, /Offer to publish now to instagram, x without TikTok, and do so only if they agree/);
  assert.equal(account.calls.filter((c) => c[0] === "uploadPhotos").length, 1, "never drops TikTok and retries on its own");
  console.log("tiktok free plan →", r.result.next_step);
  await s.close();
}

// --- TikTok only ---------------------------------------------------------------------
{
  const s = await connect(fakeAccount(TIKTOK));
  const r = await s.call("upload_photos", { confirmed: true, user: "marca", title: "Hola", photosPathsOrUrls: ["https://example.invalid/a.jpg"], platforms: ["tiktok"] });
  assert.doesNotMatch(r.result.next_step, /Offer to publish now/);
  assert.match(r.result.next_step, /Publish to TikTok once they confirm they have upgraded\./);
  await s.close();
}

// --- other errors are left alone ---------------------------------------------------------
{
  const s = await connect(fakeAccount("Upload-Post API error: Video duration exceeds the maximum"));
  const r = await s.call("upload_text", { confirmed: true, user: "marca", title: "Hola", platforms: ["x"] });
  assert.equal(r.isError, true);
  assert.equal(r.result, undefined, "no plan guidance for unrelated errors");
  assert.match(r.text, /Video duration exceeds the maximum/);
  await s.close();
}

console.log("plan guidance OK");
