import type { OAuthConfig } from "./config.js";
import type { UpstreamOAuthClient } from "./upstream_client.js";
import type { IntrospectCache } from "./introspect_cache.js";

/**
 * The /mcp endpoint accepts THREE Authorization header shapes:
 *
 *   1. `Authorization: ApiKey <raw_upload_post_api_key>` — historical, used by
 *      Claude Desktop / Code / Cursor with mcp.json. Returns the key verbatim.
 *
 *   2. `Authorization: Bearer up_oauth_<...>` — OAuth access token issued via
 *      DCR + authorization-code+PKCE. Introspected against the Upload-Post
 *      backend (cached ~60s) to recover the underlying API key.
 *
 *   3. `Authorization: Bearer <raw_upload_post_api_key>` — historical fallback
 *      for clients that only allow Bearer. Returns the key verbatim.
 *
 * Any of these end with the same shape: `{ apiKey, source }`. The session-
 * scoped UploadPostMcpClient is then built with that key. Existing clients
 * see zero behavior change.
 */

export type AuthResolution =
  | { apiKey: string; source: "apikey" | "bearer_raw" | "oauth"; email?: string; clientId?: string }
  | null;

const OAUTH_ACCESS_PREFIX = "up_oauth_";

export interface AuthResolverDeps {
  cfg: OAuthConfig;
  upstream: UpstreamOAuthClient;
  cache: IntrospectCache;
}

export async function resolveAuth(
  header: string | string[] | undefined,
  deps: AuthResolverDeps
): Promise<AuthResolution> {
  if (!header || Array.isArray(header)) return null;
  const match = header.match(/^(ApiKey|Bearer)\s+(.+)$/i);
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  const token = match[2].trim();
  if (!token) return null;

  if (scheme === "apikey") {
    return { apiKey: token, source: "apikey" };
  }

  // scheme === "bearer"
  if (!token.startsWith(OAUTH_ACCESS_PREFIX) || !deps.cfg.enabled) {
    return { apiKey: token, source: "bearer_raw" };
  }

  // OAuth opaque access token — introspect (with cache).
  const cached = deps.cache.get(token);
  if (cached) {
    return { apiKey: cached.api_key, source: "oauth", email: cached.email, clientId: cached.client_id };
  }
  const fresh = await deps.upstream.introspect(token);
  if (!fresh) return null;
  deps.cache.set(token, fresh);
  return { apiKey: fresh.api_key, source: "oauth", email: fresh.email, clientId: fresh.client_id };
}
