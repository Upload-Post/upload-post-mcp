import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { UploadPostMcpClient } from "../client.js";

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
 *   - one Upload-Post API key (taken from the very first request's
 *     `Authorization` header — `ApiKey <key>` or `Bearer <key>`),
 *   - one `UploadPostMcpClient` bound to that key,
 *   - one `McpServer` with tools that close over that client.
 *
 * Subsequent requests on the same session route to the same transport via the
 * `mcp-session-id` header. Closing the transport drops the session from the
 * map so the per-user state can be GC'd.
 *
 * The server itself stores nothing — keys live only inside the in-memory
 * client of the session that received them.
 */
export async function runHttp(opts: HttpOptions): Promise<void> {
  const sessions = new Map<string, Session>();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && (req.url === "/healthz" || req.url === "/health")) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url !== "/mcp") {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let session = sessionId ? sessions.get(sessionId) : undefined;

    if (!session) {
      const apiKey = extractApiKey(req.headers["authorization"]);
      if (!apiKey) {
        res.statusCode = 401;
        res.setHeader("www-authenticate", 'ApiKey realm="upload-post"');
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            error:
              "Missing or malformed Authorization header. Send 'Authorization: ApiKey <your_upload_post_api_key>' (or 'Bearer <key>'). Get your key at https://app.upload-post.com",
          })
        );
        return;
      }

      const client = new UploadPostMcpClient({ apiKey, baseUrl: opts.baseUrl });
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
    if (req.method === "POST") {
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
          `(per-request API key from Authorization header)\n`
      );
      resolve();
    });
  });
}

/**
 * Accept both `Authorization: ApiKey <key>` (preferred — matches the upstream
 * Upload-Post API) and `Authorization: Bearer <key>` (some MCP clients only
 * allow Bearer). Anything else is rejected.
 */
function extractApiKey(header: string | string[] | undefined): string | null {
  if (!header || Array.isArray(header)) return null;
  const m = header.match(/^(?:ApiKey|Bearer)\s+(.+)$/i);
  if (!m) return null;
  const key = m[1].trim();
  return key.length > 0 ? key : null;
}
