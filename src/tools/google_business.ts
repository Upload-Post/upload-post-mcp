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
        "catalogs: categories (region_code, language_code, query), batch_categories (names, language_code), chains (name), get_chain (chain); available_attributes, attributes; place_action_types, place_actions (booking and ordering links); food_menus, services, lodging (hotels).",
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

  return [read, update];
}
