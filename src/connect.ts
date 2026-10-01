import type { UploadPostMcpClient } from "./client.js";
import { fail, ok, type ToolResult } from "./schemas.js";

/**
 * Onboarding guidance for accounts that cannot publish yet.
 *
 * Users who sign up from ChatGPT or Claude start with no profile and no
 * connected social account. Without a pointer the model invents a profile name,
 * the API answers "Username not associated with any profile", and the user is
 * left with an error they cannot act on. Every path that discovers this state
 * (list_users, get_connect_link and failed uploads) answers with the same shape:
 * a link the user can open and the sentence the model should say.
 */

/** Dashboard page where a logged-in owner creates profiles and connects socials. */
export const MANAGE_USERS_URL = "https://app.upload-post.com/manage-users";

/** Profile the MCP creates for an account that has none. */
export const DEFAULT_PROFILE = "default";

export interface ProfileSummary {
  profile: string;
  connected: string[];
  reconnect_required: string[];
}

export interface ConnectLink {
  connect_url: string;
  /** True when `connect_url` is a signed one-click link for `profile` (valid 48 h). */
  signed: boolean;
  profile?: string;
  /** True when this call created `profile`. */
  created_profile?: boolean;
  expires_in?: string;
}

const PLATFORM_ALIASES: Record<string, string> = { twitter: "x" };

function normalizePlatform(p: string): string {
  const key = p.trim().toLowerCase();
  return PLATFORM_ALIASES[key] ?? key;
}

function profilesOf(listUsersResult: unknown): Array<Record<string, unknown>> {
  const profiles = (listUsersResult as { profiles?: unknown } | null)?.profiles;
  return Array.isArray(profiles) ? (profiles as Array<Record<string, unknown>>) : [];
}

/** Which platforms each profile can publish to, and which need a reconnect. */
export function summarizeProfiles(listUsersResult: unknown): ProfileSummary[] {
  return profilesOf(listUsersResult).map((p) => {
    const accounts = (p.social_accounts ?? {}) as Record<string, unknown>;
    const connected: string[] = [];
    const reconnect: string[] = [];
    for (const [platform, value] of Object.entries(accounts)) {
      // An unconnected slot is "" or null (new profiles carry `tiktok: ""`).
      if (!value) continue;
      if (typeof value === "object" && Object.keys(value as object).length === 0) continue;
      const name = normalizePlatform(platform);
      if (typeof value === "object" && (value as { reauth_required?: unknown }).reauth_required === true) {
        reconnect.push(name);
      } else {
        connected.push(name);
      }
    }
    return { profile: String(p.username ?? ""), connected, reconnect_required: reconnect };
  });
}

function humanList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function platformLabel(platforms: string[] | undefined): string {
  return platforms && platforms.length ? humanList(platforms) : "their social accounts";
}

/** The sentence the model should relay. Kept identical across tools on purpose. */
export function connectInstruction(link: ConnectLink, platforms?: string[]): string {
  const what = platformLabel(platforms);
  const where = link.signed
    ? `${link.connect_url} (a one-click link for profile "${link.profile}", valid for 48 hours)`
    : link.connect_url;
  return (
    `Tell the user, in their language: "Open this link to connect ${what} to Upload-Post: ${where} — let me know when it's done." ` +
    "Then stop and wait for the user to confirm. Do not invent a profile name and do not retry the upload until they confirm; " +
    "after they do, call list_users again to check the connection and use the profile name it returns."
  );
}

/**
 * Guidance block appended to list_users. Read-only: it never creates anything,
 * it only tells the model what to do next. Returns undefined when the account
 * can already publish (to the requested platforms, if any).
 */
export function listUsersGuidance(
  listUsersResult: unknown,
  requested?: string[]
): Record<string, unknown> | undefined {
  const summary = summarizeProfiles(listUsersResult);
  const wanted = (requested ?? []).map(normalizePlatform).filter(Boolean);

  if (summary.length === 0) {
    return {
      next_step:
        "This account has no profile and no connected social account yet, so nothing can be published. " +
        `Do not invent a profile name. Call get_connect_link to get a one-click connection link (it creates the profile "${DEFAULT_PROFILE}" for the user); ` +
        `if that tool is not available, call create_user with username "${DEFAULT_PROFILE}" and then generate_jwt with username "${DEFAULT_PROFILE}" and give the user its access_url. ` +
        `If neither is possible, give the user connect_url. ` +
        connectInstruction({ connect_url: MANAGE_USERS_URL, signed: false }, wanted),
      connect_url: MANAGE_USERS_URL,
    };
  }

  const anyConnected = summary.some((s) => s.connected.length > 0);
  // A requested platform no profile can publish to. Expired connections only
  // count here, for what the user asked for: an agency with hundreds of
  // profiles always has a few, and listing them on every call would bury the
  // answer.
  const missing = wanted.filter((w) => !summary.some((s) => s.connected.includes(w)));
  const expired = missing.filter((m) => summary.some((s) => s.reconnect_required.includes(m)));
  const notConnected = missing.filter((m) => !expired.includes(m));

  if (anyConnected && missing.length === 0) return undefined;

  const parts: string[] = [];
  if (!anyConnected) {
    parts.push(
      summary.some((s) => s.reconnect_required.length)
        ? "None of this account's profiles has a working social connection right now (they need reconnecting), so nothing can be published."
        : "None of this account's profiles has a connected social account yet, so nothing can be published."
    );
  }
  if (notConnected.length) {
    parts.push(`${humanList(notConnected)} ${notConnected.length === 1 ? "is" : "are"} not connected to any profile.`);
  }
  if (expired.length) {
    const where = expired.map((p) => {
      const owners = summary.filter((s) => s.reconnect_required.includes(p)).map((s) => `"${s.profile}"`);
      return `${p} (profile ${humanList(owners)})`;
    });
    parts.push(`The ${humanList(where)} connection expired and must be reconnected before publishing.`);
  }
  parts.push("Call get_connect_link for a connection link (pass the profile and platforms), or give the user connect_url.");
  parts.push(connectInstruction({ connect_url: MANAGE_USERS_URL, signed: false }, missing.length ? missing : undefined));
  return { next_step: parts.join(" "), connect_url: MANAGE_USERS_URL };
}

function isConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already in use|already exists|409/i.test(msg);
}

/**
 * Best connection link for this account.
 *
 * Signed one-click links come from generate_jwt, which also RESETS the
 * profile's white-label settings (redirect URL, logo, titles, platform list,
 * language). So a signed link is only minted for a profile the MCP owns:
 * the account has no profile at all (we create "default"), or its only profile
 * is the "default" one we created earlier. Anyone else gets the dashboard,
 * where a logged-in owner connects accounts without touching that config.
 *
 * Never throws: on any API error it falls back to the dashboard link.
 */
export async function resolveConnectLink(
  client: UploadPostMcpClient,
  opts: { profile?: string; platforms?: string[] } = {}
): Promise<ConnectLink> {
  const fallback: ConnectLink = { connect_url: MANAGE_USERS_URL, signed: false };
  try {
    const profiles = profilesOf(await client.sdk.listUsers()).map((p) => String(p.username ?? ""));
    let created = false;
    let target: string | undefined;

    if (profiles.length === 0) {
      try {
        await client.sdk.createUser(DEFAULT_PROFILE);
        created = true;
      } catch (err) {
        // Created by a concurrent call: reuse it. Anything else (plan limit,
        // bad key) leaves the dashboard as the only safe answer.
        if (!isConflict(err)) return fallback;
      }
      target = DEFAULT_PROFILE;
    } else if (
      profiles.length === 1 &&
      profiles[0] === DEFAULT_PROFILE &&
      (!opts.profile || opts.profile === DEFAULT_PROFILE)
    ) {
      target = DEFAULT_PROFILE;
    }

    if (!target) return { ...fallback, profile: opts.profile };

    const platforms = (opts.platforms ?? []).map(normalizePlatform).filter(Boolean);
    const jwt = (await client.sdk.generateJwt(
      target,
      platforms.length ? ({ platforms } as never) : ({} as never)
    )) as { access_url?: unknown; duration?: unknown };
    if (typeof jwt?.access_url !== "string" || !jwt.access_url) {
      return { ...fallback, profile: target, created_profile: created };
    }
    return {
      connect_url: jwt.access_url,
      signed: true,
      profile: target,
      created_profile: created,
      expires_in: typeof jwt.duration === "string" ? jwt.duration : "48h",
    };
  } catch {
    return fallback;
  }
}

// --- upload errors ----------------------------------------------------------

type ConnectErrorKind = "unknown_profile" | "platform_not_connected" | "reconnect";

/** Classify an Upload-Post error message that the user can fix by connecting. */
export function classifyConnectError(message: string): ConnectErrorKind | undefined {
  if (/not associated with any profile|PROFILE_NOT_FOUND/i.test(message)) return "unknown_profile";
  if (
    /None of the requested platforms are valid|has no [\w ]+ account configured|not found in user accounts|profile_platform_not_configured|No [\w ]+ accounts? connected/i.test(
      message
    )
  ) {
    return "platform_not_connected";
  }
  if (/account_reauth_required|reconnect (your|the|it)|please reconnect|reauth/i.test(message)) {
    return "reconnect";
  }
  return undefined;
}

const PLATFORM_IN_MESSAGE =
  /\b(tiktok|instagram|youtube|linkedin|facebook|pinterest|threads|reddit|bluesky|x|twitter|google business|google_business|discord|telegram|mastodon)\b/gi;

function platformsFromMessage(message: string): string[] {
  const found = new Set<string>();
  for (const m of message.matchAll(PLATFORM_IN_MESSAGE)) {
    found.add(normalizePlatform(m[1].replace(" ", "_")));
  }
  return [...found];
}

export interface UploadErrorGuidance {
  text: string;
  structured: Record<string, unknown>;
}

/**
 * Turn an upload failure into something the model can act on, or undefined
 * when the error is not about connections (it is then returned unchanged).
 */
