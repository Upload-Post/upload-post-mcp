import type { ServerResponse } from "node:http";
import type { OAuthConfig } from "./config.js";

/**
 * RFC 9728 — OAuth 2.0 Protected Resource Metadata.
 * claude.ai (and other MCP-spec clients) fetch this when they hit /mcp and
 * receive a 401 with WWW-Authenticate pointing here. From it they learn which
 * authorization servers can issue tokens for this resource.
 */
export function protectedResourceMetadata(cfg: OAuthConfig) {
  return {
    resource: `${cfg.issuer}/mcp`,
    authorization_servers: [cfg.issuer],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://docs.upload-post.com/guides/mcp-server-integration",
    scopes_supported: ["mcp.full"],
  };
}

/**
 * RFC 8414 — OAuth 2.0 Authorization Server Metadata.
 * Claude.ai uses this to discover where to register, where to send the user
 * for authorization, and where to exchange codes for tokens.
 */
export function authorizationServerMetadata(cfg: OAuthConfig) {
  return {
    issuer: cfg.issuer,
    authorization_endpoint: `${cfg.issuer}/authorize`,
    token_endpoint: `${cfg.issuer}/token`,
    revocation_endpoint: `${cfg.issuer}/revoke`,
    registration_endpoint: `${cfg.issuer}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["mcp.full"],
    service_documentation: "https://docs.upload-post.com/guides/mcp-server-integration",
  };
}

export function serveJson(res: ServerResponse, body: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "public, max-age=3600");
  res.setHeader("access-control-allow-origin", "*");
  res.end(JSON.stringify(body));
}
