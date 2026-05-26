import type { OAuthConfig } from "./config.js";

/**
 * Thin wrapper around the Upload-Post backend's internal OAuth endpoints.
 * The MCP server never touches a database — all OAuth state lives upstream.
 * This keeps schema ownership in one place and means the MCP container
 * doesn't need DB credentials.
 */
export class UpstreamOAuthClient {
  constructor(private readonly cfg: OAuthConfig) {}

  /** Proxies form data through to /api/uploadposts/oauth/token. */
  async exchangeOrRefresh(form: URLSearchParams): Promise<{ status: number; body: string }> {
    const r = await fetch(`${this.cfg.upstreamBaseUrl}/api/uploadposts/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    return { status: r.status, body: await r.text() };
  }

  /** Proxies token revocation. */
  async revoke(token: string): Promise<void> {
    await fetch(`${this.cfg.upstreamBaseUrl}/api/uploadposts/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    }).catch(() => undefined);
  }

  /**
   * Resolves an opaque access token to {email, api_key, scope, client_id}.
   * Authenticated upstream with the shared internal secret. Returns null on
   * inactive / unknown / network failure.
   */
  async introspect(accessToken: string): Promise<IntrospectResult | null> {
    try {
      const r = await fetch(`${this.cfg.upstreamBaseUrl}/api/uploadposts/oauth/introspect`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-secret": this.cfg.internalSecret,
        },
        body: JSON.stringify({ token: accessToken }),
      });
      if (!r.ok) return null;
      const data = (await r.json()) as Partial<IntrospectResult> & { active?: boolean };
      if (!data.active || !data.api_key || !data.email) return null;
      return {
        active: true,
        email: data.email,
        api_key: data.api_key,
        scope: data.scope ?? "mcp.full",
        client_id: data.client_id,
      };
    } catch {
      return null;
    }
  }
}

export interface IntrospectResult {
  active: true;
  email: string;
  api_key: string;
  scope: string;
  client_id?: string;
}
