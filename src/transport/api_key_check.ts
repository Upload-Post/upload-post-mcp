import { createHash } from "node:crypto";
import { fetchUpstream, UpstreamUnavailableError } from "../oauth/upstream_client.js";

/**
 * Verifies a raw Upload-Post API key once, before a session is built for it.
 *
 * Without this, any string in `Authorization: ApiKey ...` got a full session
 * (server + tools), and the first tool call was the first time anyone looked
 * at the key. Sessions are capped, so unverified sessions could push out real
 * ones. The check is the documented `GET /uploadposts/me` endpoint, the same
 * one integrations use as a key health check, and its answer is cached.
 *
 * Results:
 *   - "valid"        the API accepted the key
 *   - "invalid"      the API rejected it (401)
 *   - "rate_limited" the API answered 429 for this key; the caller should
 *                    tell the client to retry rather than call it invalid
 * Throws UpstreamUnavailableError when the API cannot answer (network, 5xx),
 * so an outage is never reported as a bad key.
 */
export type KeyCheckResult = "valid" | "invalid" | "rate_limited";

export interface ApiKeyCheckerOptions {
  baseUrl: string;
  /** How long an accepted key is trusted before it is checked again. */
  validTtlMs?: number;
  /** How long a rejected key is remembered, so retries don't hit the API. */
  invalidTtlMs?: number;
  /** Upper bound on cached entries; oldest are dropped first. */
  maxEntries?: number;
}

export function keyFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

export class ApiKeyChecker {
  private readonly baseUrl: string;
  private readonly validTtlMs: number;
  private readonly invalidTtlMs: number;
  private readonly maxEntries: number;
  private readonly cache = new Map<string, { result: "valid" | "invalid"; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<KeyCheckResult>>();

  constructor(opts: ApiKeyCheckerOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.validTtlMs = opts.validTtlMs ?? 10 * 60 * 1000;
    this.invalidTtlMs = opts.invalidTtlMs ?? 60 * 1000;
    this.maxEntries = opts.maxEntries ?? 10_000;
  }

  async check(apiKey: string): Promise<KeyCheckResult> {
    const fp = keyFingerprint(apiKey);
    const cached = this.cache.get(fp);
    if (cached && cached.expiresAt > Date.now()) return cached.result;
    if (cached) this.cache.delete(fp);

    // Concurrent sessions for the same key share one lookup.
    const pending = this.inFlight.get(fp);
    if (pending) return pending;
    const lookup = this.lookup(apiKey, fp).finally(() => this.inFlight.delete(fp));
    this.inFlight.set(fp, lookup);
    return lookup;
  }

  /** Drop expired entries (called from the periodic sweep). */
  purgeExpired(): void {
    const now = Date.now();
    for (const [fp, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(fp);
    }
  }

  private async lookup(apiKey: string, fp: string): Promise<KeyCheckResult> {
    const r = await fetchUpstream(
      `${this.baseUrl}/uploadposts/me`,
      { method: "GET", headers: { Authorization: `Apikey ${apiKey}` } },
      "key check"
    );
    // Body is not needed; release the connection.
    await r.body?.cancel().catch(() => undefined);
    if (r.status === 429) return "rate_limited";
    if (r.status >= 500) throw new UpstreamUnavailableError(`key check: HTTP ${r.status}`);
    if (r.status === 401) {
      this.remember(fp, "invalid", this.invalidTtlMs);
      return "invalid";
    }
    // 2xx, or a 4xx that is about the account rather than the key (e.g. a
    // suspended account, or a self-hosted backend without this endpoint): let
    // the session through so tool calls surface the API's own message.
    this.remember(fp, "valid", this.validTtlMs);
    return "valid";
  }

  private remember(fp: string, result: "valid" | "invalid", ttlMs: number): void {
    this.cache.delete(fp);
    this.cache.set(fp, { result, expiresAt: Date.now() + ttlMs });
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
