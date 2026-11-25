import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { genericResultOutputSchema, safe } from "../schemas.js";

/**
 * Smaller pieces of the public API that had no tool: one scheduled post in
 * detail, a profile's name, connections and default Pages, queue slots taken
 * outside Upload-Post, publishing quotas and Pinterest boards.
 *
 * Raw HTTP: none of these are in upload-post 2.21.0 except savePost; they can
 * move to the SDK when it ships them.
 */

const PAGE_KINDS = {
  facebook: { path: "/uploadposts/users/facebook-page", field: "facebook_page_id" },
  linkedin: { path: "/uploadposts/users/linkedin-page", field: "linkedin_page_id" },
  google_business: { path: "/uploadposts/users/google-business-location", field: "gbp_location_id" },
} as const;

type PageKind = keyof typeof PAGE_KINDS;

const PROFILE_ACTIONS = [
  "get",
  "rename",
  "disconnect_social",
  "list_page_choices",
  "select_page",
  "clear_page",
] as const;

export function registerAccountExtraTools(server: McpServer, client: UploadPostMcpClient): RegisteredTool[] {
  const scheduled = server.registerTool(
    "get_scheduled_post",
    {
      title: "Get a scheduled post",
      description:
        "One scheduled or queued post by `job_id` (from list_scheduled). details: the options it was scheduled with (what edit_scheduled can change), signed media URLs and whether it can still be edited. " +
        "preview: short-lived URLs of its media, cover and thumbnail (null when there is none). thumbnail: a signed URL of a small JPEG of its video or first image, built once if missing; a 202 answer means another request is building it, retry after `retry_after` seconds.",
      inputSchema: {
        job_id: z.string().min(1).describe("The scheduled post's job_id."),
        view: z.enum(["details", "preview", "thumbnail"]).optional().describe("What to return. Default details."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: { title: "Get a scheduled post", readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    safe(async (args) => {
      const { job_id, view } = args as { job_id: string; view?: string };
      const base = `/uploadposts/schedule/${encodeURIComponent(job_id)}`;
      return client.request("GET", view === "preview" || view === "thumbnail" ? `${base}/${view}` : base);
    })
  );

  const profile = server.registerTool(
    "manage_profile",
    {
      title: "Manage a profile",
      description:
        "One Upload-Post profile (`username`, as list_users returns it). get: the profile and its connected social accounts. " +
        "rename (display_name): the label shown in the dashboard; the username never changes, so history, schedules and integrations keep working; an empty display_name removes the label. " +
        "disconnect_social (social_platform: the key in the profile's social_accounts, e.g. instagram): unlinks that one network from the profile; the others stay; reconnecting needs the user to log in to the network again through get_connect_link. " +
        "Default Page used when publishing, per network (page_type facebook, linkedin or google_business): list_page_choices (every Page or location of the connected account and the one selected), select_page (page_id), clear_page (back to the account's first one).",
      inputSchema: {
        action: z.enum(PROFILE_ACTIONS),
        username: z.string().min(1).describe("Upload-Post profile name."),
        display_name: z.string().nullable().optional().describe("rename: the new label; empty or null removes it."),
        social_platform: z.string().optional().describe("disconnect_social: the network key in the profile's social_accounts, e.g. 'instagram'."),
        page_type: z.enum(["facebook", "linkedin", "google_business"]).optional().describe("list_page_choices / select_page / clear_page: which network's Page."),
        page_id: z
          .string()
          .optional()
          .describe("select_page: the Facebook Page id, LinkedIn Page id or Google Business location id from list_page_choices."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: { title: "Manage a profile", readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    },
    safe(async (args) => {
      const a = args as {
        action: (typeof PROFILE_ACTIONS)[number];
        username: string;
        display_name?: string | null;
        social_platform?: string;
        page_type?: PageKind;
        page_id?: string;
      };
      const userPath = `/uploadposts/users/${encodeURIComponent(a.username)}`;
      switch (a.action) {
        case "get":
          return client.request("GET", userPath);
        case "rename":
          if (a.display_name === undefined) throw new Error("`display_name` is required for rename.");
          return client.request("PATCH", userPath, { body: { display_name: a.display_name } });
        case "disconnect_social":
          if (!a.social_platform) throw new Error("`social_platform` is required for disconnect_social.");
          return client.request("DELETE", "/uploadposts/users/social", {
            body: { profile_username: a.username, social_platform: a.social_platform },
          });
        default: {
          if (!a.page_type) throw new Error("`page_type` is required for this action.");
          const kind = PAGE_KINDS[a.page_type];
          if (a.action === "list_page_choices") {
            return client.request("GET", kind.path, { query: { profile_username: a.username } });
          }
          if (a.action === "clear_page") {
            return client.request("DELETE", kind.path, { body: { profile_username: a.username } });
          }
          if (!a.page_id) throw new Error("`page_id` is required for select_page.");
          return client.request("POST", kind.path, { body: { profile_username: a.username, [kind.field]: a.page_id } });
        }
      }
    })
  );

  const slot = server.registerTool(
    "mark_queue_slot",
    {
      title: "Mark a queue slot full or free",
      description:
        "Mark one slot of a profile's posting queue as full, so the queue skips it (for example because the user filled it outside Upload-Post), or free it again with `full: false`. Slot times come from preview_queue.",
      inputSchema: {
        profile_username: z.string().min(1).describe("Upload-Post profile name."),
        slot_datetime: z.string().min(1).describe("The slot time, ISO 8601 in UTC, as preview_queue lists it."),
        full: z.boolean().describe("true marks it full; false frees it."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: { title: "Mark a queue slot", readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true },
    },
    safe(async (args) => {
      const { full, ...body } = args as { full: boolean; profile_username: string; slot_datetime: string };
      return client.request(full ? "POST" : "DELETE", "/uploadposts/queue/slot-full", { body });
    })
  );

  const limits = server.registerTool(
    "get_publishing_limits",
    {
      title: "Get publishing limits",
      description:
        "How many posts Instagram or Threads still lets the connected account publish: both networks cap posts per rolling 24 hours, and a post over the cap fails. Cached; `refresh: true` reads it again from the network.",
      inputSchema: {
        platform: z.enum(["instagram", "threads"]),
        profile: z.string().min(1).describe("Upload-Post profile name with that network connected."),
        refresh: z.boolean().optional().describe("Skip the cache."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: { title: "Get publishing limits", readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    },
    safe(async (args) => {
      const { platform, ...query } = args as { platform: string; profile: string; refresh?: boolean };
      return client.request("GET", `/uploadposts/${platform}/publishing_limit`, { query: compact(query) });
    })
  );

  const boards = server.registerTool(
    "manage_pinterest_boards",
    {
      title: "Manage Pinterest boards",
      description:
        "Pinterest boards of a profile's connected account (list them with get_pinterest_boards). list_sections (board_id): the board's sections, whose id goes in the upload's pinterest board section option. " +
        "create_board (name, description, privacy PUBLIC|PROTECTED; default PUBLIC) and create_section (board_id, name) create them on the user's Pinterest account.",
      inputSchema: {
        action: z.enum(["list_sections", "create_board", "create_section"]),
        profile: z.string().min(1).describe("Upload-Post profile name with Pinterest connected."),
        board_id: z.string().optional().describe("list_sections / create_section: the board."),
        name: z.string().optional().describe("create_board / create_section: the name."),
        description: z.string().optional().describe("create_board: the board description."),
        privacy: z.enum(["PUBLIC", "PROTECTED"]).optional().describe("create_board: PUBLIC (default) or PROTECTED (secret)."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: { title: "Manage Pinterest boards", readOnlyHint: false, openWorldHint: true, destructiveHint: false },
    },
    safe(async (args) => {
      const { action, profile, board_id, ...body } = args as {
        action: string;
        profile: string;
        board_id?: string;
        name?: string;
      };
      if (action === "create_board") {
        if (!body.name) throw new Error("`name` is required for create_board.");
        return client.request("POST", "/uploadposts/pinterest/boards", { query: { profile }, body: compact(body) });
      }
      if (!board_id) throw new Error("`board_id` is required for this action.");
      const path = `/uploadposts/pinterest/boards/${encodeURIComponent(board_id)}/sections`;
      if (action === "list_sections") return client.request("GET", path, { query: { profile } });
      if (!body.name) throw new Error("`name` is required for create_section.");
      return client.request("POST", path, { query: { profile }, body: { name: body.name } });
    })
  );

  const save = server.registerTool(
    "save_post",
    {
      title: "Save a Pin or bookmark a post",
      description:
        "Pinterest: save an existing Pin (`post_id`) to one of the profile's boards (`pinterest_board_id`, optionally a section); it shows on that board. Bluesky and X: bookmark a post (private). X bookmarks need the X bookmark permission (403 x_reconnect_required for accounts connected before it: reconnect X) and count toward the daily X write limit.",
      inputSchema: {
        platform: z.enum(["pinterest", "bluesky", "x"]),
        user: z.string().min(1).describe("Upload-Post profile name."),
        post_id: z.string().min(1).describe("Pinterest Pin id, Bluesky at:// URI or bsky.app link, or X post id."),
        pinterest_board_id: z.string().optional().describe("Pinterest: the board to save to (required)."),
        pinterest_board_section_id: z.string().optional().describe("Pinterest: a section of that board."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: { title: "Save a Pin or bookmark a post", readOnlyHint: false, openWorldHint: true, destructiveHint: false, idempotentHint: true },
    },
    safe(async (args) => {
      const a = args as { platform: string; pinterest_board_id?: string } & Record<string, unknown>;
      if (a.platform === "pinterest" && !a.pinterest_board_id) throw new Error("`pinterest_board_id` is required for Pinterest.");
      return client.request("POST", "/uploadposts/posts/save", { body: compact(a) });
    })
  );

  return [scheduled, profile, slot, limits, boards, save];
}
