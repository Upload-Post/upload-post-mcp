/** The subset of MCP `clientInfo` this server cares about. */
export interface ClientInfoLike {
  name?: unknown;
  version?: unknown;
}

/**
 * Per-session view of the connected MCP client, resolved from the
 * `initialize` handshake (`clientInfo`).
 *
 * The hosted Upload Studio widget speaks the ChatGPT Apps SDK bridge
 * (`text/html+skybridge` + `window.openai`). Any other host that honours
 * `_meta.ui.resourceUri` (claude.ai, VS Code, …) tries to render it as an MCP
 * App, fails, and shows the user "Upload Post MCP cannot be reached". So the
 * Studio is only advertised to ChatGPT; everyone else gets the plain media
 * staging tools and text guidance instead.
 */
export type ClientKind = "chatgpt" | "other";

export interface ClientProfile {
  kind: ClientKind;
  name: string;
  version: string;
}

export interface SessionContext {
  /** Undefined until the client has completed `initialize`. */
  profile?: ClientProfile;
}

const DEFAULT_STUDIO_CLIENT_PATTERN = "openai|chatgpt";

function studioClientPattern(): RegExp {
  const raw = process.env.UPLOAD_POST_STUDIO_CLIENTS?.trim() || DEFAULT_STUDIO_CLIENT_PATTERN;
  try {
    return new RegExp(raw, "i");
  } catch {
    return new RegExp(DEFAULT_STUDIO_CLIENT_PATTERN, "i");
  }
}

export function detectClientProfile(info: ClientInfoLike | undefined): ClientProfile {
  const name = (info?.name ?? "").toString();
  const version = (info?.version ?? "").toString();
  const kind: ClientKind = studioClientPattern().test(name) ? "chatgpt" : "other";
  return { kind, name: name || "unknown", version: version || "unknown" };
}

export function isChatGpt(ctx: SessionContext): boolean {
  return ctx.profile?.kind === "chatgpt";
}

/**
 * Text handed to models on hosts without the Studio, explaining how to get a
 * local/attached file into Upload-Post.
 */
export const LOCAL_FILE_GUIDANCE =
  "A hosted MCP server cannot read files on the user's machine or chat attachments (`/mnt/data`, sandbox paths). " +
  "To publish a local file: (1) if this client can run HTTP requests itself (for example a coding agent with a shell), " +
  "stage it with `create_media_upload` (returns `upload_id` + `upload_url`), PUT the raw file bytes to `upload_url` with the same Content-Type, " +
  "call `complete_media_upload` and pass the returned `media_url` as the media URL; (2) otherwise ask the user for a public HTTPS URL of the file, " +
  "or tell them to publish it from the dashboard at https://app.upload-post.com. Staged media is deleted after 24 hours.";
