import type { IncomingMessage, ServerResponse } from "node:http";
import { UpstreamUnavailableError, type UpstreamOAuthClient } from "./upstream_client.js";
import type { IntrospectCache } from "./introspect_cache.js";
import { readFormBody, sendError, sendJson, sendUpstreamUnavailable } from "./http_utils.js";

/**
 * POST /token — RFC 6749 §4.1.3 + §6 (refresh). Public client (PKCE), so no
 * client_secret. We forward to the Upload-Post backend which owns the
 * codes/tokens; this server just translates the wire format.
 */
export async function handleToken(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: UpstreamOAuthClient
): Promise<void> {
  let form: Record<string, string>;
  try {
    form = await readFormBody(req);
  } catch {
    return sendError(res, 400, "invalid_request", "Body must be form-urlencoded");
  }

  if (!form.grant_type) return sendError(res, 400, "invalid_request", "grant_type required");

  // Clients may send their credentials as HTTP Basic instead (RFC 6749
  // §2.3.1). This is a public client (PKCE), so only the client_id is used.
  if (!form.client_id) {
    const basicClientId = clientIdFromBasic(req.headers["authorization"]);
    if (basicClientId) form.client_id = basicClientId;
  }

  const params = new URLSearchParams(form);
  let response: { status: number; body: string };
  try {
    response = await upstream.exchangeOrRefresh(params);
  } catch (err) {
    if (err instanceof UpstreamUnavailableError) return sendUpstreamUnavailable(res);
    throw err;
  }
  res.statusCode = response.status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(response.body);
}

/** The client_id of an `Authorization: Basic` header (RFC 6749 §2.3.1), if any. */
function clientIdFromBasic(header: string | undefined): string | undefined {
  const match = header?.match(/^Basic\s+([A-Za-z0-9+/]+=*)\s*$/i);
  if (!match) return undefined;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon <= 0) return undefined;
  try {
    return decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, " ")).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * POST /revoke — RFC 7009. We also drop the cache so any cached entry for
 * this token is killed immediately even if other instances re-introspect.
 */
export async function handleRevoke(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: UpstreamOAuthClient,
  cache: IntrospectCache
): Promise<void> {
  let form: Record<string, string>;
  try {
    form = await readFormBody(req);
  } catch {
    return sendError(res, 400, "invalid_request", "Body must be form-urlencoded");
  }
  const token = (form.token ?? "").trim();
  if (token) {
    cache.invalidate(token);
    await upstream.revoke(token);
  }
  sendJson(res, 200, { success: true });
}
