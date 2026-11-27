import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { genericResultOutputSchema, safe } from "../schemas.js";
import { callRoute, mergeArgs, type Route } from "./resource.js";

/**
 * Upload-Post phone numbers: numbers the account rents from Upload-Post (our
 * carrier provides them) to receive SMS and calls, verify WhatsApp on them and,
 * outside the US and Canada, send SMS. One read tool for everything that only
 * looks, and one tool per thing that spends money, reaches someone or cannot be
 * undone, so each carries its own annotations and confirmation step: fixing a
 * declined identity review (and answering its reviewer) and the shareable KYC
 * links are their own tools for the same reason.
 *
 * Raw HTTP: upload-post 2.21.0 has no phone number methods yet; these can move
 * to the SDK once it ships them.
 */

const P = "/uploadposts/phone-numbers";

const READ_ROUTES: Record<string, Route> = {
  config: { method: "GET", path: `${P}/config` },
  countries: { method: "GET", path: `${P}/countries` },
  search_available: { method: "GET", path: `${P}/available` },
  kyc_fields: { method: "GET", path: `${P}/kyc` },
  list: { method: "GET", path: P },
  get: { method: "GET", path: `${P}/{number_id}` },
  messages: { method: "GET", path: `${P}/{number_id}/messages` },
  calls: { method: "GET", path: `${P}/{number_id}/calls` },
  codes: { method: "GET", path: `${P}/{number_id}/codes` },
  usage: { method: "GET", path: `${P}/usage` },
  port_out_info: { method: "GET", path: `${P}/{number_id}/port-out` },
  kyc_review: { method: "GET", path: `${P}/{number_id}/remediate` },
  kyc_links: { method: "GET", path: `${P}/kyc/share` },
};

const MANAGE_ROUTES: Record<string, Route> = {
  update_voice: { method: "PATCH", path: `${P}/{number_id}/voice` },
  prepare_whatsapp: { method: "POST", path: `${P}/{number_id}/whatsapp/prepare` },
};

/** Fields each read action sends; anything else given is not passed on. */
const READ_FIELDS: Record<string, string[]> = {
  config: [],
  countries: [],
  search_available: ["country", "number_type", "area_code", "locality", "contains", "sms", "limit"],
  kyc_fields: ["country", "number_type"],
  list: ["status", "profile_username"],
  get: ["number_id"],
  messages: ["number_id", "limit", "before"],
  calls: ["number_id", "limit", "before"],
  codes: ["number_id", "since"],
  usage: ["from", "to"],
  port_out_info: ["number_id"],
  kyc_review: ["number_id"],
  kyc_links: [],
};

const MANAGE_FIELDS: Record<string, string[]> = {
  update_voice: [
    "number_id",
    "forward_to",
    "voicemail_enabled",
    "voicemail_greeting",
    "recording_enabled",
    "transcription_enabled",
    "transcription_language",
  ],
  prepare_whatsapp: ["number_id", "language"],
};

const actionEnum = (routes: Record<string, Route>) => z.enum(Object.keys(routes) as [string, ...string[]]);

/** The public gate, as the API words it. */
export const PHONE_AVAILABILITY =
  "Not generally available yet: the API answers 403 phone_numbers_not_available until phone numbers are available for the account (phone_numbers_read `config` answers enabled: false). ";

/** What a consumer (end_user.type individual) agrees to with immediate_start_consent, as the API words it. */
export const IMMEDIATE_START_CONSENT_TEXT =
  "I ask Upload-Post to start providing this number now, within the 14-day withdrawal period. I understand that if I withdraw I will pay for the days already provided, and that I lose the right of withdrawal once the service has been fully provided.";

/** A consumer purchase without the consent: refuse before sending, and say what to ask. */
export function needsImmediateStartConsent(args: Record<string, unknown>): boolean {
  const endUser = args.end_user as { type?: unknown } | undefined;
  return endUser?.type === "individual" && args.immediate_start_consent !== true;
}

const CONSENT_REFUSAL =
  `immediate_start_consent_required: nothing was sent, bought or charged. The end user is an individual (a consumer), so the purchase needs their express request to start the service now, within the 14-day withdrawal period. Show the user this text exactly and ask whether they agree: "${IMMEDIATE_START_CONSENT_TEXT}" Only if they agree, call purchase_phone_number again with the same arguments plus immediate_start_consent: true. Never set it on their behalf.`;

const PHONE_RULES =
  "Paid plans only (an active subscription with at least one paid invoice; trials and the Free plan get 402 phone_numbers_paid_plan_required with an `upgrade_url` to relay). " +
  "These numbers cannot make outbound calls and can NEVER call emergency services (112 / 911). US and Canadian numbers receive SMS but cannot send SMS yet (403 sms_registration_required); some Spanish, German and Italian numbers have no SMS at all. ";

