import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { genericResultOutputSchema, safe } from "../schemas.js";
import { apiConfirmField, callRoute, mergeArgs, paramsField, type Route } from "./resource.js";

/**
 * Google Business Profile beyond publishing: read the location's posts,
 * reviews, performance, gallery, catalogs and attributes, and edit its info.
 * Posts are edited with edit_post and deleted with unpublish_post; review
 * replies stay in reply_to_google_business_review.
 */

const G = "/uploadposts/google-business";

const READ_ROUTES: Record<string, Route> = {
  list_posts: { method: "GET", path: `${G}/posts` },
  get_post: { method: "GET", path: `${G}/posts/get` },
  get_review: { method: "GET", path: `${G}/reviews/get` },
  batch_reviews: { method: "GET", path: `${G}/reviews/batch` },
  performance: { method: "GET", path: `${G}/performance` },
  search_keywords: { method: "GET", path: `${G}/performance/keywords` },
  location_info: { method: "GET", path: `${G}/location-info` },
  google_updates: { method: "GET", path: `${G}/location-info/google-updated` },
  list_locations: { method: "GET", path: `${G}/locations/list` },
  list_accounts: { method: "GET", path: `${G}/accounts` },
  list_media: { method: "GET", path: `${G}/media` },
  get_media: { method: "GET", path: `${G}/media/get` },
  list_customer_media: { method: "GET", path: `${G}/media/customers` },
  get_customer_media: { method: "GET", path: `${G}/media/customers/get` },
  categories: { method: "GET", path: `${G}/categories` },
  batch_categories: { method: "GET", path: `${G}/categories/batch` },
  chains: { method: "GET", path: `${G}/chains` },
  get_chain: { method: "GET", path: `${G}/chains/get` },
  available_attributes: { method: "GET", path: `${G}/attributes/available` },
  attributes: { method: "GET", path: `${G}/attributes` },
  place_action_types: { method: "GET", path: `${G}/place-actions/types` },
  place_actions: { method: "GET", path: `${G}/place-actions` },
  food_menus: { method: "GET", path: `${G}/food-menus` },
  services: { method: "GET", path: `${G}/services` },
  lodging: { method: "GET", path: `${G}/lodging` },
  lodging_google_updated: { method: "GET", path: `${G}/lodging/google-updated` },
  attributes_google_updated: { method: "GET", path: `${G}/attributes/google-updated` },
  attributes_extended: { method: "GET", path: `${G}/attributes/extended` },
  location_info_extended: { method: "GET", path: `${G}/location-info/extended` },
  get_place_action: { method: "GET", path: `${G}/place-actions/get` },
  get_account: { method: "GET", path: `${G}/accounts/get` },
  admins: { method: "GET", path: `${G}/admins` },
  invitations: { method: "GET", path: `${G}/invitations` },
  verification_state: { method: "GET", path: `${G}/verification/state` },
  verifications: { method: "GET", path: `${G}/verifications` },
  // POSTs that change nothing: a Maps search and the verification methods on offer.
  verification_options: { method: "POST", path: `${G}/verification/options` },
  search_google_locations: { method: "POST", path: `${G}/google-locations/search` },
  recommended_locations: { method: "GET", path: `${G}/google-locations/recommended` },
};

const MANAGE_ROUTES: Record<string, Route> = {
  update_attributes: { method: "PATCH", path: `${G}/attributes` },
  answer_google_updates: { method: "POST", path: `${G}/location-info/google-updates` },
  update_lodging: { method: "PATCH", path: `${G}/lodging` },
  replace_food_menus: { method: "PUT", path: `${G}/food-menus` },
  replace_services: { method: "PUT", path: `${G}/services` },
  upload_media: { method: "POST", path: `${G}/media` },
  update_media_category: { method: "PATCH", path: `${G}/media` },
  delete_media: { method: "DELETE", path: `${G}/media` },
  create_place_action: { method: "POST", path: `${G}/place-actions` },
  update_place_action: { method: "PATCH", path: `${G}/place-actions` },
  delete_place_action: { method: "DELETE", path: `${G}/place-actions` },
  delete_review_reply: { method: "DELETE", path: `${G}/reviews/reply` },
  report_google_location: { method: "POST", path: `${G}/google-locations/report` },
  create_account_group: { method: "POST", path: `${G}/accounts` },
};

const locationField = z
  .string()
  .optional()
  .describe("Location: locations/123, 123 or accounts/456/locations/123 (see get_google_business_locations). Needed when the profile has several.");

