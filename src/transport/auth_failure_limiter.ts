import type { IncomingMessage } from "node:http";

/**
 * Slows down a source that keeps getting 401s on /mcp.
 *
 * A client stuck in a retry loop with a missing or dead credential can send a
 * request every couple of seconds for hours, and nothing told it to stop: a
 * 401 is answered immediately and most clients retry it at once. The same
 * shape also covers someone trying keys one after another, where every new
 * key costs a lookup against the Upload-Post API.
 *
 * Per source (client IP), failures are counted in a window. Past `maxFailures`
 * the source is "held": it is answered 429 + Retry-After instead of being
 * looked at, except for one probe every `probeIntervalMs`, which goes through
 * the normal path. The probe keeps the source usable for anyone else behind
 * the same IP (NAT, VPN egress, hosted agent platforms): a valid credential
 * gets in on the next probe, and a session or key already verified is never
 * held at all (the caller decides that before asking). A failed probe extends
 * the hold, so a client that never fixes itself stays slowed down; the hold
 * lifts `windowMs` after the last failure.
 */
export interface AuthFailureLimiterOptions {
  /** Failures allowed per window before the source is held. 0 disables. */
  maxFailures?: number;
  windowMs?: number;
  /** While held, one request per this interval is let through. */
  probeIntervalMs?: number;
  /** Upper bound on tracked sources; oldest are dropped first. */
  maxEntries?: number;
}

interface Entry {
  failures: number;
  resetAt: number;
  lastProbeAt: number;
}

export class AuthFailureLimiter {
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly probeIntervalMs: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, Entry>();

  constructor(opts: AuthFailureLimiterOptions = {}) {
    this.maxFailures = opts.maxFailures ?? 20;
    this.windowMs = opts.windowMs ?? 5 * 60 * 1000;
    this.probeIntervalMs = opts.probeIntervalMs ?? 30 * 1000;
    this.maxEntries = opts.maxEntries ?? 50_000;
  }

  get enabled(): boolean {
    return this.maxFailures > 0;
  }

  /**
   * 0 when the request may go through (the source is not held, or this is
   * its probe); otherwise the seconds to put in Retry-After.
   */
  admit(source: string, now = Date.now()): number {
    if (!this.enabled) return 0;
    const e = this.entries.get(source);
    if (!e || e.resetAt <= now || e.failures < this.maxFailures) return 0;
    const nextProbe = e.lastProbeAt + this.probeIntervalMs;
    if (now >= nextProbe) {
      e.lastProbeAt = now;
      return 0;
    }
    return Math.max(1, Math.ceil((nextProbe - now) / 1000));
  }

  /** Record a 401. Returns true when this failure starts a hold. */
  fail(source: string, now = Date.now()): boolean {
    if (!this.enabled) return false;
    let e = this.entries.get(source);
    if (!e || e.resetAt <= now) {
      e = { failures: 0, resetAt: 0, lastProbeAt: 0 };
    }
    // Re-insert so Map order tracks recency for the size bound.
    this.entries.delete(source);
    this.entries.set(source, e);
    e.failures++;
    e.resetAt = now + this.windowMs;
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    if (e.failures === this.maxFailures) {
      // The request that hit the limit counts as the first probe.
      e.lastProbeAt = now;
      return true;
    }
    return false;
  }

  /** Drop expired entries (called from the periodic sweep). */
  purgeExpired(now = Date.now()): void {
    for (const [source, e] of this.entries) {
      if (e.resetAt <= now) this.entries.delete(source);
    }
  }
}

const PRIVATE_PEER =
  /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|::ffff:(127|10|192\.168|172\.(1[6-9]|2\d|3[01]))\.)/i;

/**
 * The address to count failures against. Behind a reverse proxy every request
 * arrives from the proxy, so the client is the last X-Forwarded-For hop the
 * proxy appended. That header is only believed when the peer is on a private
 * network (`trustProxy` "auto", the default) or always ("true"); with "false",
 * or when exposed directly, a client could otherwise pick its own identity.
 */
export function clientAddress(req: IncomingMessage, trustProxy: string): string {
  const peer = req.socket.remoteAddress ?? "unknown";
  const trust = trustProxy === "true" || (trustProxy !== "false" && PRIVATE_PEER.test(peer));
  if (!trust) return peer;
  const xff = req.headers["x-forwarded-for"];
  const raw = Array.isArray(xff) ? xff.join(",") : xff;
  if (!raw) return peer;
  const hops = raw.split(",").map((h) => h.trim()).filter(Boolean);
  return hops[hops.length - 1] ?? peer;
}
