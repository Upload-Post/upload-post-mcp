#!/usr/bin/env node
import { UploadPostMcpClient } from "./client.js";
import { buildServer } from "./server.js";
import { runStdio } from "./transport/stdio.js";
import { runHttp } from "./transport/http.js";

interface ParsedArgs {
  http: boolean;
  port: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    http: false,
    port: Number(process.env.UPLOAD_POST_MCP_PORT ?? 8080),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--http") out.http = true;
    else if (arg === "--port") out.port = Number(argv[++i]);
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "upload-post-mcp — Model Context Protocol server for Upload-Post",
          "",
          "Usage: upload-post-mcp [--http] [--port <n>]",
          "",
          "Modes:",
          "  stdio (default)   single-user, API key from UPLOAD_POST_API_KEY env var",
          "  --http            multi-tenant, API key per request via Authorization header",
          "",
          "Env:",
          "  UPLOAD_POST_API_KEY    Required in stdio mode. Ignored in --http mode.",
          "  UPLOAD_POST_BASE_URL   (optional) Override API base URL",
          "  UPLOAD_POST_MCP_PORT   (optional) HTTP port (default 8080)",
          "",
        ].join("\n")
      );
      process.exit(0);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = process.env.UPLOAD_POST_BASE_URL;

  if (args.http) {
    // Multi-tenant: each request brings its own Upload-Post API key in the
    // Authorization header. No shared key on the server.
    await runHttp({
      port: args.port,
      baseUrl,
      buildServer,
    });
    return;
  }

  // Single-user stdio: key comes from env, baked into one shared client.
  const apiKey = process.env.UPLOAD_POST_API_KEY;
  if (!apiKey) {
    process.stderr.write(
      "[upload-post-mcp] UPLOAD_POST_API_KEY env var is required in stdio mode.\n" +
        "Set it in your MCP client config. Get one at https://app.upload-post.com\n"
    );
    process.exit(1);
  }

  const client = new UploadPostMcpClient({ apiKey, baseUrl });
  const server = buildServer(client);
  await runStdio(server);
}

main().catch((err) => {
  process.stderr.write(`[upload-post-mcp] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
