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
 * undone, so each carries its own annotations and confirmation step.
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

const PHONE_RULES =
  "Paid plans only (an active subscription with at least one paid invoice; trials and the Free plan get 402 phone_numbers_paid_plan_required with an `upgrade_url` to relay). " +
  "These numbers cannot make outbound calls and can NEVER call emergency services (112 / 911). US and Canadian numbers receive SMS but cannot send SMS yet (403 sms_registration_required); some Spanish, German and Italian numbers have no SMS at all. ";

const OWNER_ONLY =
  "Team members acting on the owner's account cannot buy, send identity documents, release or read port-out details (403 phone_numbers_owner_only): only the owner or an Admin can. ";

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
        "Paid and waiting for our carrier's identity review. It becomes active when approved (phone_number_activated webhook, or check phone_numbers_read `get`); if declined the charge is refunded (phone_number_declined webhook with the reason).",
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

/** `documents` as the API takes them: { requirement_id: { filename, content_base64 } }. */
async function resolveDocuments(
  client: UploadPostMcpClient,
  documents: Record<string, { filename?: string; content_base64?: string; path?: string }>
): Promise<Record<string, { filename: string; content_base64: string }>> {
  const out: Record<string, { filename: string; content_base64: string }> = {};
  for (const [requirementId, doc] of Object.entries(documents)) {
    if (doc.content_base64) {
      out[requirementId] = { filename: doc.filename ?? "document", content_base64: doc.content_base64 };
      continue;
    }
    if (!doc.path) throw new Error(`documents.${requirementId} needs content_base64 or path.`);
    if (!client.allowLocalFiles) {
      throw new Error(
        `documents.${requirementId}: this hosted server cannot read file paths. Send the file as content_base64 (the whole call must stay under 10 MB).`
      );
    }
    const bytes = await readFile(doc.path);
    out[requirementId] = { filename: doc.filename ?? basename(doc.path), content_base64: bytes.toString("base64") };
  }
  return out;
}

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
        "list (optional status, profile_username): the account's numbers, pending and active unless `status` says otherwise; each with id (`pn_...`), phone_number (E.164), country, number_type, features, status (pending_payment, pending_regulatory, active, regulatory_declined, failed, released, ported_out), suspended / abuse_review flags, monthly_cents and currency, voice settings, sms_send, whatsapp.verify_until, release_scheduled_at. get (number_id): one number. " +
        "messages (number_id, limit 1-200 default 50, before = ISO date for older ones): inbound and outbound SMS, newest first, with any codes found. messages, calls, codes and usage answer 400 phone_numbers_invalid_request for an invalid date or limit. " +
        "calls (number_id, limit, before): calls newest first (mode forward | voicemail | whatsapp_verify | missed), duration, voicemail transcript and a signed recording_url valid 1 hour. " +
        "codes (number_id, since = ISO date): one-time codes (4-8 digits, also spoken in English, Spanish or Portuguese) found in SMS and call transcripts of the last 30 minutes; poll it every few seconds while the user verifies WhatsApp. " +
        "usage (from, to: ISO dates, default this month so far): billable usage in the account's billing currency (`currency`), charged on the next subscription invoice (outbound SMS, forwarded minutes, recording and transcription; inbound minutes at cost; inbound SMS free): `lines` (number_id, phone_number, kind sms_outbound | forwarding | recording | transcription | inbound_minutes, quantity, unit, amount, billed, created_at), `totals` per kind { quantity, amount }, `total`, and `today` against the account's `daily_cap`; over the daily usage limit, outbound SMS, forwarding and recording stop until midnight UTC. " +
        "port_out_info (number_id): what the user gives another carrier to move the number there (name and address as submitted, account number, the number); owner only, and only for the user who is moving it. " +
        "Webhooks (opt-in, list them in webhook_events or a webhook subscription): sms_received, call_received, voicemail_received, phone_number_activated, phone_number_declined, phone_number_released, phone_number_port_out. " +
        PHONE_RULES +
        PHONE_AVAILABILITY,
      inputSchema: {
        action: actionEnum(READ_ROUTES),
        number_id: numberIdField.optional().describe("get, messages, calls, codes, port_out_info: the number's id (`pn_...`)."),
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
        "Answers: 200 status active (bought). 202 status kyc_required: nothing charged yet; the country needs identity documents: read phone_numbers_read `kyc_fields`, collect them from the user and call this tool again with the same arguments plus `values` and `documents` (then it is sent to POST /kyc). 202 pending_payment: paid, the order with our carrier is still being confirmed; it ends active (phone_number_activated webhook) or failed with the charge refunded, usually within about 15 minutes: check phone_numbers_read `get` and do not buy again (repeating the same purchase_intent_id returns the same number). 202 pending_regulatory: paid, our carrier is reviewing the identity; it turns active when approved, and a declined review is refunded (phone_number_declined webhook). " +
        "Errors: 400 terms_not_accepted (send accept_terms: true and the current terms_version), phone_numbers_kyc_invalid, phone_numbers_country_not_available, phone_numbers_type_not_offered; 402 phone_numbers_paid_plan_required (relay `upgrade_url`) or phone_numbers_payment_failed; 403 phone_numbers_account_suspended; 404 profile_not_found; 409 purchase_velocity (one purchase every 10 minutes), phone_numbers_limit_reached (5 numbers per account by default), phone_number_unavailable (taken: search again), phone_numbers_currency_unsupported; 429 phone_numbers_rate_limited (honour Retry-After); 502 phone_numbers_carrier_error (the carrier refused the order, the charge was refunded); 503 phone_numbers_capacity. " +
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
        end_user: z
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
          .describe("Who will use the number, as the carrier requires it."),
        accept_terms: z
          .literal(true)
          .describe("true, only after the user has read and accepted the terms at `terms_url` (phone_numbers_read config)."),
        terms_version: z.string().min(1).describe("The `terms_version` from phone_numbers_read config."),
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
        documents?: Record<string, { filename?: string; content_base64?: string; path?: string }>;
      };
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
        "Give an Upload-Post phone number back. It is FINAL and cannot be undone: the number stops receiving SMS and calls, WhatsApp and anything else verified on it stop working, and the carrier may give it to someone else later. The monthly charge stops (no refund for the rest of the period). To keep the number with another carrier, use phone_numbers_read `port_out_info` instead of releasing it. " +
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

  return [read, purchase, sms, manage, release];
}
