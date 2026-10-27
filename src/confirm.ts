import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok } from "./schemas.js";

/**
 * Confirmation step for actions that reach other people or publish as the user.
 *
 * A gated tool called without its confirmation argument does nothing: it
 * returns a preview of exactly what would go out and tells the model to show it
 * to the user. Only a second call with the confirmation argument runs it. The
 * check lives in the server, so it holds even if a model skips the description.
 *
 * Requested by Anthropic's directory review (2026-10-27). ChatGPT does not get
 * the gates: its tool surface is the one OpenAI reviewed, and ChatGPT already
 * asks the user before every write tool.
 */

type Args = Record<string, unknown>;

interface Gate {
  /** What the call would do, or undefined when this particular call needs no confirmation. */
  describe(args: Args): string | undefined;
  /** Argument that unlocks the call. Default: `confirmed: true`. */
  field?: "confirmed" | "confirm_username";
}

const CONFIRMED_FIELD = z
  .boolean()
  .optional()
  .describe(
    "Set to true only after the user has seen the preview this tool returns without it and approved it. Without it nothing is sent."
  );

const CONFIRM_USERNAME_FIELD = z
  .string()
  .optional()
  .describe(
    "The profile name typed again by the user to confirm the deletion. Must equal `username`; otherwise nothing is deleted."
  );

const CONFIRMED_NOTE =
  "Needs the user's approval: call it first without `confirmed` to get a preview (nothing is sent), show the user exactly what will go out, and repeat the call with `confirmed: true` only after they approve.";

const CONFIRM_USERNAME_NOTE =
  "Needs the user's approval: the call only deletes when `confirm_username` repeats the profile name, typed or approved by the user. Without it the response says what would be deleted.";

const str = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
const list = (v: unknown): string => (Array.isArray(v) ? v.join(", ") : str(v));

function publishWhen(a: Args): string {
  if (a.scheduledDate) return `Schedules for ${str(a.scheduledDate)}${a.timezone ? ` (${str(a.timezone)})` : ""}`;
  if (a.addToQueue) return "Adds to the posting queue";
  return "Publishes IMMEDIATELY";
}

const upload = (what: string): Gate => ({
  describe: (a) => `${publishWhen(a)} ${what} as profile "${str(a.user)}" on ${a.platforms ? list(a.platforms) : "LinkedIn"}.`,
});

const autodmStart = (a: Args): string => {
  const platform = str(a.platform ?? "instagram");
  const answer = platform === "instagram" ? "a private Instagram DM" : `a PUBLIC reply on ${platform}`;
  const keywords = a.trigger_keywords ? `comments containing ${list(a.trigger_keywords)}` : "EVERY comment";
  return (
    `Starts a monitor on profile "${str(a.profile_username)}" that answers ${keywords} on ${str(a.post_url ?? a.post_id)} ` +
    `with ${answer}, every ${str(a.monitoring_interval ?? 15)} minutes for up to 15 days, with nobody reviewing each message.`
  );
};

