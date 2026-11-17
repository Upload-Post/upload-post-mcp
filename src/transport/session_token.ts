import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Self-contained session ids.
 *
 * A session used to live only in the memory of the process that opened it: a
 * restart, a deploy, the idle sweep or the session cap ended it, and the
 * client's next call came back "Session not found". The id now carries what
 * is needed to open the session again (who the client said it was in
 * `initialize`), signed by the server. Any process that holds the secret can
 * rebuild the session the first time it sees the id, so the in-memory map is
 * only a cache and nothing has to be stored anywhere.
 *
 * The id is not a credential: it holds no key and every request still has to
 * present its own `Authorization`. It only names the key it was opened with
 * (a short fingerprint), so it cannot be replayed with someone else's.
 */

/** What `initialize` told the server, kept to replay it. */
export interface SessionSeed {
  /** Fingerprint prefix of the API key the session was opened with. */
  key: string;
  protocolVersion?: string;
  clientInfo?: { name?: string; version?: string };
  capabilities?: Record<string, unknown>;
}

const PREFIX = "s1";
const KEY_PREFIX_LENGTH = 24;
/** Larger capability objects are reduced to their `extensions`. */
const MAX_CAPABILITIES_BYTES = 1024;
/** A session id travels in a header on every request: keep it bounded. */
const MAX_TOKEN_LENGTH = 4096;

function clip(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

function compactCapabilities(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const all = value as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(all)) <= MAX_CAPABILITIES_BYTES) return all;
  const extensions = all.extensions;
  if (extensions && typeof extensions === "object") {
    const reduced = { extensions };
    if (Buffer.byteLength(JSON.stringify(reduced)) <= MAX_CAPABILITIES_BYTES) return reduced;
  }
  return {};
}

/** The parts of an `initialize` request (single or batched) worth keeping. */
export function seedFromInitialize(body: unknown, keyFingerprint: string): SessionSeed {
  const seed: SessionSeed = { key: keyFingerprint.slice(0, KEY_PREFIX_LENGTH) };
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const rpc = message as { method?: unknown; params?: Record<string, unknown> };
    if (rpc.method !== "initialize" || !rpc.params || typeof rpc.params !== "object") continue;
    seed.protocolVersion = clip(rpc.params.protocolVersion, 32);
    const info = rpc.params.clientInfo;
    if (info && typeof info === "object") {
      const { name, version } = info as { name?: unknown; version?: unknown };
      seed.clientInfo = { name: clip(name, 80), version: clip(version, 40) };
    }
    seed.capabilities = compactCapabilities(rpc.params.capabilities);
    break;
  }
  return seed;
}

/**
 * Ids issued before sessions were self-contained: plain UUIDs. They carry
 * nothing, so such a session is rebuilt from the request that presents it.
 */
export function isLegacySessionId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/**
 * Seed for a legacy id. Such an id says nothing about the client, so the
 * replayed `initialize` names it after the product token of its User-Agent
 * (`openai-mcp/1.0.0 (...)` gives `openai-mcp` / `1.0.0`): the same name the
 * client gave when it opened the session, which keeps the tool surface it had.
 */
export function legacySeed(userAgent: unknown): SessionSeed {
  const product = /^([^\/\s]+)(?:\/(\S+))?/.exec(typeof userAgent === "string" ? userAgent : "");
  return {
    key: "",
    clientInfo: { name: clip(product?.[1], 80), version: clip(product?.[2], 40) },
  };
}

export class SessionTokens {
  private readonly secret: Buffer;
  /** False when the secret was made up at start: ids do not outlive the process. */
  readonly durable: boolean;

  constructor(secret: string | undefined) {
    const given = secret?.trim();
    this.durable = Boolean(given);
    this.secret = given ? Buffer.from(given, "utf8") : randomBytes(32);
  }

  private sign(payload: string): Buffer {
    return createHmac("sha256", this.secret).update(`${PREFIX}.${payload}`).digest();
  }

