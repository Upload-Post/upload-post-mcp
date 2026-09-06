import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ClientInfoLike } from "../client_profile.js";
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
import { stripSchemaDialect } from "./schema_dialect.js";

export interface HttpOptions {
  port: number;
  /** Optional override for upstream Upload-Post base URL. */
  baseUrl?: string;
  /**
   * Factory that turns a freshly-built per-session `UploadPostMcpClient` into
   * an `McpServer` with the tools registered. Injected so transport stays
   * unaware of which tools exist.
   */
  buildServer: (client: UploadPostMcpClient, clientInfo?: ClientInfoLike) => McpServer;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastSeenAt: number;
}

// Most MCP clients never send the DELETE that ends a session — they just
// abandon it. Without eviction every abandoned session pins a full McpServer
// (tools + zod schemas + axios client) forever, which is exactly the leak that
// OOM-crashed this server daily in production. Idle sessions past the TTL are
// swept; the cap is a backstop against bursts between sweeps.
const SESSION_IDLE_TTL_MS = Number(
  process.env.UPLOAD_POST_MCP_SESSION_TTL_MS ?? 30 * 60 * 1000
);
const SESSION_SWEEP_INTERVAL_MS = 60 * 1000;
const MAX_SESSIONS = Number(process.env.UPLOAD_POST_MCP_MAX_SESSIONS ?? 2000);

const OPENAI_APPS_CHALLENGE_PATH = "/.well-known/openai-apps-challenge";

// Glama directory ownership verification. Glama claims a connector by fetching
// /.well-known/glama.json from the server's domain and matching a maintainer
// email. Override the email via GLAMA_MAINTAINER_EMAIL if needed.
const GLAMA_WELL_KNOWN_PATH = "/.well-known/glama.json";
const GLAMA_MAINTAINER_EMAIL = process.env.GLAMA_MAINTAINER_EMAIL ?? "jc.caverogracia@gmail.com";
const DEFAULT_OPENAI_APPS_CHALLENGE_TOKEN = "9O0B9c5XudnvLv1et2HdZ9WG2_H85jGPciJ7c8QBHjY";

