import type { OAuthConfig } from "./config.js";

/**
 * The Upload-Post backend could not be reached, timed out, or answered 5xx.
 * Distinct from "the token is invalid": callers turn it into a 503 so clients
 * retry instead of discarding credentials (support ticket 5177).
 */
export class UpstreamUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamUnavailableError";
  }
}

const UPSTREAM_TIMEOUT_MS = Number(process.env.UPLOAD_POST_MCP_UPSTREAM_TIMEOUT_MS ?? 10_000);
const UPSTREAM_CONNECT_RETRIES = 2;

// Failures that happen before the connection is established, so the request
// never reached the backend and retrying cannot apply it twice. A reset or a
// timeout after sending is ambiguous (a refresh may already have rotated the
// token) and is never retried.
const PRE_CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function causeOf(err: unknown): { code?: string; message: string } {
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  return {
    code: cause?.code,
    message: cause?.message ?? (err as Error)?.message ?? String(err),
  };
}

/**
 * fetch with a timeout and a retry for connection failures only. Throws
 * UpstreamUnavailableError when the backend cannot be reached, and logs the
 * underlying cause: the bare "fetch failed" it used to leave behind told us
 * nothing about why.
 */
async function fetchUpstream(url: string, init: RequestInit, label: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    } catch (err) {
      const cause = causeOf(err);
      const retry = attempt < UPSTREAM_CONNECT_RETRIES && !!cause.code && PRE_CONNECT_CODES.has(cause.code);
      process.stderr.write(
        `[upload-post-mcp] upstream ${label} failed (attempt ${attempt + 1}, ` +
          `${cause.code ?? "no code"}: ${cause.message})${retry ? ", retrying" : ""}\n`
      );
      if (!retry) throw new UpstreamUnavailableError(`${label}: ${cause.code ?? cause.message}`);
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
}

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
    const r = await fetchUpstream(
      `${this.cfg.upstreamBaseUrl}/api/uploadposts/oauth/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      },
      "token"
    );
    // A proxy 5xx (HTML error page) is not an OAuth answer; report it as the
    // outage it is instead of relaying markup under a JSON content type.
    if (r.status >= 500) throw new UpstreamUnavailableError(`token: HTTP ${r.status}`);
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
   * Authenticated upstream with the shared internal secret. Returns null when
   * the token is inactive or unknown; throws UpstreamUnavailableError when the
   * backend cannot answer, so a network blip is not reported as a bad token.
   */
  async introspect(accessToken: string): Promise<IntrospectResult | null> {
    const r = await fetchUpstream(
      `${this.cfg.upstreamBaseUrl}/api/uploadposts/oauth/introspect`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-secret": this.cfg.internalSecret,
        },
        body: JSON.stringify({ token: accessToken }),
      },
      "introspect"
    );
    if (r.status >= 500) throw new UpstreamUnavailableError(`introspect: HTTP ${r.status}`);
    if (!r.ok) return null;
    let data: Partial<IntrospectResult> & { active?: boolean };
    try {
      data = (await r.json()) as Partial<IntrospectResult> & { active?: boolean };
    } catch {
      throw new UpstreamUnavailableError("introspect: unreadable response");
    }
    if (!data.active || !data.api_key || !data.email) return null;
    return {
      active: true,
      email: data.email,
      api_key: data.api_key,
      scope: data.scope ?? "mcp.full",
      client_id: data.client_id,
    };
  }
}

export interface IntrospectResult {
  active: true;
  email: string;
  api_key: string;
  scope: string;
  client_id?: string;
}