  /** A new session id for `seed`. Unique: every id carries its own nonce. */
  issue(seed: SessionSeed): string {
    const payload = Buffer.from(
      JSON.stringify({
        n: randomBytes(9).toString("base64url"),
        k: seed.key.slice(0, KEY_PREFIX_LENGTH),
        p: seed.protocolVersion,
        c: seed.clientInfo,
        x: seed.capabilities,
      }),
      "utf8"
    ).toString("base64url");
    return `${PREFIX}.${payload}.${this.sign(payload).toString("base64url")}`;
  }

  /** The seed inside `id`, or undefined when it is not one of ours. */
  verify(id: string): SessionSeed | undefined {
    if (typeof id !== "string" || id.length > MAX_TOKEN_LENGTH) return undefined;
    const parts = id.split(".");
    if (parts.length !== 3 || parts[0] !== PREFIX) return undefined;
    const [, payload, signature] = parts;
    let given: Buffer;
    try {
      given = Buffer.from(signature, "base64url");
    } catch {
      return undefined;
    }
    const expected = this.sign(payload);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    try {
      const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
        k?: unknown;
        p?: unknown;
        c?: unknown;
        x?: unknown;
      };
      if (typeof data.k !== "string" || data.k.length === 0) return undefined;
      const seed: SessionSeed = { key: data.k };
      seed.protocolVersion = clip(data.p, 32);
      if (data.c && typeof data.c === "object") {
        const { name, version } = data.c as { name?: unknown; version?: unknown };
        seed.clientInfo = { name: clip(name, 80), version: clip(version, 40) };
      }
      if (data.x && typeof data.x === "object" && !Array.isArray(data.x)) {
        seed.capabilities = data.x as Record<string, unknown>;
      }
      return seed;
    } catch {
      return undefined;
    }
  }

  /** Whether `fingerprint` (full key fingerprint) is the key `seed` was opened with. */
  static sameKey(seed: SessionSeed, fingerprint: string): boolean {
    return seed.key === fingerprint.slice(0, KEY_PREFIX_LENGTH);
  }
}

interface WebStandardTransportLike {
  handleRequest(request: Request, options?: { parsedBody?: unknown }): Promise<Response>;
}

/**
 * Bring a freshly connected transport to the state it had after the client's
 * own `initialize`, by replaying that handshake from the seed. The transport
 * must have been created with a `sessionIdGenerator` that returns `sessionId`.
 *
 * Uses the SDK's web-standard transport that the Node one wraps
 * (`_webStandardTransport`, SDK 1.29): scripts/check-session-rehydrate.mjs
 * fails if an SDK upgrade moves it.
 */
export async function replayInitialize(
  transport: unknown,
  seed: SessionSeed,
  sessionId: string,
  timeoutMs = 5000
): Promise<void> {
  const inner = (transport as { _webStandardTransport?: WebStandardTransportLike })
    ._webStandardTransport;
  if (!inner || typeof inner.handleRequest !== "function") {
    throw new Error("session rehydration: the SDK transport no longer exposes its web-standard core");
  }
  const send = async (message: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    inner.handleRequest(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
        body: JSON.stringify(message),
      }),
      { parsedBody: message }
    );
  const within = async <T>(work: Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("session rehydration timed out")), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const initialize = {
    jsonrpc: "2.0",
    id: "rehydrate",
    method: "initialize",
    params: {
      protocolVersion: seed.protocolVersion ?? "2025-03-26",
      capabilities: seed.capabilities ?? {},
      clientInfo: {
        name: seed.clientInfo?.name ?? "unknown",
        version: seed.clientInfo?.version ?? "0",
      },
    },
  };
  const opened = await within(send(initialize));
  if (!opened.ok) {
    throw new Error(`session rehydration: initialize answered ${opened.status}`);
  }
  // The answer arrives as an SSE stream that ends once the result is written.
  const answer = await within(opened.text());
  const negotiated = /"protocolVersion"\s*:\s*"([^"]+)"/.exec(answer)?.[1];

  const ready = await within(
    send(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      {
        "mcp-session-id": sessionId,
        ...(negotiated ? { "mcp-protocol-version": negotiated } : {}),
      }
    )
  );
  await ready.body?.cancel().catch(() => undefined);
  if (ready.status >= 400) {
    throw new Error(`session rehydration: initialized answered ${ready.status}`);
  }
}
