import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { genericResultOutputSchema, safe } from "../schemas.js";
import { mergeArgs, paramsField, type Method } from "./resource.js";

/**
 * WhatsApp Business (the customer's own number, Cloud API) beyond send_dm and
 * list_dm_conversations: message templates (the only way to write after the
 * 24 h window), the public business profile and the chat QR codes / links.
 * The API reads `user` / `platform` from the JSON body on POST and from the
 * query string on GET and DELETE.
 */

interface WaRoute {
  method: Method;
  path: string;
  /** Sent on every call of the action. */
  fixed?: Record<string, unknown>;
}

const TEMPLATE_ROUTES: Record<string, WaRoute> = {
  list: { method: "GET", path: "/uploadposts/dms/templates", fixed: { platform: "whatsapp" } },
  create: { method: "POST", path: "/uploadposts/dms/templates", fixed: { platform: "whatsapp" } },
  delete: { method: "DELETE", path: "/uploadposts/dms/templates", fixed: { platform: "whatsapp" } },
  edit: { method: "PATCH", path: "/uploadposts/dms/templates", fixed: { platform: "whatsapp" } },
  library: { method: "GET", path: "/uploadposts/dms/whatsapp/templates/library" },
};

const W = "/uploadposts/dms/whatsapp";
const NUMBER_ROUTES: Record<string, WaRoute> = {
  list_blocked: { method: "GET", path: `${W}/blocked` },
  block_users: { method: "POST", path: `${W}/blocked` },
  unblock_users: { method: "DELETE", path: `${W}/blocked` },
  get_automation: { method: "GET", path: `${W}/automation` },
  set_automation: { method: "POST", path: `${W}/automation` },
  get_number: { method: "GET", path: `${W}/number` },
  request_display_name: { method: "POST", path: `${W}/number`, fixed: { action: "request_display_name" } },
  apply_display_name: { method: "POST", path: `${W}/number`, fixed: { action: "apply_display_name" } },
  change_pin: { method: "POST", path: `${W}/number`, fixed: { action: "change_pin" } },
  analytics: { method: "GET", path: `${W}/analytics` },
  enable_template_insights: { method: "POST", path: `${W}/analytics`, fixed: { action: "enable_template_insights" } },
};

const FLOW_ROUTES: Record<string, WaRoute> = {
  list: { method: "GET", path: `${W}/flows` },
  create: { method: "POST", path: `${W}/flows` },
  get: { method: "GET", path: `${W}/flows/{flow_id}` },
  update: { method: "POST", path: `${W}/flows/{flow_id}` },
  get_json: { method: "GET", path: `${W}/flows/{flow_id}/json` },
  upload_json: { method: "POST", path: `${W}/flows/{flow_id}/json` },
  publish: { method: "POST", path: `${W}/flows/{flow_id}/publish` },
  deprecate: { method: "POST", path: `${W}/flows/{flow_id}/deprecate` },
  delete: { method: "DELETE", path: `${W}/flows/{flow_id}` },
};

const BUSINESS_ROUTES: Record<string, WaRoute> = {
  get_profile: { method: "GET", path: "/uploadposts/dms/whatsapp/profile" },
  update_profile: { method: "POST", path: "/uploadposts/dms/whatsapp/profile" },
  list_qr_codes: { method: "GET", path: "/uploadposts/dms/whatsapp/qr" },
  create_qr_code: { method: "POST", path: "/uploadposts/dms/whatsapp/qr" },
  delete_qr_code: { method: "DELETE", path: "/uploadposts/dms/whatsapp/qr" },
};

const actionEnum = (routes: Record<string, WaRoute>) => z.enum(Object.keys(routes) as [string, ...string[]]);
const userField = z.string().describe("Upload-Post profile name with WhatsApp connected.");

const WHATSAPP_AVAILABILITY =
  "WhatsApp is available to every account: the profile needs its WhatsApp Business number connected (get_connect_link with platforms ['whatsapp']), otherwise the API answers 400 with how to connect it; 401 whatsapp_reauth_required means reconnect it. ";

