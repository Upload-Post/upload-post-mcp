import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY_BYTES = 64 * 1024;

export async function readBuffer(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const buf = await readBuffer(req);
  if (buf.length === 0) return null;
  return JSON.parse(buf.toString("utf8"));
}

export async function readFormBody(req: IncomingMessage): Promise<Record<string, string>> {
  const buf = await readBuffer(req);
  if (buf.length === 0) return {};
  const params = new URLSearchParams(buf.toString("utf8"));
  const out: Record<string, string> = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

export function sendError(
  res: ServerResponse,
  status: number,
  error: string,
  description?: string
): void {
  const body: Record<string, string> = { error };
  if (description) body.error_description = description;
  sendJson(res, status, body);
}

export function sendRedirect(res: ServerResponse, url: string): void {
  res.statusCode = 302;
  res.setHeader("location", url);
  res.setHeader("cache-control", "no-store");
  res.end();
}