export async function uploadErrorGuidance(
  client: UploadPostMcpClient,
  message: string,
  args: { user?: unknown; platforms?: unknown }
): Promise<UploadErrorGuidance | undefined> {
  const kind = classifyConnectError(message);
  if (!kind) return undefined;
  const requestedProfile = typeof args.user === "string" ? args.user : undefined;
  const requested = Array.isArray(args.platforms) ? (args.platforms as unknown[]).map(String) : [];

  if (kind === "unknown_profile") {
    let summary: ProfileSummary[] | undefined;
    try {
      summary = summarizeProfiles(await client.sdk.listUsers());
    } catch {
      summary = undefined;
    }
    if (summary && summary.length > 0) {
      const names = summary.map((s) =>
        s.connected.length ? `"${s.profile}" (${s.connected.join(", ")})` : `"${s.profile}" (no connected accounts)`
      );
      const lead =
        `Profile "${requestedProfile ?? ""}" does not exist in this Upload-Post account. ` +
        `Existing profiles: ${names.join("; ")}.`;
      if (!summary.some((s) => s.connected.length)) {
        // Right name or not, nothing can publish until something is connected.
        const link = await resolveConnectLink(client, { platforms: requested });
        const text = `${lead} None of them has a connected social account yet, so nothing was published. ${connectInstruction(link, requested)}`;
        return { text, structured: { error: message, next_step: text, profiles: summary, ...link } };
      }
      const text = `${lead} Retry with one of these exact names (ask the user which one if it is not obvious). Do not invent profile names.`;
      return {
        text,
        structured: { error: message, next_step: text, profiles: summary },
      };
    }
    // No profile at all: this is a brand-new account. Give it a profile and a link.
    const link = await resolveConnectLink(client, { platforms: requested });
    const lead = link.created_profile
      ? `This Upload-Post account had no profile and no connected social account, so the profile "${link.profile}" was just created for it. Nothing was published.`
      : "This Upload-Post account has no profile and no connected social account yet, so nothing was published.";
    const text = `${lead} ${connectInstruction(link, requested)}${link.signed ? ` After that, publish with user "${link.profile}".` : ""}`;
    return { text, structured: { error: message, next_step: text, ...link } };
  }

  const platforms = platformsFromMessage(message).filter((p) => !requested.length || requested.includes(p));
  const link =
    kind === "reconnect"
      ? { connect_url: MANAGE_USERS_URL, signed: false }
      : await resolveConnectLink(client, { profile: requestedProfile, platforms });
  const lead =
    kind === "reconnect"
      ? `The ${humanList(platforms.length ? platforms : ["social"])} connection has expired and must be reconnected; nothing was published to it.`
      : `${humanList(platforms.length ? platforms : ["The requested platform"])} ${platforms.length > 1 ? "are" : "is"} not connected to profile "${requestedProfile ?? ""}", so nothing was published there.`;
  const text = `${lead} ${connectInstruction(link, platforms.length ? platforms : undefined)}`;
  return { text, structured: { error: message, next_step: text, ...link } };
}

/**
 * Uploads that partly succeed report the unconnected platforms as skipped
 * (`skip_reason: profile_platform_not_configured`) inside a success response.
 */
export function skippedUnconnectedPlatforms(result: unknown): string[] {
  const out = new Set<string>();
  const visit = (node: unknown, key: string | undefined, depth: number): void => {
    if (!node || typeof node !== "object" || depth > 4) return;
    const rec = node as Record<string, unknown>;
    if (rec.skip_reason === "profile_platform_not_configured") {
      const platform = typeof rec.platform === "string" ? rec.platform : key;
      if (platform) out.add(normalizePlatform(platform));
      return;
    }
    for (const [k, v] of Object.entries(rec)) visit(v, k, depth + 1);
  };
  visit(result, undefined, 0);
  return [...out];
}

/**
 * `safe()` for publishing tools: same envelope, but connection problems come
 * back with a link and the sentence to relay instead of a bare API error.
 */
export function safeUpload<TArgs>(
  client: UploadPostMcpClient,
  handler: (args: TArgs) => Promise<unknown>
): (args: TArgs) => Promise<ToolResult> {
  return async (args) => {
    let result: unknown;
    try {
      result = await handler(args);
    } catch (err) {
      const message = err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
      const guidance = await uploadErrorGuidance(client, message, (args ?? {}) as { user?: unknown; platforms?: unknown });
      if (!guidance) return fail(err);
      return {
        isError: true,
        content: [{ type: "text", text: `${message}\n\n${guidance.text}` }],
        structuredContent: { result: guidance.structured },
      };
    }

    const skipped = skippedUnconnectedPlatforms(result);
    if (skipped.length && result && typeof result === "object" && !Array.isArray(result)) {
      const user = (args as { user?: unknown } | undefined)?.user;
      const link = await resolveConnectLink(client, {
        profile: typeof user === "string" ? user : undefined,
        platforms: skipped,
      });
      const next_step =
        `${humanList(skipped)} ${skipped.length > 1 ? "were" : "was"} skipped because ${skipped.length > 1 ? "they are" : "it is"} not connected to this profile; the other platforms went ahead. ` +
        connectInstruction(link, skipped);
      return ok({ ...(result as Record<string, unknown>), next_step, ...link });
    }
    return ok(result);
  };
}
