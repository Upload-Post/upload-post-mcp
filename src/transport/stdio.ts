import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { stripSchemaDialect } from "./schema_dialect.js";

export async function runStdio(server: McpServer): Promise<void> {
  const transport = stripSchemaDialect(new StdioServerTransport());
  await server.connect(transport);
  // stdio servers are kept alive by the parent process pipe; nothing else to do.
}
