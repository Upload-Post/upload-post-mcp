/**
 * Plan limits as next steps the model can relay.
 *
 * The API refuses an upload when the monthly allowance is used up (429,
 * `error_code: monthly_limit_reached`) or when a Free-plan account publishes
 * to TikTok (403, `error_code: plan_required`). Both bodies carry an
 * `upgrade_url`, and their message embeds it. The SDK only surfaces the
 * message, so this works from the message text and falls back to the error
 * codes when the raw body comes through.
 */

/** Checkout for the Basic plan, the cheapest one that lifts both limits. */
export const UPGRADE_URL = "https://app.upload-post.com/pricing?plan=basic&interval=monthly&autostart=1";

/** `plan` value that `get_account_info` reports for the Free plan. */
export const FREE_PLAN = "Default";

export type PlanErrorKind = "monthly_limit" | "tiktok_plan";

export function classifyPlanError(message: string): PlanErrorKind | undefined {
  if (/monthly_limit_reached|would exceed your monthly limit/i.test(message)) return "monthly_limit";
  if (/plan_required|TikTok uploads are not available on the Free plan/i.test(message)) return "tiktok_plan";
  return undefined;
}

/** The checkout link from the API message, or the Basic plan one. */
export function upgradeUrlFrom(message: string): string {
  const m = message.match(/https:\/\/app\.upload-post\.com\/pricing[^\s"'\\,)]*/);
  return m ? m[0].replace(/[.]+$/, "") : UPGRADE_URL;
}

export interface PlanGuidance {
  text: string;
  structured: Record<string, unknown>;
}

/**
 * Turn a plan refusal into a next step with `upgrade_url`, or undefined when
 * the error is about something else.
 */
export function planErrorGuidance(message: string, args: { platforms?: unknown }): PlanGuidance | undefined {
  const kind = classifyPlanError(message);
  if (!kind) return undefined;
  const upgrade_url = upgradeUrlFrom(message);

  if (kind === "monthly_limit") {
    const limit = message.match(/monthly limit of (\d+)/i);
    const remaining = message.match(/You have (-?\d+) upload\(s\) remaining/i);
    const usage: Record<string, number> = {};
    if (limit) usage.monthly_limit = Number(limit[1]);
    if (remaining) usage.remaining = Math.max(0, Number(remaining[1]));
    const left =
      usage.remaining !== undefined
        ? ` ${usage.remaining} upload(s) are left this period, and each platform in a post counts as one.`
        : "";
    const text =
      `This Upload-Post account has used up its monthly uploads, so nothing was published. Do not retry.${left} ` +
      `Tell the user, in their language, that the allowance is used up and that paid plans have unlimited uploads, and give them this link to upgrade: ${upgrade_url} ` +
      "Publish again once they confirm they have upgraded" +
      (usage.remaining ? ", or now to fewer platforms if they prefer to stay within what is left." : ".");
    return {
      text,
      structured: { error: message, error_code: "monthly_limit_reached", next_step: text, upgrade_url, ...usage },
    };
  }

  const requested = Array.isArray(args.platforms) ? (args.platforms as unknown[]).map((p) => String(p).toLowerCase()) : [];
  const others = requested.filter((p) => p !== "tiktok");
  const text =
    "TikTok needs a paid Upload-Post plan (Basic or higher) and this account is on the Free plan, so the whole request was refused and nothing was published" +
    (others.length ? `, not even to ${others.join(", ")}` : "") +
    `. Do not retry it as is. Tell the user this, in their language, and give them this link to upgrade: ${upgrade_url} ` +
    (others.length
      ? `Offer to publish now to ${others.join(", ")} without TikTok, and do so only if they agree; TikTok can follow once they have upgraded.`
      : "Publish to TikTok once they confirm they have upgraded.");
  return {
    text,
    structured: { error: message, error_code: "plan_required", next_step: text, upgrade_url, plan_required_for: "tiktok" },
  };
}