/** Query values as the API reads them: lists comma-separated, objects as JSON. */
function toQuery(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) out[k] = v.join(",");
    else if (typeof v === "object") out[k] = JSON.stringify(v);
    else out[k] = v;
  }
  return out;
}

function runWa(client: UploadPostMcpClient, routes: Record<string, WaRoute>) {
  return safe(async (args) => {
    const { confirmed: _confirmed, ...rest } = args as Record<string, unknown>;
    const route = routes[(args as { action: string }).action];
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries({ ...mergeArgs(rest), ...(route.fixed ?? {}) })) {
      if (v !== undefined) fields[k] = v;
    }
    const path = route.path.replace(/\{(\w+)\}/g, (_, name: string) => {
      const value = fields[name];
      delete fields[name];
      if (value === undefined || value === null || value === "") throw new Error(`\`${name}\` is required for this action.`);
      return encodeURIComponent(String(value));
    });
    // Block and unblock take a JSON body on DELETE too (the list of users).
    if (route.method === "GET" || (route.method === "DELETE" && fields.users === undefined)) {
      return client.request(route.method, path, { query: toQuery(fields) });
    }
    return client.request(route.method, path, { body: fields });
  });
}

export function registerWhatsappTools(server: McpServer, client: UploadPostMcpClient): RegisteredTool[] {
  const templates = server.registerTool(
    "manage_whatsapp_templates",
    {
      title: "Manage WhatsApp message templates",
      description:
        "Message templates of the profile's WhatsApp Business account. A template approved by Meta is the ONLY way to write to someone more than 24 h after their last message: send it with send_dm (platform 'whatsapp', `template` { name, language, components }). " +
        "list (optional status APPROVED|PENDING|REJECTED|PAUSED|DISABLED, name, limit 1-200): each with id, name, status, category, language, components, quality_score, rejected_reason. " +
        "create (name: lowercase letters, numbers and underscores; category UTILITY (default) | MARKETING | AUTHENTICATION; language, default 'en_US'; and either Meta's `components` list or the shorthand `body` text with {{1}}, {{2}}… variables plus `examples` (sample values Meta requires for them), `header` (text), `footer` and `buttons` [{ text, url? | phone_number? }], a button with neither is a quick reply): Meta reviews it, status PENDING until it is APPROVED or REJECTED (minutes to a day); MARKETING templates are billed higher by Meta, to the customer's own WhatsApp Business account. " +
        "delete (name; every language of that template goes, cannot be undone). " +
        "edit (template_id; an APPROVED, REJECTED or PAUSED template): category, components (they replace all of them) and/or message_send_ttl_seconds (how long WhatsApp keeps trying to deliver it: UTILITY 30-43200, AUTHENTICATION 30-900, -1 = 30 days; with only the TTL also send current_category); Meta allows 10 edits per 30 days and 1 per 24 h for an approved one. " +
        "library (search, topic, usecase, industry, language, after): Meta's pre-written UTILITY templates; create one with create + library_template_name (and library_template_button_inputs / library_template_body_inputs in Meta's format). create also takes message_send_ttl_seconds. " +
        WHATSAPP_AVAILABILITY,
      inputSchema: {
        action: actionEnum(TEMPLATE_ROUTES),
        user: userField,
        name: z.string().optional().describe("Template name. Required for create and delete; a filter for list."),
        status: z.string().optional().describe("list: only templates in this status (APPROVED, PENDING, REJECTED, PAUSED, DISABLED)."),
        limit: z.number().int().min(1).max(200).optional().describe("list: templates per call (default 100)."),
        category: z.enum(["UTILITY", "MARKETING", "AUTHENTICATION"]).optional().describe("create: default UTILITY. edit: the new category."),
        language: z.string().optional().describe("create: template language code, e.g. 'en_US', 'es_ES' (default en_US)."),
        body: z.string().optional().describe("create shorthand: the body text, with {{1}}, {{2}}… for variables."),
        examples: z.array(z.string()).optional().describe("create shorthand: one sample value per body variable, in order (Meta rejects variables without samples)."),
        header: z.string().max(60).optional().describe("create shorthand: text header (max 60 characters)."),
        footer: z.string().max(60).optional().describe("create shorthand: footer (max 60 characters)."),
        buttons: z
          .array(z.record(z.unknown()))
          .max(10)
          .optional()
          .describe("create shorthand: up to 10 buttons { text (max 25), url? | phone_number? }; with neither it is a quick-reply button."),
        components: z
          .array(z.record(z.unknown()))
          .optional()
          .describe("create / edit: Meta's components list (HEADER, BODY, FOOTER, BUTTONS) instead of the shorthand; on edit they replace all of them."),
        template_id: z.string().optional().describe("edit: the template id (from list)."),
        current_category: z.string().optional().describe("edit: the template's category, when only message_send_ttl_seconds changes."),
        message_send_ttl_seconds: z
          .number()
          .int()
          .min(-1)
          .optional()
          .describe("create / edit: delivery time-to-live in seconds (UTILITY 30-43200, AUTHENTICATION 30-900, -1 = 30 days)."),
        library_template_name: z.string().optional().describe("create: build it from Meta's template library (see library)."),
        search: z.string().optional().describe("library: text search."),
        params: paramsField("Any other field of /api/uploadposts/dms/templates."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: { title: "Manage WhatsApp message templates", readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    },
    runWa(client, TEMPLATE_ROUTES)
  );

  const business = server.registerTool(
    "manage_whatsapp_business",
    {
      title: "Manage the WhatsApp Business profile and chat links",
      description:
        "The public side of the profile's WhatsApp Business number. " +
        "get_profile: about, address, description, email, websites, vertical, profile_picture_url, plus phone_number and verified_name. " +
        "update_profile (only what you send changes): about (max 139 characters), address (256), description (512), email (128), websites (up to 2 http(s) URLs), vertical (UNDEFINED, OTHER, AUTO, BEAUTY, APPAREL, EDU, ENTERTAIN, EVENT_PLAN, FINANCE, GROCERY, GOVT, HOTEL, HEALTH, NONPROFIT, PROF_SERVICES, RETAIL, TRAVEL, RESTAURANT, NOT_A_BIZ); everyone who opens the chat sees it. The profile photo is changed in the dashboard or the SDKs (file upload). " +
        "list_qr_codes: the QR codes / short links that open a chat with the number and a prefilled message (code, prefilled_message, deep_link_url, qr_image_url). create_qr_code (prefilled_message, max 140 characters; pass `code` to change an existing one's message). delete_qr_code (code; the link and QR stop working). " +
        WHATSAPP_AVAILABILITY,
      inputSchema: {
        action: actionEnum(BUSINESS_ROUTES),
        user: userField,
        about: z.string().max(139).optional().describe("update_profile: the short 'About' text."),
        address: z.string().max(256).optional().describe("update_profile."),
        description: z.string().max(512).optional().describe("update_profile."),
        email: z.string().max(128).optional().describe("update_profile."),
        websites: z.array(z.string()).max(2).optional().describe("update_profile: up to 2 http(s) URLs."),
        vertical: z.string().optional().describe("update_profile: the business category (see the description for the values)."),
        prefilled_message: z.string().max(140).optional().describe("create_qr_code: text the person's message box starts with."),
        code: z.string().optional().describe("create_qr_code: an existing code to edit. delete_qr_code: the code to delete."),
        params: paramsField("Any other field of these endpoints."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Manage the WhatsApp Business profile and chat links",
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
      },
    },
    runWa(client, BUSINESS_ROUTES)
  );

  const number = server.registerTool(
    "manage_whatsapp_number",
    {
      title: "Manage the WhatsApp number: blocks, commands, quality, name, PIN, analytics",
      description:
        "The profile's WhatsApp Business number. " +
        "list_blocked (limit, after, before), block_users / unblock_users (users: up to 1,000 phone numbers in international format or WhatsApp user ids; block only reaches people who wrote in the last 24 h; a blocked user cannot write to the number and the number cannot write to them; per-user failures in `failed`). " +
        "get_automation / set_automation: the commands (up to 30 { command_name (max 32), command_description (max 256) }, typed as /name in the chat and received as text) and ice breakers (prompts: up to 4 texts offered when someone opens the chat); set replaces the list you send, an empty list clears it. " +
        "get_number: quality_rating (GREEN, YELLOW, RED), messaging_limit_tier, throughput, verified_name, display name review (name_status, new_display_name, new_name_status), status. request_display_name (display_name; Meta reviews it), apply_display_name (once approved), change_pin (pin: 6 digits, confirm: true; two-step verification cannot be turned off). " +
        "analytics (type messaging | pricing | templates, start / end in Unix seconds, granularity messaging HALF_HOUR|DAY|MONTH, pricing HALF_HOUR|DAILY|MONTHLY, country_codes, dimensions, metric_types COST|VOLUME, template_ids up to 10 for templates, this_number_only): Meta's figures, live. enable_template_insights (confirm: true): turns template analytics on for the WhatsApp Business account; Meta does not let it be turned off. " +
        WHATSAPP_AVAILABILITY,
      inputSchema: {
        action: actionEnum(NUMBER_ROUTES),
        user: userField,
        users: z.array(z.string()).max(1000).optional().describe("block_users / unblock_users: phone numbers or WhatsApp user ids."),
        commands: z.array(z.record(z.unknown())).max(30).optional().describe("set_automation: [{ command_name, command_description }]."),
        prompts: z.array(z.string()).max(4).optional().describe("set_automation: ice breaker texts."),
        display_name: z.string().optional().describe("request_display_name."),
        pin: z.string().regex(/^\d{6}$/).optional().describe("change_pin: the new 6-digit PIN."),
        type: z.enum(["messaging", "pricing", "templates"]).optional().describe("analytics."),
        start: z.number().int().optional().describe("analytics: Unix seconds."),
        end: z.number().int().optional().describe("analytics: Unix seconds."),
        granularity: z.string().optional().describe("analytics: see the description."),
        confirm: z.boolean().optional().describe("change_pin and enable_template_insights: must be true, after the user approved it."),
        params: paramsField("limit, after, before, country_codes, dimensions, metric_types, template_ids, this_number_only."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: { title: "Manage the WhatsApp number", readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    },
    runWa(client, NUMBER_ROUTES)
  );

  const flows = server.registerTool(
    "manage_whatsapp_flows",
    {
      title: "Manage WhatsApp Flows",
      description:
        "WhatsApp Flows (forms inside the chat: sign-ups, bookings, surveys) of the profile's WhatsApp Business account; send one with send_dm (platform 'whatsapp', `flow` { flow_id, cta }). " +
        "list; create (name, categories from SIGN_UP, SIGN_IN, APPOINTMENT_BOOKING, LEAD_GENERATION, CONTACT_US, CUSTOMER_SUPPORT, SURVEY, OTHER; optional flow_json (object or string, up to 10 MB) and publish: true to publish at once, clone_flow_id, endpoint_uri); get (details, health, preview link); update (name, categories, endpoint_uri); get_json (assets with download_url); upload_json (flow_json; answers Meta's validation_errors); publish (every validation error fixed first); deprecate (a published Flow cannot be edited or deleted, only deprecated; confirm: true); delete (drafts only; confirm: true). " +
        WHATSAPP_AVAILABILITY,
      inputSchema: {
        action: actionEnum(FLOW_ROUTES),
        user: userField,
        flow_id: z.string().optional().describe("Every action but list and create."),
        name: z.string().optional().describe("create / update."),
        categories: z.array(z.string()).optional().describe("create / update."),
        flow_json: z.union([z.record(z.unknown()), z.string()]).optional().describe("create / upload_json: the Flow JSON."),
        publish: z.boolean().optional().describe("create: publish it at once (needs flow_json)."),
        confirm: z.boolean().optional().describe("deprecate and delete: must be true, after the user approved it."),
        params: paramsField("clone_flow_id, endpoint_uri."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: { title: "Manage WhatsApp Flows", readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    },
    runWa(client, FLOW_ROUTES)
  );

  return [templates, business, number, flows];
}