export const GATES: Record<string, Gate> = {
  upload_video: upload("a video"),
  upload_photos: upload("photos"),
  upload_text: upload("a text post"),
  upload_document: upload("a document"),
  send_dm: {
    describe: (a) => `Sends an Instagram DM as profile "${str(a.user)}" to recipient ${str(a.recipient_id)}.`,
  },
  reply_to_comment: {
    describe: (a) => `Sends a private DM as profile "${str(a.user)}" to the author of comment ${str(a.commentId)}.`,
  },
  public_reply_to_comment: {
    describe: (a) => `Posts a PUBLIC reply as profile "${str(a.user)}" under comment ${str(a.commentId)}.`,
  },
  create_comment: {
    describe: (a) =>
      `Posts a PUBLIC ${a.commentId ? "reply" : "comment"} on ${str(a.platform ?? "instagram")} as profile "${str(a.user)}".`,
  },
  reply_to_google_business_review: {
    describe: (a) =>
      `Posts (or replaces) the PUBLIC owner reply to Google review ${str(a.review_name ?? a.review_id)} as profile "${str(a.user)}".`,
  },
  edit_comment: {
    describe: (a) => `Rewrites comment ${str(a.commentId)} on ${str(a.platform)}; the previous text is not kept.`,
  },
  hide_comment: {
    describe: (a) =>
      a.banAuthor && a.hidden !== false
        ? `Hides comment ${str(a.commentId)} and BANS its author from the YouTube channel.`
        : undefined,
  },
  comment_action: {
    describe: (a) => {
      if (a.action === "edit") return `Rewrites comment ${str(a.commentId)} on ${str(a.platform)}; the previous text is not kept.`;
      if (a.banAuthor && a.action === "hide") return `Hides comment ${str(a.commentId)} and BANS its author from the YouTube channel.`;
      return undefined;
    },
  },
  start_autodm: { describe: autodmStart },
  manage_autodms: { describe: (a) => (a.action === "start" ? autodmStart(a) : undefined) },
  unpublish_post: {
    describe: (a) =>
      `Permanently deletes post ${str(a.postId)} from ${str(a.platform)} (profile "${str(a.user)}"). It cannot be restored.`,
  },
  delete_user: {
    field: "confirm_username",
    describe: (a) =>
      `Permanently deletes profile "${str(a.username)}" and disconnects every social account on it. It cannot be undone.`,
  },
};

/** Arguments as the user should review them: inline file bytes are summarised, not echoed. */
function previewArgs(args: Args): Args {
  const out: Args = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || key === "confirmed" || key === "confirm_username") continue;
    out[key] = /base64/i.test(key) && typeof value === "string" ? `<${value.length} base64 characters>` : value;
  }
  return out;
}

function confirmationRequired(name: string, action: string, args: Args, field: string): unknown {
  const nextStep =
    field === "confirm_username"
      ? `Nothing has been deleted. Tell the user exactly what this deletes and ask them to type the profile name to confirm. Only then call ${name} again with confirm_username set to it.`
      : `Nothing has been sent yet. Show the user this preview: the exact text, media, recipients or platforms, buttons, keywords and timing. Only after they approve it, call ${name} again with the same arguments plus confirmed: true. If they want changes, apply them and preview again.`;
  return {
    status: "confirmation_required",
    executed: false,
    action,
    preview: previewArgs(args),
    next_step: nextStep,
  };
}

function isUnlocked(args: Args, field: string): boolean {
  if (field === "confirm_username") {
    return typeof args.confirm_username === "string" && args.confirm_username.trim() === str(args.username).trim();
  }
  return args.confirmed === true;
}

/**
 * Add the confirmation argument, description note and server-side check to
 * every gated tool registered on `server`. Call once per session, after any
 * other description rewrites.
 */
export function applyConfirmationGates(server: McpServer): void {
  // McpServer keeps no public lookup by name; this is the map it lists from.
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
  for (const [name, gate] of Object.entries(GATES)) {
    const tool = registered[name];
    if (!tool) continue;
    const field = gate.field ?? "confirmed";
    const shape = (tool.inputSchema as z.AnyZodObject).shape;
    const original = tool.handler as (args: Args, extra: unknown) => Promise<unknown>;
    tool.update({
      description: `${tool.description ?? ""} ${field === "confirmed" ? CONFIRMED_NOTE : CONFIRM_USERNAME_NOTE}`,
      paramsSchema: { ...shape, [field]: field === "confirmed" ? CONFIRMED_FIELD : CONFIRM_USERNAME_FIELD },
      callback: (async (args: Args, extra: unknown) => {
        const action = gate.describe(args);
        if (action && !isUnlocked(args, field)) {
          return ok(confirmationRequired(name, action, args, field));
        }
        const { confirmed: _confirmed, confirm_username: _username, ...rest } = args;
        return original(rest, extra);
      }) as never,
    });
  }
}
