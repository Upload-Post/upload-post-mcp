import { createHash } from "node:crypto";
import type { IntrospectResult } from "./upstream_client.js";

/**
 * Tiny in-process TTL cache for introspection results. Avoids round-tripping
 * upstream on every /mcp request. Keyed by SHA-256(token) so plaintext tokens
 * are never held in memory beyond the request that issued the lookup.
 *
 * No LRU bound by count: entries expire on TTL and are evicted lazily on read.
 * If you anticipate >10k concurrent active tokens, swap this for `lru-cache`.
 */
export class IntrospectCache {
  private store = new Map<string, { value: IntrospectResult; expiresAt: number }>();

  constructor(private readonly ttlMs: number) {}

  get(token: string): IntrospectResult | null {
    const key = this.keyFor(token);
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  set(token: string, value: IntrospectResult): void {
    this.store.set(this.keyFor(token), {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  invalidate(token: string): void {
    this.store.delete(this.keyFor(token));
  }

  private keyFor(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }
}
