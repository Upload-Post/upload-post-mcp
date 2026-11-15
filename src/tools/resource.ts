import { z } from "zod";
import type { UploadPostMcpClient } from "../client.js";

/**
 * Shared plumbing for the per-resource tools (one tool per resource, one
 * `action` argument picking the REST route). The API takes its own field
 * names; the tool passes them through `params` as given, so nested Telegram /
 * Bluesky / Google objects keep their shape and `null` (clear a field) is kept.
 */

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface Route {
  method: Method;
  /** API path under /api; `{name}` segments are filled from the fields. */
  path: string;
  /** Fields always sent for this action (e.g. the API's own `action`). */
  fixed?: Record<string, unknown>;
}

export const paramsField = (what: string) =>
  z
    .record(z.unknown())
    .optional()
    .describe(
      `Other API fields for this action, with the REST API's own names (snake_case) and shapes. ${what} ` +
        "Leave out what you do not want to change."
    );

export const apiConfirmField = z
  .boolean()
  .optional()
  .describe(
    "The API's own confirmation for deletions and other changes that cannot be undone. Set it to true only after the user has approved that exact change; without it those actions are refused and nothing changes."
  );

/** Drop only undefined: `null`, false and "" can mean something to the API. */
function defined(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = v;
  return out;
}

/** Query values as the API reads them: lists comma-separated, objects as JSON. */
function toQuery(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === "") continue;
    if (Array.isArray(v)) out[k] = v.join(",");
    else if (typeof v === "object") out[k] = JSON.stringify(v);
    else out[k] = v;
  }
  return out;
}

export async function callRoute(
  client: UploadPostMcpClient,
  route: Route,
  input: Record<string, unknown>
): Promise<unknown> {
  const fields = defined({ ...input, ...(route.fixed ?? {}) });
  const path = route.path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = fields[name];
    delete fields[name];
    if (value === undefined || value === null || value === "") {
      throw new Error(`\`${name}\` is required for this action.`);
    }
    return encodeURIComponent(String(value));
  });
  if (route.method === "GET") {
    return client.request("GET", path, { query: toQuery(fields) });
  }
  return client.request(route.method, path, { body: fields });
}

/**
 * Merge the tool's own arguments into one field map: `params` first, then the
 * named arguments (which win), leaving out `action` (it picks the route).
 */
export function mergeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { action: _action, params, ...named } = args as { action?: unknown; params?: Record<string, unknown> };
  return { ...(params ?? {}), ...named };
}