// Icon paths clients probe on the bare origin, mapped to the canonical assets
// on the marketing site. Keep in sync with upload-post-landing/public.
const FAVICON_REDIRECTS: Record<string, string> = {
  "/favicon.ico": "https://www.upload-post.com/favicon.ico",
  "/favicon-16.png": "https://www.upload-post.com/favicon-16.png",
  "/favicon-32.png": "https://www.upload-post.com/favicon-32.png",
  "/favicon-48.png": "https://www.upload-post.com/favicon-48.png",
  "/favicon-192.png": "https://www.upload-post.com/favicon-192.png",
  "/favicon-512.png": "https://www.upload-post.com/favicon-512.png",
  "/apple-touch-icon.png": "https://www.upload-post.com/apple-touch-icon.png",
  "/apple-touch-icon-precomposed.png": "https://www.upload-post.com/apple-touch-icon.png",
};

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

  // ----- Last-resort process guards -----------------------------------------
  // A single request-scoped throw/rejection (transient upstream error, a client
  // that aborts mid-body, an SDK edge case) must never take the whole
  // multi-tenant server down. Node's default on an unhandled rejection /
  // uncaught exception is to terminate the process; we log and keep serving.
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(
      `[upload-post-mcp] unhandledRejection: ${(reason as Error)?.stack ?? reason}\n`
    );
  });
  process.on("uncaughtException", (err) => {
    process.stderr.write(
      `[upload-post-mcp] uncaughtException: ${err?.stack ?? err}\n`
    );
  });

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
   try {
    const url = req.url ?? "";
    const method = req.method ?? "GET";

    // ----- ChatGPT Apps domain verification -----------------------------
    // This must be reachable publicly before Origin validation because the
    // OpenAI verifier may include its own browser/developer-console Origin.
    if (isOpenAiAppsChallengePath(url)) {
      if (method === "OPTIONS") {
        return sendOpenAiAppsChallengeOptions(res);
      }
      if (method === "GET" || method === "HEAD") {
        return sendOpenAiAppsChallenge(res, method);
      }
      res.statusCode = 405;
      res.setHeader("allow", "GET, HEAD, OPTIONS");
      res.end("Method Not Allowed");
      return;
    }

    // ----- Glama directory ownership verification -----------------------
    // Served publicly (before Origin validation) so Glama's verifier can fetch
    // it. Static file matching the connector.json schema with our maintainer.
    if (method === "GET" && url === GLAMA_WELL_KNOWN_PATH) {
      return serveJson(res, {
        $schema: "https://glama.ai/mcp/schemas/connector.json",
        maintainers: [{ email: GLAMA_MAINTAINER_EMAIL }],
      });
    }

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
      res.end(JSON.stringify({ ok: true, oauth: oauthCfg.enabled, sessions: sessions.size }));
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

    // ----- Root: send browsers/crawlers to the marketing page -------------
    // The MCP endpoint lives at /mcp (below); the bare domain used to 404.
    // A 301 hands the exact-match domain's SEO weight to the landing page.
    if ((method === "GET" || method === "HEAD") && (url === "/" || url.startsWith("/?"))) {
      res.statusCode = 301;
      res.setHeader("location", "https://www.upload-post.com/mcp");
      res.setHeader("cache-control", "public, max-age=86400");
      res.end();
      return;
    }

    // ----- Favicons -------------------------------------------------------
    // Clients that add this server as a custom connector (claude.ai among
    // them) brand it by probing the origin for a favicon before they ever
    // speak MCP. Nothing was served here, so they fell back to whatever they
    // had cached for the host — which is why the connector showed a stray
    // logo. Point them at the landing's icons; 302 so a rebrand propagates.
    if ((method === "GET" || method === "HEAD") && FAVICON_REDIRECTS[url]) {
      res.statusCode = 302;
      res.setHeader("location", FAVICON_REDIRECTS[url]);
      res.setHeader("cache-control", "public, max-age=86400");
      res.end();
      return;
    }

    // ----- MCP -----------------------------------------------------------
    if (url !== "/mcp") {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let session = sessionId ? sessions.get(sessionId) : undefined;
    if (session) session.lastSeenAt = Date.now();

    // A session id we don't know means the session was swept (idle TTL) or
    // belonged to a previous deploy. The spec (and every client) expects a
    // 404 here so the client transparently re-initializes; building a fresh
    // transport instead made the SDK answer 400 "Server not initialized",
    // which clients surface as a fatal "session expired".
    if (!session && sessionId) {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found" },
          id: null,
        })
      );
      return;
    }

    // The body is read before the session is built so that an `initialize`
    // request can seed the server with the caller's `clientInfo`. Waiting for
    // the `initialized` notification would leave a window in which the client
    // could list tools and see the ChatGPT-only Upload Studio.
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

    if (!session) {
      const resolution = await resolveAuth(req.headers["authorization"], authDeps);
      if (!resolution) {
        return sendUnauthorized(res, oauthCfg.enabled, oauthCfg.issuer);
      }

      // Cap enforcement: evict the longest-idle session rather than refusing
      // the new one — the evicted client can always re-initialize.
      if (sessions.size >= MAX_SESSIONS) {
        let oldestId: string | undefined;
        let oldestSeen = Infinity;
        for (const [id, s] of sessions) {
          if (s.lastSeenAt < oldestSeen) {
            oldestSeen = s.lastSeenAt;
            oldestId = id;
          }
        }
        if (oldestId) closeSession(sessions, oldestId);
      }

      const client = new UploadPostMcpClient({ apiKey: resolution.apiKey, baseUrl: opts.baseUrl });
      const server = opts.buildServer(client, {
        ...clientInfoFromInitialize(body),
        userAgent: req.headers["user-agent"],
      });
      const transport = stripSchemaDialect(
        new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, server, lastSeenAt: Date.now() });
          },
        })
      );
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      session = { transport, server, lastSeenAt: Date.now() };
    }

    await session.transport.handleRequest(req, res, body);
   } catch (err) {
    // Any throw/rejection from the request path lands here instead of becoming
    // an unhandledRejection that crashes the process. Turn it into a 500 (or
    // just close the socket if the response is already partially written).
    process.stderr.write(
      `[upload-post-mcp] request handler error (${req.method ?? "?"} ${req.url ?? "?"}): ` +
        `${(err as Error)?.stack ?? err}\n`
    );
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "internal_server_error" }));
    } else {
      try {
        res.end();
      } catch {
        /* socket already gone — nothing to do */
      }
    }
   }
  });

  const sweeper = setInterval(() => {
    introspectCache.purgeExpired();
    const cutoff = Date.now() - SESSION_IDLE_TTL_MS;
    let swept = 0;
    for (const [id, s] of sessions) {
      if (s.lastSeenAt < cutoff) {
        closeSession(sessions, id);
        swept++;
      }
    }
    if (swept > 0) {
      process.stderr.write(
        `[upload-post-mcp] swept ${swept} idle session(s), ${sessions.size} active\n`
      );
    }
  }, SESSION_SWEEP_INTERVAL_MS);
  sweeper.unref();

  // Node runs as PID 1 in the container, where the kernel does not apply
  // default signal dispositions — without an explicit handler `docker stop`
  // hangs for its full grace period and ends in SIGKILL.
  const shutdown = (signal: string) => {
    process.stderr.write(`[upload-post-mcp] ${signal} received, shutting down\n`);
    clearInterval(sweeper);
    for (const id of [...sessions.keys()]) closeSession(sessions, id);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

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
 * Close a session's transport and drop it from the map. `transport.onclose`
 * already deletes the map entry, but delete explicitly too in case close()
 * rejects before the callback fires.
 */
function closeSession(sessions: Map<string, Session>, id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  void session.transport.close().catch(() => {
    /* already closed or client gone — nothing to do */
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

function requestPath(url: string): string {
  const queryStart = url.indexOf("?");
  return queryStart >= 0 ? url.slice(0, queryStart) : url;
}

function isOpenAiAppsChallengePath(url: string): boolean {
  const path = requestPath(url).replace(/\/+$/, "");
  return path === OPENAI_APPS_CHALLENGE_PATH;
}

function openAiAppsChallengeToken(): string {
  return (
    process.env.OPENAI_APPS_CHALLENGE_TOKEN?.trim() ||
    DEFAULT_OPENAI_APPS_CHALLENGE_TOKEN
  );
}

function setOpenAiAppsChallengeHeaders(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, HEAD, OPTIONS");
  res.setHeader("access-control-allow-headers", "*");
  res.setHeader("cache-control", "no-store");
  res.setHeader("vary", "Origin");
}

function sendOpenAiAppsChallengeOptions(res: ServerResponse): void {
  res.statusCode = 204;
  setOpenAiAppsChallengeHeaders(res);
  res.end();
}

function sendOpenAiAppsChallenge(res: ServerResponse, method: string): void {
  const token = openAiAppsChallengeToken();
  res.statusCode = 200;
  setOpenAiAppsChallengeHeaders(res);
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(token));
  res.end(method === "HEAD" ? undefined : token);
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
    "https://chatgpt.com",
    "https://chat.openai.com",
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

/**
 * Pull `params.clientInfo` out of an `initialize` request body (single or
 * batched) so the server surface can be shaped before the client ever calls
 * `tools/list`. Returns undefined for anything else.
 */
function clientInfoFromInitialize(body: unknown): ClientInfoLike | undefined {
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const rpc = message as { method?: unknown; params?: { clientInfo?: unknown } };
    if (rpc.method !== "initialize") continue;
    const info = rpc.params?.clientInfo;
    if (info && typeof info === "object") return info as ClientInfoLike;
  }
  return undefined;
}
