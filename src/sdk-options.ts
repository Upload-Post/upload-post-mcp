import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/**
 * platformOptions keys the upload-post SDK actually reads.
 *
 * The SDK builds the form from a whitelist and drops every other key without a
 * word, so an agent that guesses a key (or copies a REST field name the SDK
 * does not map) publishes a post without the option it asked for. Agents
 * reported exactly that through send_feedback (trial Reels, Facebook photo
 * stories, the Instagram AI label). Reading the key list from the installed
 * SDK source keeps it in step with every SDK upgrade, with no list to maintain
 * here.
 */

/** Keys this server consumes itself before calling the SDK (resolvePlatformRouting). */
const ROUTING_KEYS = ["linkedinPageId", "googleBusinessLocationId", "post_mode", "tiktok_upload_to_draft"];

let cached: Set<string> | null = null;

export function sdkOptionKeys(): Set<string> {
  if (cached) return cached;
  const keys = new Set<string>(ROUTING_KEYS);
  let source = "";
  try {
    const require = createRequire(import.meta.url);
    source = readFileSync(require.resolve("upload-post"), "utf8");
  } catch {
    // Without the source we cannot tell; report nothing rather than guess.
    cached = null;
    return new Set<string>();
  }
  // options.fooBar
  for (const m of source.matchAll(/\boptions\.([A-Za-z_$][\w$]*)/g)) keys.add(m[1]);
  // this._pick(options, 'a', 'b', ...)
  for (const m of source.matchAll(/_pick\(\s*options\s*,([^)]*)\)/g)) {
    for (const k of m[1].matchAll(/'([^']+)'|"([^"]+)"/g)) keys.add(k[1] ?? k[2]);
  }
  // Table rows such as ['form_field', 'optionKey', 'flag'] read through options[key].
  for (const m of source.matchAll(/\[\s*'[^']+'\s*,\s*'([A-Za-z_$][\w$]*)'\s*,\s*'(?:flag|text)'\s*\]/g)) {
    keys.add(m[1]);
  }
  cached = keys;
  return keys;
}

/** platformOptions keys the SDK will not send. Empty when the SDK source could not be read. */
export function ignoredPlatformOptions(platformOptions: Record<string, unknown> | undefined): string[] {
  if (!platformOptions) return [];
  const known = sdkOptionKeys();
  if (known.size === 0) return [];
  return Object.keys(platformOptions).filter(
    (k) => platformOptions[k] !== undefined && !known.has(k)
  );
}

/**
 * Attach a warning to an upload result when some platformOptions were dropped,
 * so the agent can tell the user instead of assuming the option was applied.
 */
export function withIgnoredOptionsWarning(result: unknown, ignored: string[]): unknown {
  if (ignored.length === 0) return result;
  const warning =
    `These platformOptions keys are not supported and were NOT sent, so the post was published without them: ${ignored.join(", ")}. ` +
    "Check the platformOptions schema of this tool for the right key, tell the user the option was not applied, and if the option is documented in the REST API but missing here, report it with send_feedback.";
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return { ...(result as Record<string, unknown>), ignored_platform_options: ignored, platform_options_warning: warning };
  }
  return { result, ignored_platform_options: ignored, platform_options_warning: warning };
}