const OWNER_ONLY =
  "Team members acting on the owner's account cannot buy, send identity documents, fix an identity review or answer its reviewer, create or revoke KYC links, release or read port-out details (403 phone_numbers_owner_only): only the owner or an Admin can. ";

/** A declined identity review no longer refunds at once: the payment is kept while it is fixed. */
export const DECLINED_RULE =
  "A declined identity review (status regulatory_declined, phone_number_declined webhook with the reason, and an email) keeps the payment and pauses the monthly charge (nothing renews): read phone_numbers_read `kyc_review` to see what was declined and send only the corrections with fix_phone_number_kyc `resubmit`, which never charges again. The number's remediation_deadline_at (declined_at + 30 days, in phone_numbers_read `get` / `list` and `kyc_review`) is the last day to fix it: tell the user that date. If nothing is fixed within 30 days, or the number is released, the purchase is cancelled and refunded and the number released. Once approved the number turns active and billing resumes (no new proration). ";

const numberIdField = z.string().min(1).describe("Upload-Post id of the number (`pn_...`), from phone_numbers_read `list`.");
const countryField = z.string().length(2).describe("ISO country code, e.g. 'ES', 'GB', 'US'.");
const numberTypeField = z.enum(["local", "mobile", "national"]).describe("local (default), mobile or national. No toll-free numbers.");
const languageEnum = z.enum(["en", "es", "pt", "fr", "de", "it"]);

/** Only the fields an action uses, in the API's names. */
function pick(fields: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (fields[k] !== undefined) out[k] = fields[k];
  return out;
}

/** `forward_to` as the API takes it: `tel:+E164`, or null to stop forwarding. */
export function normalizeForwardTo(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const v = value.trim().replace(/[\s().-]/g, "");
  return /^\+\d+$/.test(v) ? `tel:${v}` : value.trim();
}

/** A purchase answered 202: say what happens next instead of leaving the model to guess. */
export function purchaseNextStep(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const r = result as Record<string, unknown>;
  if (r.status === "kyc_required") {
    return {
      ...r,
      next_step:
        "Nothing has been bought or charged. This country and number type need the identity of the end user checked by our carrier. Call phone_numbers_read with action `kyc_fields` (same country and number_type) to see what is needed, collect it from the user, then call purchase_phone_number again with the SAME arguments and purchase_intent_id plus `values` (text and date fields) and `documents` (files). The number is paid then and stays pending_regulatory until the carrier approves it.",
    };
  }
  if (r.status === "pending_payment") {
    return {
      ...r,
      next_step:
        "Paid, and the order with our carrier is still being confirmed. Do not buy again: check phone_numbers_read `get` in a minute. It ends active (phone_number_activated webhook) or failed with the charge refunded, usually within about 15 minutes. Repeating the same purchase_intent_id returns this same number and never charges twice.",
    };
  }
  if (r.status === "pending_regulatory") {
    return {
      ...r,
      next_step:
        "Paid and waiting for our carrier's identity review. It becomes active when approved (phone_number_activated webhook, or check phone_numbers_read `get`). If declined (regulatory_declined, phone_number_declined webhook with the reason) the payment is kept and the monthly charge paused: read phone_numbers_read `kyc_review` and send the corrections with fix_phone_number_kyc `resubmit` (no second charge) before the number's remediation_deadline_at, and tell the user that date. With nothing fixed in 30 days, or if the number is released, the purchase is cancelled and refunded.",
    };
  }
  return result;
}

const documentField = z
  .object({
    filename: z.string().optional().describe("File name with its extension (.pdf, .jpg, .jpeg or .png). Default: the name of `path`."),
    content_base64: z.string().optional().describe("The file, base64-encoded."),
    path: z
      .string()
      .optional()
      .describe("Local servers only: path of the file on the user's machine, read and sent instead of content_base64."),
  })
  .describe("One identity document: content_base64 or path, PDF, JPG or PNG, up to 10 MB.");

type FileArg = { filename?: string; content_base64?: string; path?: string };
type ApiFile = { filename: string; content_base64: string };

/** One file as the API takes it: { filename, content_base64 }; a path only on a local server. */
async function resolveFile(client: UploadPostMcpClient, label: string, doc: FileArg): Promise<ApiFile> {
  if (doc.content_base64) return { filename: doc.filename ?? "document", content_base64: doc.content_base64 };
  if (!doc.path) throw new Error(`${label} needs content_base64 or path.`);
  if (!client.allowLocalFiles) {
    throw new Error(
      `${label}: this hosted server cannot read file paths. Send the file as content_base64 (the whole call must stay under 10 MB).`
    );
  }
  const bytes = await readFile(doc.path);
  return { filename: doc.filename ?? basename(doc.path), content_base64: bytes.toString("base64") };
}

/** `documents` as the API takes them: { requirement_id: { filename, content_base64 } }. */
async function resolveDocuments(
  client: UploadPostMcpClient,
  documents: Record<string, FileArg>
): Promise<Record<string, ApiFile>> {
  const out: Record<string, ApiFile> = {};
  for (const [requirementId, doc] of Object.entries(documents)) {
    out[requirementId] = await resolveFile(client, `documents.${requirementId}`, doc);
  }
  return out;
}

