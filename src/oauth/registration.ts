import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

import { readJsonBody, sendJson, sendError } from "./http_utils.js";

/**
 * RFC 7591 — Dynamic Client Registration.
 *
 * Stateless: we don't persist registered clients. PKCE + the redirect_uri
 * allow-list (enforced server-side on token exchange) cover the security
 * properties that registration would otherwise provide. So /register just
 * mints a fresh client_id and echoes back the metadata.
 *
 * This is the pragmatic pattern used by most public-client MCP servers — the
 * spec explicitly allows it (§3.2.1 "client_secret is OPTIONAL").
 */
export async function handleRegistration(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown> = {};
  try {
    body = (await readJsonBody(req)) ?? {};
  } catch {
    return sendError(res, 400, "invalid_request", "Body must be valid JSON");
  }

  const clientName = typeof body.client_name === "string" ? body.client_name : "MCP Client";
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (redirectUris.length === 0) {
    return sendError(res, 400, "invalid_redirect_uri", "At least one redirect_uri is required");
  }

  const clientId = `mcp_${randomBytes(16).toString("hex")}`;
  const issuedAt = Math.floor(Date.now() / 1000);

  sendJson(res, 201, {
    client_id: clientId,
    client_id_issued_at: issuedAt,
    client_name: clientName,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: "mcp.full",
  });
}
