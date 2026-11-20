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
    if (route.method === "GET" || route.method === "DELETE") {
      return client.request(route.method, route.path, { query: toQuery(fields) });
    }
    return client.request(route.method, route.path, { body: fields });
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
        WHATSAPP_AVAILABILITY,
      inputSchema: {
        action: actionEnum(TEMPLATE_ROUTES),
        user: userField,
        name: z.string().optional().describe("Template name. Required for create and delete; a filter for list."),
        status: z.string().optional().describe("list: only templates in this status (APPROVED, PENDING, REJECTED, PAUSED, DISABLED)."),
        limit: z.number().int().min(1).max(200).optional().describe("list: templates per call (default 100)."),
        category: z.enum(["UTILITY", "MARKETING", "AUTHENTICATION"]).optional().describe("create: default UTILITY."),
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
          .describe("create: Meta's components list (HEADER, BODY, FOOTER, BUTTONS) instead of the shorthand."),
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

  return [templates, business];
}
