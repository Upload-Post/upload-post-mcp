import type { IncomingMessage, ServerResponse } from "node:http";
import type { UpstreamOAuthClient } from "./upstream_client.js";
import type { IntrospectCache } from "./introspect_cache.js";
import { readFormBody, sendError, sendJson } from "./http_utils.js";

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

  const params = new URLSearchParams(form);
  const response = await upstream.exchangeOrRefresh(params);
  res.statusCode = response.status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(response.body);
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
