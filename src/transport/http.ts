import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { UploadPostMcpClient } from "../client.js";

import { loadOAuthConfig } from "../oauth/config.js";
import {
  authorizationServerMetadata,
  protectedResourceMetadata,
  serveJson,
} from "../oauth/metadata.js";
import { handleRegistration } from "../oauth/registration.js";
import { handleAuthorize } from "../oauth/authorize.js";
import { handleToken, handleRevoke } from "../oauth/tokens.js";
import { UpstreamOAuthClient } from "../oauth/upstream_client.js";
import { IntrospectCache } from "../oauth/introspect_cache.js";
import { resolveAuth } from "../oauth/auth_resolver.js";

export interface HttpOptions {
  port: number;
  /** Optional override for upstream Upload-Post base URL. */
  baseUrl?: string;
  /**
   * Factory that turns a freshly-built per-session `UploadPostMcpClient` into
   * an `McpServer` with the tools registered. Injected so transport stays
   * unaware of which tools exist.
   */
  buildServer: (client: UploadPostMcpClient) => McpServer;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

/**
 * Multi-tenant streamable-HTTP host.
 *
 * Each MCP session owns:
 *   - one Upload-Post API key (either pasted directly via `Authorization:
 *     ApiKey/Bearer <key>`, or resolved from an OAuth `Bearer up_oauth_...`
 *     access token via upstream introspection),
 *   - one `UploadPostMcpClient` bound to that key,
 *   - one `McpServer` with tools that close over that client.
 *
 * Subsequent requests on the same session route to the same transport via the
 * `mcp-session-id` header. Closing the transport drops the session from the
 * map so the per-user state can be GC'd.
 *
 * The server itself stores nothing permanently — keys live only inside the
 * in-memory client of the session that received them. The OAuth introspection
 * cache is a TTL'd lookup table keyed by SHA-256(token), not raw plaintexts.
 */
export async function runHttp(opts: HttpOptions): Promise<void> {
  const sessions = new Map<string, Session>();

  const oauthCfg = loadOAuthConfig();
  const upstream = new UpstreamOAuthClient(oauthCfg);
  const introspectCache = new IntrospectCache(oauthCfg.introspectCacheTtlMs);
  const authDeps = { cfg: oauthCfg, upstream, cache: introspectCache };

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    const method = req.method ?? "GET";

    // ----- Defense-in-depth: Origin validation --------------------------
    // The MCP spec recommends rejecting requests whose `Origin` header (when
    // present) is not on a known allow-list, to prevent DNS-rebinding attacks
    // against agents that connect from a browser. Server-to-server callers
    // (claude.ai backend, curl, etc.) typically omit the header — those pass
    // through unchanged. Bearer/ApiKey auth on /mcp remains the primary gate.
    if (!isOriginAllowed(req.headers["origin"])) {
      res.statusCode = 403;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "origin_not_allowed" }));
      return;
    }

    // ----- Liveness ------------------------------------------------------
    if (method === "GET" && (url === "/healthz" || url === "/health")) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, oauth: oauthCfg.enabled }));
      return;
    }

    // ----- OAuth surface (only if configured) ----------------------------
    if (oauthCfg.enabled) {
      if (method === "GET" && url === "/.well-known/oauth-protected-resource") {
        return serveJson(res, protectedResourceMetadata(oauthCfg));
      }
      if (method === "GET" && url === "/.well-known/oauth-authorization-server") {
        return serveJson(res, authorizationServerMetadata(oauthCfg));
      }
      if (method === "POST" && url === "/register") {
        return handleRegistration(req, res);
      }
      if (method === "GET" && url.startsWith("/authorize")) {
        return handleAuthorize(req, res, oauthCfg);
      }
      if (method === "POST" && url === "/token") {
        return handleToken(req, res, upstream);
      }
      if (method === "POST" && url === "/revoke") {
        return handleRevoke(req, res, upstream, introspectCache);
      }
    }

    // ----- MCP -----------------------------------------------------------
    if (url !== "/mcp") {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let session = sessionId ? sessions.get(sessionId) : undefined;

    if (!session) {
      const resolution = await resolveAuth(req.headers["authorization"], authDeps);
      if (!resolution) {
        return sendUnauthorized(res, oauthCfg.enabled, oauthCfg.issuer);
      }

      const client = new UploadPostMcpClient({ apiKey: resolution.apiKey, baseUrl: opts.baseUrl });
      const server = opts.buildServer(client);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      session = { transport, server };
    }

    let body: unknown = undefined;
    if (method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length) {
        try {
          body = JSON.parse(raw);
        } catch {
          res.statusCode = 400;
          res.end("Invalid JSON");
          return;
        }
      }
    }

    await session.transport.handleRequest(req, res, body);
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(opts.port, () => {
      process.stderr.write(
        `[upload-post-mcp] streamable HTTP listening on http://0.0.0.0:${opts.port}/mcp ` +
          `(auth: ApiKey/Bearer header${oauthCfg.enabled ? " + OAuth 2.1 (PKCE+DCR)" : ""})\n`
      );
      resolve();
    });
  });
}

/**
 * 401 with both a legacy `ApiKey` challenge and (when OAuth is enabled) the
 * `Bearer resource_metadata=...` challenge that claude.ai needs to discover
 * the authorization server. Sending BOTH keeps the existing API-key flow
 * working and unlocks the OAuth Custom-Connector flow on the same endpoint.
 */
function sendUnauthorized(res: ServerResponse, oauthEnabled: boolean, issuer: string): void {
  const challenges: string[] = [];
  if (oauthEnabled) {
    challenges.push(
      `Bearer realm="upload-post", resource_metadata="${issuer}/.well-known/oauth-protected-resource"`
    );
  }
  challenges.push('ApiKey realm="upload-post"');
  res.statusCode = 401;
  res.setHeader("www-authenticate", challenges.join(", "));
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      error:
        "Missing or malformed Authorization header. Send 'Authorization: ApiKey <your_upload_post_api_key>' (or 'Bearer <key>'). Get your key at https://app.upload-post.com" +
        (oauthEnabled
          ? " — or connect via OAuth from a Custom Connector–capable client (e.g. claude.ai)."
          : ""),
    })
  );
}

/**
 * Allow-list of Origins permitted to call this server from a browser context.
 * Augmented via the OAUTH_EXTRA_ALLOWED_ORIGINS env var (comma-separated)
 * for self-hosters that front the server with their own dashboard origin.
 *
 * Requests WITHOUT an Origin header (server-to-server: claude.ai backend,
 * curl, MCP stdio bridges, etc.) are allowed through — Origin only ships
 * from browsers, where the DNS-rebinding risk lives.
 */
function isOriginAllowed(origin: string | string[] | undefined): boolean {
  if (!origin || Array.isArray(origin)) return true;
  const value = origin.trim();
  if (!value) return true;
  const defaults = new Set([
    "https://claude.ai",
    "https://claude.com",
    "https://www.claude.ai",
    "https://app.upload-post.com",
    "http://localhost",
    "http://127.0.0.1",
  ]);
  for (const extra of (process.env.OAUTH_EXTRA_ALLOWED_ORIGINS ?? "").split(",")) {
    const trimmed = extra.trim();
    if (trimmed) defaults.add(trimmed);
  }
  if (defaults.has(value)) return true;
  // Allow any localhost / 127.0.0.1 port combination for local dev.
  try {
    const url = new URL(value);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return true;
  } catch {
    return false;
  }
  return false;
}
