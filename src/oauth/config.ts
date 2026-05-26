/**
 * OAuth configuration. Read once at startup from env vars.
 *
 * Required for OAuth to work:
 *   OAUTH_ISSUER                  = https://mcp.upload-post.com
 *   OAUTH_DASHBOARD_AUTHORIZE_URL = https://app.upload-post.com/oauth/authorize
 *   OAUTH_UPSTREAM_BASE_URL       = https://api.upload-post.com (or staging equivalent)
 *   OAUTH_INTERNAL_SECRET         = shared secret with the Upload-Post backend
 */

export interface OAuthConfig {
  enabled: boolean;
  issuer: string;
  dashboardAuthorizeUrl: string;
  upstreamBaseUrl: string;
  internalSecret: string;
  introspectCacheTtlMs: number;
}

export function loadOAuthConfig(): OAuthConfig {
  const issuer = (process.env.OAUTH_ISSUER ?? "").replace(/\/$/, "");
  const dashboardAuthorizeUrl = process.env.OAUTH_DASHBOARD_AUTHORIZE_URL ?? "";
  const upstreamBaseUrl = (process.env.OAUTH_UPSTREAM_BASE_URL ?? "").replace(/\/$/, "");
  const internalSecret = process.env.OAUTH_INTERNAL_SECRET ?? "";
  const enabled =
    issuer.length > 0 &&
    dashboardAuthorizeUrl.length > 0 &&
    upstreamBaseUrl.length > 0 &&
    internalSecret.length > 0;
  return {
    enabled,
    issuer,
    dashboardAuthorizeUrl,
    upstreamBaseUrl,
    internalSecret,
    introspectCacheTtlMs: Number(process.env.OAUTH_INTROSPECT_CACHE_MS ?? 60_000),
  };
}