export function registerGoogleBusinessTools(server: McpServer, client: UploadPostMcpClient): RegisteredTool[] {
  const read = server.registerTool(
    "google_business_read",
    {
      title: "Read Google Business",
      description:
        "Read-only Google Business Profile data for the location connected to `user`. Fields go in `params` with the API's names; lists page with page_size and page_token (answer: next_page_token). " +
        "list_posts, get_post (post_id: accounts/…/localPosts/…); get_review (review_name, or review_id + location_id), batch_reviews (location_ids, order_by newest|lowest|highest) — list reviews with get_google_business_reviews; " +
        "performance (metrics, comma-separated, e.g. BUSINESS_IMPRESSIONS_DESKTOP_MAPS, CALL_CLICKS, WEBSITE_CLICKS, BUSINESS_DIRECTION_REQUESTS; start_date / end_date YYYY-MM-DD, up to 18 months back): daily series; search_keywords (start_month / end_month YYYY-MM): the searches that showed the location; " +
        "location_info (read_mask): name, address, hours, phones, categories, open status; google_updates: changes Google suggests; list_locations (account, filter, order_by, read_mask); list_accounts; " +
        "gallery: list_media, get_media (media_name, or media_key + location_id), list_customer_media, get_customer_media; " +
        "catalogs: categories (region_code, language_code, query), batch_categories (names, language_code), chains (name), get_chain (chain); available_attributes, attributes; place_action_types, place_actions (booking and ordering links), get_place_action (link); food_menus, services, lodging (hotels); " +
          "as customers see them after Google's own changes: attributes_google_updated, lodging_google_updated (read_mask; diff_mask lists what Google changed); edit status per field (experimental Google API): attributes_extended, location_info_extended (pending_fields, rejected_fields); " +
          "accounts and access: get_account (account), admins (scope, account or location_id), invitations (account, target_type: invitations the connected Google account received); " +
          "verification: verification_state (summary.status ok, unverified, verification_pending, suspended, disabled, duplicate, under_review), verifications (past and pending), verification_options (language_code, context: the methods Google offers); " +
          "search_google_locations (query or location, page_size: whether a business is already on Google; items with requestAdminRightsUri are managed by someone else; Google allows it only for businesses the user works with), recommended_locations (account).",
      inputSchema: {
        action: z.enum(Object.keys(READ_ROUTES) as [string, ...string[]]),
        user: z.string().optional().describe("Upload-Post profile name with Google Business connected (not needed for categories, chains)."),
        location_id: locationField,
        params: paramsField("See the description for each action's fields."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Read Google Business",
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    safe(async (args) => {
      const a = args as { action: string };
      return callRoute(client, READ_ROUTES[a.action], mergeArgs(args as Record<string, unknown>));
    })
  );

  const update = server.registerTool(
    "update_google_business_location",
    {
      title: "Edit Google Business location info",
      description:
        "Edit the public info of the Google Business location (what shows on Google Search and Maps). " +
        "edit_mode legacy (default): only description, website, phone, additional_phones, regular_hours, special_hours, primary_category, additional_categories; an empty value clears the field. " +
        "edit_mode strict: also title, address, service_area, more_hours, open_status (OPEN, CLOSED_TEMPORARILY, CLOSED_PERMANENTLY), opening_date, store_code, labels; an empty value leaves the field as it is and `null` clears it; title, address, primary_category, phone and closing the business need `confirm`, and `dry_run` checks the change with Google without applying it. " +
        "validate_only checks with Google in both modes. Read the current values first with google_business_read location_info. Changes go live on Google.",
      inputSchema: {
        user: z.string().describe("Upload-Post profile name with Google Business connected."),
        location_id: locationField,
        edit_mode: z.enum(["legacy", "strict"]).optional().describe("Default legacy."),
        fields: z
          .record(z.unknown())
          .describe("The fields to change, with the API's names (e.g. { description: '…', regular_hours: [...] })."),
        validate_only: z.boolean().optional().describe("Validate with Google; nothing is changed."),
        dry_run: z.boolean().optional().describe("strict only: validate and show what would be sent; nothing is changed."),
        include_edit_status: z.boolean().optional().describe("strict only: include each field's edit status (default true)."),
        confirm: apiConfirmField,
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Edit Google Business location info",
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    safe(async (args) => {
      const { fields, ...named } = args as { fields: Record<string, unknown>; [k: string]: unknown };
      return callRoute(client, { method: "PATCH", path: `${G}/location-info` }, { ...fields, ...named });
    })
  );

  const manage = server.registerTool(
    "manage_google_business",
    {
      title: "Manage Google Business",
      description:
        "Change the Google Business location connected to `user` beyond its basic info (edit that with update_google_business_location). Fields go in `params` with the API's names; changes go live on Google Search and Maps, and Google allows about 10 edits per minute per location (429 location_edit_rate_limited). `dry_run` validates without applying where supported. " +
        "update_attributes (attributes, whatsapp_url, text_messaging_url, remove: only the attributes named change; see google_business_read available_attributes); answer_google_updates (decision accept|reject, fields: keep or undo Google's own changes; title and storefront fields need `confirm`); " +
        "update_lodging (lodging, update_mask; `null` clears a field, lists are replaced whole; needs `confirm`); replace_food_menus (menus: the WHOLE list, anything left out is removed, null removes all; needs `confirm`) and replace_services (service_items, the whole list; needs `confirm`): read them first with google_business_read; " +
        "gallery: upload_media (source_url public link, category COVER|PROFILE|EXTERIOR|INTERIOR|PRODUCT|AT_WORK|FOOD_AND_DRINK|MENU|COMMON_AREA|ROOMS|TEAMS|ADDITIONAL, description; photos at least 250 px and 10 KB), update_media_category (media_name or media_key, category: the only editable field), delete_media (media_name or media_key; cannot be restored; needs `confirm`); " +
        "booking and ordering links: create_place_action (type, uri, is_preferred), update_place_action (link, uri, is_preferred, is_disabled), delete_place_action (link, needs `confirm`); " +
        "delete_review_reply (review_name, or review_id + location_id: removes the owner's public reply); report_google_location (google_location from search_google_locations, reason_bad_location or reason_bad_recommendation, elaboration; needs `confirm`, cannot be withdrawn); " +
        "create_account_group (type LOCATION_GROUP|USER_GROUP, account_name, primary_owner; needs `confirm`).",
      inputSchema: {
        action: z.enum(Object.keys(MANAGE_ROUTES) as [string, ...string[]]),
        user: z.string().describe("Upload-Post profile name with Google Business connected."),
        location_id: locationField,
        params: paramsField("See the description for each action's fields."),
        confirm: apiConfirmField,
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Manage Google Business",
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
      },
    },
    safe(async (args) => {
      const a = args as { action: string };
      return callRoute(client, MANAGE_ROUTES[a.action], mergeArgs(args as Record<string, unknown>));
    })
  );

  return [read, update, manage];
}