/** The replacement number is gone too: say what to send instead of leaving the model to buy again. */
export function remediationError(err: unknown): unknown {
  const message = err instanceof Error ? err.message : String(err);
  if (/phone_numbers_capacity/.test(message)) {
    return new Error(
      `${message} next_step: The payment is kept and nothing was charged again. A new order with our carrier is temporarily not possible: try fix_phone_number_kyc \`resubmit\` again later with the same corrections. Do not buy a new number.`
    );
  }
  if (!/phone_number_unavailable/.test(message)) return err;
  return new Error(
    `${message} next_step: The payment is kept and nothing was charged again. The number is no longer available from our carrier: find another one with phone_numbers_read search_available (same country and number_type, a price no higher than this one) and call fix_phone_number_kyc \`resubmit\` again with the same corrections plus phone_number set to it. Do not buy a new number.`
  );
}

const endUserField = z
  .object({
    type: z.enum(["individual", "business"]),
    first_name: z.string().min(1),
    last_name: z.string().min(1),
    business_name: z.string().optional().describe("Required for a business."),
    phone: z.string().min(1).describe("Contact phone in E.164, e.g. '+34600111222'."),
    email: z.string().optional(),
    address: z.object({
      street_address: z.string().min(1),
      extended_address: z.string().optional(),
      locality: z.string().min(1).describe("City."),
      administrative_area: z.string().optional().describe("State, province or region."),
      postal_code: z.string().min(1),
      country_code: z.string().length(2).describe("ISO country code. ES, DE, FR and IT numbers need an address in that country."),
    }),
  })
  .describe("Who will use the number, as the carrier requires it.");

