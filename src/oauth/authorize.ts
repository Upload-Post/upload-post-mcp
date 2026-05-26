import type { IncomingMessage, ServerResponse } from "node:http";
import type { OAuthConfig } from "./config.js";
import { sendError, sendRedirect } from "./http_utils.js";

/**
 * GET /authorize
 *
 * Pure redirect to the dashboard's consent page (app.upload-post.com/oauth/authorize),
 * carrying all OAuth params verbatim. The dashboard is where the user actually logs
 * in (if needed) and approves — it then calls back to the Upload-Post
 * backend to mint an authorization code, and finally redirects the user
 * agent to the client-provided `redirect_uri` with the code.
 *
 * Doing it as a 302 (instead of rendering the consent screen here) means:
 *   - the user's existing app.upload-post.com session cookie/JWT is reachable
 *   - we don't duplicate login UI in this Node server
 *   - the MCP server stays purely API-shaped
 */
export function handleAuthorize(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: OAuthConfig
): void {
  if (!req.url) return sendError(res, 400, "invalid_request", "Missing URL");
  const incoming = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const target = new URL(cfg.dashboardAuthorizeUrl);
  // Forward all incoming query params (response_type, client_id, redirect_uri,
  // state, scope, code_challenge, code_challenge_method, ...).
  incoming.searchParams.forEach((value, key) => target.searchParams.set(key, value));
  sendRedirect(res, target.toString());
}
