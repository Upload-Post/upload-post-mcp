import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * Strip the `$schema` dialect declaration from tool schemas on the wire.
 *
 * The 1.x SDK converts Zod shapes with zod-to-json-schema, which stamps
 * `"$schema": "http://json-schema.org/draft-07/schema#"` on every
 * inputSchema/outputSchema it emits. Per SEP-1613 the MCP default dialect is
 * JSON Schema 2020-12, so strict clients (Ajv-based, e.g. mcp-remote) refuse
 * the explicit draft-07 declaration and block every tool call. With no
 * `$schema` present clients assume 2020-12; our schemas use only
 * dialect-neutral keywords, so dropping the declaration is safe for old and
 * new clients alike. Remove once we migrate to SDK v2 + Zod v4, which emit
 * 2020-12 natively.
 */
export function stripSchemaDialect<T extends Transport>(transport: T): T {
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    const tools = (message as { result?: { tools?: unknown } }).result?.tools;
    if (Array.isArray(tools)) {
      for (const tool of tools as Array<Record<string, unknown>>) {
        for (const key of ["inputSchema", "outputSchema"]) {
          const schema = tool[key];
          if (schema && typeof schema === "object") {
            delete (schema as Record<string, unknown>).$schema;
          }
        }
      }
    }
    return send(message, options);
  };
  return transport;
}