export function registerPhoneNumberTools(server: McpServer, client: UploadPostMcpClient): RegisteredTool[] {
  const read = server.registerTool(
    "phone_numbers_read",
    {
      title: "Read Upload-Post phone numbers, SMS, calls and codes",
      description:
        "Upload-Post phone numbers: real numbers the account rents from Upload-Post to receive SMS and calls, verify WhatsApp Business on them and, outside the US and Canada, send SMS. Changes nothing. " +
        "config: whether the account can buy now (enabled, can_purchase, reason such as phone_numbers_paid_plan_required, phone_numbers_limit_reached or purchase_velocity), numbers_count / max_numbers, the countries on sale, and the current terms_version and terms_url that purchase_phone_number needs. " +
        "countries: countries and number types on sale, cheapest first, with the monthly price in cents of the account's billing currency (`currency`: usd, eur or gbp, the same amount in each, e.g. $4 = 4 EUR = 4 GBP, which is what is charged). Prices vary by country and number type: 1.5 times our carrier's monthly cost for that number, rounded up to the next whole unit, at least 3 and at most 30 (numbers that would cost more are not offered): e.g. a carrier cost of 2.40 gives 3.60, so 4 per month; 7.30 gives 10.95, so 11. Always read the real price here or in search_available, needs_kyc (identity documents required), sms (can receive) and sms_send (can send). " +
        "search_available (country required; number_type, area_code, locality, contains = digits the number must contain, sms: true = only numbers with SMS, limit 1-50, default 20): numbers that can be bought now with their monthly price in the billing currency. countries, search_available and purchases answer 409 phone_numbers_currency_unsupported when the account is billed in a currency phone numbers do not support. " +
        "kyc_fields (country, number_type): the end_user fields every purchase needs and the extra requirements of that country and type (requirement_id, label, kind text | date | address | file). " +
        "list (optional status, profile_username): the account's numbers, pending and active unless `status` says otherwise; each with id (`pn_...`), phone_number (E.164), country, number_type, features, status (pending_payment, pending_regulatory, active, regulatory_declined, failed, released, ported_out), suspended / abuse_review flags, monthly_cents and currency, voice settings, sms_send, whatsapp.verify_until, release_scheduled_at, and only while regulatory_declined declined_at and remediation_deadline_at (declined_at + 30 days: the last day to fix the review with fix_phone_number_kyc). get (number_id): one number. " +
        "messages (number_id, limit 1-200 default 50, before = ISO date for older ones): inbound and outbound SMS, newest first, with any codes found. messages, calls, codes and usage answer 400 phone_numbers_invalid_request for an invalid date or limit. " +
        "calls (number_id, limit, before): calls newest first (mode forward | voicemail | whatsapp_verify | missed), duration, voicemail transcript and a signed recording_url valid 1 hour. " +
        "codes (number_id, since = ISO date): one-time codes (4-8 digits, also spoken in English, Spanish or Portuguese) found in SMS and call transcripts of the last 30 minutes; poll it every few seconds while the user verifies WhatsApp. " +
        "usage (from, to: ISO dates, default this month so far): billable usage in the account's billing currency (`currency`), charged on the next subscription invoice (outbound SMS, forwarded minutes, recording and transcription; inbound minutes at cost; inbound SMS free): `lines` (number_id, phone_number, kind sms_outbound | forwarding | recording | transcription | inbound_minutes, quantity, unit, amount, billed, created_at), `totals` per kind { quantity, amount }, `total`, and `today` against the account's `daily_cap`; over the daily usage limit, outbound SMS, forwarding and recording stop until midnight UTC. " +
        "port_out_info (number_id): what the user gives another carrier to move the number there (name and address as submitted, account number, the number); owner only, and only for the user who is moving it. " +
        "kyc_review (number_id; owner only): for a number in pending_regulatory or regulatory_declined (otherwise 409 phone_number_not_remediable), our carrier's review status (group_status, decline_reason, reasons), each requirement with its status and needs_fix: true when it must be sent again, `fields` to send again (same shape as kyc_fields) and the reviewer thread `comments` (from reviewer | you, body, created_at); fix it with fix_phone_number_kyc. " +
        "kyc_links (owner only): the account's shareable KYC links (manage_phone_kyc_links), newest first: id (`kl_...`), profile_username, country, number_type, phone_number, status active | used | expired | revoked, created_at, expires_at, used_at, revoked_at and number_id (the number a used link bought). The link url is only returned when it is created. " +
        DECLINED_RULE +
        "Webhooks (opt-in, list them in webhook_events or a webhook subscription): sms_received, call_received, voicemail_received, phone_number_activated, phone_number_declined, phone_number_released, phone_number_port_out, phone_number_kyc_comment (the carrier's reviewer wrote a comment, one event each), phone_number_kyc_resubmitted (corrections sent, back to pending_regulatory). " +
        PHONE_RULES +
        PHONE_AVAILABILITY,
      inputSchema: {
        action: actionEnum(READ_ROUTES),
        number_id: numberIdField.optional().describe("get, messages, calls, codes, port_out_info, kyc_review: the number's id (`pn_...`)."),
        country: countryField.optional().describe("search_available (required) and kyc_fields: ISO country code, e.g. 'ES'."),
        number_type: numberTypeField.optional(),
        area_code: z.string().optional().describe("search_available: national destination code (area code)."),
        locality: z.string().optional().describe("search_available: city."),
        contains: z.string().optional().describe("search_available: digits the number must contain."),
        sms: z.boolean().optional().describe("search_available: true = only numbers that receive SMS."),
        status: z
          .enum(["pending_payment", "pending_regulatory", "active", "regulatory_declined", "failed", "released", "ported_out"])
          .optional()
          .describe("list: only numbers in this status."),
        profile_username: z.string().optional().describe("list: only numbers of this Upload-Post profile."),
        limit: z.number().int().min(1).max(200).optional().describe("search_available: 1-50 (default 20). messages / calls: 1-200 (default 50)."),
        before: z.string().optional().describe("messages / calls: ISO date, only older items (pagination)."),
        since: z.string().optional().describe("codes: ISO date, only codes received after it."),
        from: z.string().optional().describe("usage: ISO date (default: start of the month)."),
        to: z.string().optional().describe("usage: ISO date (default: now)."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Read Upload-Post phone numbers",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const action = (args as { action: string }).action;
      const fields = pick(mergeArgs(args as Record<string, unknown>), READ_FIELDS[action]);
      if (action === "search_available" && !fields.country) throw new Error("`country` is required for search_available.");
      return callRoute(client, READ_ROUTES[action], fields);
    })
  );

  const purchase = server.registerTool(
    "purchase_phone_number",
    {
      title: "Buy an Upload-Post phone number",
      description:
        "Buy a phone number for a profile. It costs money: the monthly price, which varies by country and number type (1.5 times our carrier's monthly cost for that number, rounded up to the next whole unit, at least 3 and at most 30 (numbers that would cost more are not offered): e.g. a carrier cost of 2.40 gives 3.60, so 4 per month; 7.30 gives 10.95, so 11; in the account's billing currency, USD, EUR or GBP, the same amount in each; read the real price in phone_numbers_read search_available / countries, never assume one; no setup fee) is charged on the account's subscription at once, prorated, and then on every renewal until the number is released (annual plans pay 12 months). Usage (outbound SMS, forwarding, recording, transcription) is billed on the next invoice. Buying and the identity step take the account's API key or the owner's own session, never a profile JWT. " +
        "Before calling: read phone_numbers_read `config` (can_purchase, terms_version, terms_url), pick the number with search_available, tell the user the price, and have them read and accept the terms at terms_url (no emergency calls, acceptable use, porting authorization, carrier data processing in the US). " +
        "end_user is the person or business that will use the number, as our carrier needs it: type individual | business, first_name, last_name, business_name (business), phone (E.164), email, address { street_address, extended_address, locality, administrative_area, postal_code, country_code }. Spanish, German, French and Italian numbers need an address in that country (local numbers: in the area code's region). " +
        "purchase_intent_id is your idempotency key (8-100 characters: letters, digits, _ - . :): make one up once per number you mean to buy and reuse it on every retry of that purchase; the same id never charges twice and returns the same number. Use a new id only to retry a purchase that failed. " +
        "Answers: 200 status active (bought). 202 status kyc_required: nothing charged yet; the country needs identity documents: read phone_numbers_read `kyc_fields`, collect them from the user and call this tool again with the same arguments plus `values` and `documents` (then it is sent to POST /kyc). 202 pending_payment: paid, the order with our carrier is still being confirmed; it ends active (phone_number_activated webhook) or failed with the charge refunded, usually within about 15 minutes: check phone_numbers_read `get` and do not buy again (repeating the same purchase_intent_id returns the same number). 202 pending_regulatory: paid, our carrier is reviewing the identity; it turns active when approved. " +
        "Consumers: when end_user.type is individual, every purchase (and the identity step) needs immediate_start_consent: true, the end user's express request to start the service now within the 14-day withdrawal period; it is ignored for a business. Before setting it, show the user this text and ask whether they agree: \"" +
        IMMEDIATE_START_CONSENT_TEXT +
        "\" Without it nothing is sent (400 immediate_start_consent_required, whose body carries consent_text and terms_url). A consumer who withdraws within the 14 days does it through Upload-Post support: the number is released and the part not provided is refunded. " +
        DECLINED_RULE +
        "To let the end user fill in their own identity and documents instead, create a shareable KYC link with manage_phone_kyc_links. " +
        "Errors: 400 terms_not_accepted (send accept_terms: true and the current terms_version), immediate_start_consent_required, phone_numbers_kyc_invalid, phone_numbers_country_not_available, phone_numbers_type_not_offered; 402 phone_numbers_paid_plan_required (relay `upgrade_url`) or phone_numbers_payment_failed; 403 phone_numbers_account_suspended; 404 profile_not_found; 409 purchase_velocity (one purchase every 10 minutes), phone_numbers_limit_reached (5 numbers per account by default), phone_number_unavailable (taken: search again), phone_numbers_currency_unsupported; 429 phone_numbers_rate_limited (honour Retry-After); 502 phone_numbers_carrier_error (the carrier refused the order, the charge was refunded); 503 phone_numbers_capacity. " +
        "Countries in this first version: US, GB, ES, FR, DE, IT, MX, BR; types local, mobile, national (no toll-free). " +
        OWNER_ONLY +
        PHONE_RULES +
        PHONE_AVAILABILITY,
      inputSchema: {
        profile_username: z.string().min(1).describe("Upload-Post profile the number belongs to (from list_users)."),
        country: countryField,
        number_type: numberTypeField,
        phone_number: z.string().optional().describe("A number from phone_numbers_read search_available, in E.164. Omit to take the first available one."),
        area_code: z.string().optional().describe("Without phone_number: take the first available number in this area code."),
        purchase_intent_id: z
          .string()
          .min(8)
          .max(100)
          .regex(/^[A-Za-z0-9_.:-]+$/)
          .describe("Idempotency key for this purchase (8-100 characters: letters, digits, _ - . :). Reuse it on retries; a new one buys another number."),
        end_user: endUserField,
        accept_terms: z
          .literal(true)
          .describe("true, only after the user has read and accepted the terms at `terms_url` (phone_numbers_read config)."),
        terms_version: z.string().min(1).describe("The `terms_version` from phone_numbers_read config, e.g. '2026-11-28'."),
        immediate_start_consent: z
          .boolean()
          .optional()
          .describe(
            "Required true when end_user.type is individual (ignored for a business): set it only after showing the user the consent text in this tool's description and they agreed to start the service now within the 14-day withdrawal period."
          ),
        values: z
          .record(z.string())
          .optional()
          .describe("Identity step only (after 202 kyc_required): { requirement_id: value } for the text and date requirements of kyc_fields."),
        documents: z
          .record(documentField)
          .optional()
          .describe("Identity step only (after 202 kyc_required): { requirement_id: { filename, content_base64 | path } } for the file requirements of kyc_fields (ID or passport, company certificate, proof of address under 3 months…)."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Buy an Upload-Post phone number",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const { values, documents, ...body } = args as Record<string, unknown> & {
        values?: Record<string, string>;
        documents?: Record<string, FileArg>;
      };
      if (needsImmediateStartConsent(body)) throw new Error(CONSENT_REFUSAL);
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(body)) if (v !== undefined) fields[k] = v;
      if (values === undefined && documents === undefined) {
        return purchaseNextStep(await client.request("POST", `${P}/purchase`, { body: fields }));
      }
      const kycBody = {
        ...fields,
        ...(values !== undefined ? { values } : {}),
        ...(documents !== undefined ? { documents: await resolveDocuments(client, documents) } : {}),
      };
      return purchaseNextStep(await client.request("POST", `${P}/kyc`, { body: kycBody }));
    })
  );

  const sms = server.registerTool(
    "send_sms",
    {
      title: "Send an SMS from an Upload-Post phone number",
      description:
        "Send an SMS from one of the account's Upload-Post phone numbers (phone_numbers_read `list`: the number must be active and have sms_send: true). Billed per message part on the next subscription invoice. " +
        "US and Canadian numbers cannot send SMS yet (403 sms_registration_required; they still receive), and some numbers have no SMS at all (403 sms_not_supported). " +
        "Recipients who replied STOP cannot be messaged (409 recipient_opted_out); at most 10 messages per recipient per 24 h (429 sms_recipient_limit) and 1 per second per number (429 sms_rate_limited); spam, adult, gambling, drugs, crypto and loan content is refused (422 sms_content_blocked). Over the account's daily usage limit (429 phone_usage_daily_cap) sending stops until midnight UTC. Other errors: 403 phone_number_suspended, 409 phone_number_not_active. " +
        "Replies arrive in phone_numbers_read `messages` and in the sms_received webhook. " +
        PHONE_AVAILABILITY,
      inputSchema: {
        number_id: numberIdField.describe("The Upload-Post number to send from (`pn_...`)."),
        to: z.string().min(1).describe("Recipient in E.164, e.g. '+34600111222'."),
        text: z.string().min(1).max(1600).describe("Message text (up to 1600 characters; long texts go as several billed parts)."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Send an SMS",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const { number_id, to, text } = args as { number_id: string; to: string; text: string };
      return client.request("POST", `${P}/${encodeURIComponent(number_id)}/sms`, { body: { to, text } });
    })
  );

  const manage = server.registerTool(
    "manage_phone_number",
    {
      title: "Set up an Upload-Post phone number: calls and WhatsApp verification",
      description:
        "Settings of one of the account's active Upload-Post phone numbers. " +
        "update_voice (only what you send changes): forward_to = a phone number to forward incoming calls to ('tel:+E164' or '+E164'; null stops forwarding), only geographic or mobile numbers in the number's country or the end user's country (400 phone_numbers_forward_country_not_allowed); forwarded calls show the Upload-Post number as caller ID; at most 60 minutes per call and 4 hours per 24 h per number. voicemail_enabled, voicemail_greeting (up to 500 characters), recording_enabled, transcription_enabled, transcription_language (en, es, pt, fr, de, it). Voicemail always tells the caller the call is recorded and transcribed; with recording off, calls are only logged as missed. " +
        "prepare_whatsapp (language, default en): connect WhatsApp Business on this number. There are no pre-verified numbers: for the next 30 minutes calls to the number are answered, recorded (up to 90 s) and transcribed so the code Meta reads out shows up. Steps: 1) prepare_whatsapp; 2) the user opens the WhatsApp connection (get_connect_link with platforms ['whatsapp']), adds this number in Meta's window and chooses **Phone call** (not SMS) to receive the code; 3) poll phone_numbers_read `codes` every few seconds and give the user the code to type in Meta's window. 409 phone_number_not_active, 403 phone_number_suspended. " +
        "These numbers cannot make outbound calls or call emergency services (112 / 911). " +
        PHONE_AVAILABILITY,
      inputSchema: {
        action: actionEnum(MANAGE_ROUTES),
        number_id: numberIdField,
        forward_to: z.string().nullable().optional().describe("update_voice: 'tel:+34600111222' (or '+34600111222'); null stops forwarding."),
        voicemail_enabled: z.boolean().optional().describe("update_voice."),
        voicemail_greeting: z.string().max(500).optional().describe("update_voice: greeting read to callers."),
        recording_enabled: z.boolean().optional().describe("update_voice."),
        transcription_enabled: z.boolean().optional().describe("update_voice."),
        transcription_language: languageEnum.optional().describe("update_voice: language of the transcripts."),
        language: languageEnum.optional().describe("prepare_whatsapp: the language Meta's call is expected in (default en)."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Set up an Upload-Post phone number",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const action = (args as { action: string }).action;
      const fields = pick(mergeArgs(args as Record<string, unknown>), MANAGE_FIELDS[action]);
      if ("forward_to" in fields) fields.forward_to = normalizeForwardTo(fields.forward_to);
      return callRoute(client, MANAGE_ROUTES[action], fields);
    })
  );

  const release = server.registerTool(
    "release_phone_number",
    {
      title: "Release an Upload-Post phone number",
      description:
        "Give an Upload-Post phone number back. It is FINAL and cannot be undone: the number stops receiving SMS and calls, WhatsApp and anything else verified on it stop working, and the carrier may give it to someone else later. The monthly charge stops (no refund for the rest of the period); releasing a number whose identity review was declined (regulatory_declined) cancels the purchase and refunds it instead. To keep the number with another carrier, use phone_numbers_read `port_out_info` instead of releasing it. " +
        "Needs `confirm: true`, set only after the user approved releasing that exact number; without it the API answers 400 confirmation_required and nothing changes. 404 phone_number_not_found. " +
        "When the subscription is cancelled or ends, numbers are suspended at once and released after a 7-day grace period (the user gets an email warning). " +
        OWNER_ONLY +
        PHONE_AVAILABILITY,
      inputSchema: {
        number_id: numberIdField,
        confirm: z
          .boolean()
          .optional()
          .describe("The API's confirmation: must be true, after the user approved releasing this number. Without it nothing is released."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Release an Upload-Post phone number",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const { number_id, confirm } = args as { number_id: string; confirm?: boolean };
      return client.request("DELETE", `${P}/${encodeURIComponent(number_id)}`, {
        query: confirm === true ? { confirm: true } : {},
      });
    })
  );

  const fixKyc = server.registerTool(
    "fix_phone_number_kyc",
    {
      title: "Fix the identity review of an Upload-Post phone number",
      description:
        "Fix our carrier's identity review of a number in pending_regulatory or regulatory_declined (otherwise 409 phone_number_not_remediable), without paying again. Read phone_numbers_read `kyc_review` first: it says which requirements were declined (needs_fix), the fields to send again and the reviewer's comments. " +
        "resubmit (number_id): send ONLY what changes: `values` (text and date requirements), `documents` (file requirements) and/or `end_user` (the whole end user again, with the new address); at least one of them (400 phone_numbers_kyc_invalid when there is nothing to fix or a correction is invalid). The review is updated and submitted again and the number goes back to pending_regulatory (phone_number_kyc_resubmitted webhook; its `order` says whether the same order was kept, the same number ordered again or a replacement ordered). It never charges again. If our carrier cancelled the order, the same number is ordered again; if that number is gone, the API answers 409 phone_number_unavailable with keeps_payment: true: pick another number of the same country and number_type, at no higher price, with phone_numbers_read search_available and resubmit with `phone_number` set to it (409 phone_numbers_type_not_offered when the replacement costs more). 409 phone_number_remediation_in_progress: another correction for this number is being sent; wait and read `kyc_review` before trying again. 503 phone_numbers_capacity: a new order with our carrier is temporarily not possible; the payment is kept, try again later and do not buy again. In the answer, `order` is same_order, already_ordered, new_order, new_order_other_number or order_unknown (our carrier did not confirm the new order in time; it is resolved automatically and no second order is placed). " +
        "reply (number_id, text up to 2000 characters, optional attachments): answer the reviewer; the message joins the thread shown in `kyc_review` (phone_number_kyc_comment webhook when the reviewer writes). 400 phone_numbers_invalid_request for an empty or too long text. " +
        "Files: PDF, JPG or PNG up to 10 MB, as content_base64; a file path only works on a local server (the hosted server refuses paths). 404 phone_number_not_found, 502 phone_numbers_carrier_error (our carrier did not answer or refused the corrections). " +
        DECLINED_RULE +
        OWNER_ONLY +
        PHONE_AVAILABILITY,
      inputSchema: {
        action: z.enum(["resubmit", "reply"]),
        number_id: numberIdField,
        values: z
          .record(z.string())
          .optional()
          .describe("resubmit: { requirement_id: value } for the corrected text and date requirements of kyc_review."),
        documents: z
          .record(documentField)
          .optional()
          .describe("resubmit: { requirement_id: { filename, content_base64 | path } } for the file requirements to send again."),
        end_user: endUserField.optional().describe("resubmit: the end user again, complete, with the corrected address."),
        phone_number: z
          .string()
          .optional()
          .describe("resubmit, only after 409 phone_number_unavailable: another available number (E.164) of the same country and number_type, at no higher price."),
        text: z.string().min(1).max(2000).optional().describe("reply: the message to the reviewer (up to 2000 characters)."),
        attachments: z.array(documentField).max(10).optional().describe("reply: files for the reviewer, each { filename, content_base64 | path }."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Fix a phone number's identity review",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const a = args as {
        action: "resubmit" | "reply";
        number_id: string;
        values?: Record<string, string>;
        documents?: Record<string, FileArg>;
        end_user?: Record<string, unknown>;
        phone_number?: string;
        text?: string;
        attachments?: FileArg[];
      };
      const base = `${P}/${encodeURIComponent(a.number_id)}/remediate`;
      if (a.action === "reply") {
        if (!a.text) throw new Error("`text` is required for reply.");
        const body: Record<string, unknown> = { text: a.text };
        if (a.attachments?.length) {
          body.attachments = await Promise.all(a.attachments.map((f, i) => resolveFile(client, `attachments[${i}]`, f)));
        }
        return client.request("POST", `${base}/reply`, { body });
      }
      if (a.values === undefined && a.documents === undefined && a.end_user === undefined) {
        throw new Error("resubmit needs at least one correction: `values`, `documents` or `end_user`.");
      }
      const body: Record<string, unknown> = {};
      if (a.values !== undefined) body.values = a.values;
      if (a.documents !== undefined) body.documents = await resolveDocuments(client, a.documents);
      if (a.end_user !== undefined) body.end_user = a.end_user;
      if (a.phone_number !== undefined) body.phone_number = a.phone_number;
      try {
        return await client.request("POST", base, { body });
      } catch (err) {
        throw remediationError(err);
      }
    })
  );

  const kycLinks = server.registerTool(
    "manage_phone_kyc_links",
    {
      title: "Create or revoke shareable KYC links for Upload-Post phone numbers",
      description:
        "Shareable KYC links: a white-label page (no login) where the integrator's end user fills in their own identity and documents for one phone number and accepts the phone number terms; when they submit it, the number is BOUGHT AND BILLED TO THIS ACCOUNT (the monthly price, prorated now and on every renewal until it is released; read the price with phone_numbers_read search_available or countries and tell the user before creating one). List them with phone_numbers_read `kyc_links`. " +
        "create (profile_username, country, number_type, redirect_url required; optional phone_number from search_available, branding { company_name up to 80 characters, logo_url https, brand_color #RRGGBB }, language en | es | pt-BR, default en): returns id (`kl_...`), url (the hosted page to send to the end user, shown only now), token and expires_at. Single use, valid 7 days; anyone with the url can submit it, so send it only to that end user. After submitting, the page sends the end user to redirect_url with ?kyc=submitted&country=XX, and the number shows up in phone_numbers_read `list` (and as number_id in `kyc_links`) in pending_regulatory until our carrier approves it. The paid plan is checked now and again when the page is submitted (402 phone_numbers_paid_plan_required, relay `upgrade_url`); problems the end user cannot fix (plan, limits…) show on the page as phone_kyc_link_unavailable and the link stays active. At most 20 active links (409 phone_kyc_links_limit). Other errors: 400 phone_numbers_invalid_request, phone_numbers_country_not_available, phone_numbers_type_not_offered; 404 profile_not_found; 409 phone_numbers_currency_unsupported. " +
        "revoke (link_id): the link stops working at once (the page answers phone_kyc_link_revoked); it cannot be undone. A link already used cannot be revoked (409 phone_kyc_link_used): release the number with release_phone_number instead. 404 phone_kyc_link_not_found. " +
        "An individual end user also gives the immediate-start consent (to start the service now within the 14-day withdrawal period) on the page. The page itself is for the end user only: no tool fills it in. Guide: https://docs.upload-post.com/guides/phone-number-kyc-link. " +
        OWNER_ONLY +
        PHONE_RULES +
        PHONE_AVAILABILITY,
      inputSchema: {
        action: z.enum(["create", "revoke"]),
        profile_username: z.string().min(1).optional().describe("create: Upload-Post profile the number will belong to (from list_users)."),
        country: countryField.optional().describe("create: ISO country code of the number, e.g. 'ES'."),
        number_type: numberTypeField.optional().describe("create: local, mobile or national."),
        phone_number: z.string().optional().describe("create: a specific number from phone_numbers_read search_available (E.164). Omit to take the first available one."),
        branding: z
          .object({
            company_name: z.string().max(80).optional(),
            logo_url: z.string().optional().describe("https URL of the logo."),
            brand_color: z
              .string()
              .regex(/^#[0-9A-Fa-f]{6}$/)
              .optional()
              .describe("#RRGGBB, e.g. '#4F46E5'."),
          })
          .optional()
          .describe("create: how the page looks to the end user (the integrator's brand)."),
        redirect_url: z.string().optional().describe("create: https URL the end user is sent to after submitting (?kyc=submitted&country=XX is added)."),
        language: z.enum(["en", "es", "pt-BR"]).optional().describe("create: language of the page (default en)."),
        link_id: z.string().min(1).optional().describe("revoke: the link's id (`kl_...`) from create or phone_numbers_read `kyc_links`."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Create or revoke phone number KYC links",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const a = args as Record<string, unknown> & { action: "create" | "revoke"; link_id?: string };
      if (a.action === "revoke") {
        if (!a.link_id) throw new Error("`link_id` is required for revoke.");
        return client.request("DELETE", `${P}/kyc/share/${encodeURIComponent(a.link_id)}`);
      }
      const body = pick(a, ["profile_username", "country", "number_type", "phone_number", "branding", "redirect_url", "language"]);
      const missing = ["profile_username", "country", "number_type", "redirect_url"].filter((k) => body[k] === undefined);
      if (missing.length) throw new Error(`create needs ${missing.map((k) => `\`${k}\``).join(", ")}.`);
      return client.request("POST", `${P}/kyc/share`, { body });
    })
  );

  return [read, purchase, sms, manage, release, fixKyc, kycLinks];
}
