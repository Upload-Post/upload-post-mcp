import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { genericResultOutputSchema, safe } from "../schemas.js";

/**
 * Team posts waiting for approval (posts by Editors and Contributors), the
 * team's roles and its activity log. The account owner and Admin members
 * review; the end-client approval page authenticates with a profile JWT and is
 * not exposed here.
 *
 * Raw HTTP for now: upload-post 2.21.0 has listTeamMembers and
 * listSharedAccounts only; the approval routes can move to the SDK when it
 * ships them.
 */

const AP = "/uploadposts/approvals";

const DISABLED_NOTE =
  "Not generally available yet: until post approvals are switched on for the account, these calls answer 503 post_approvals_disabled (the feature is off, not a temporary failure).";

const approvalIdField = z
  .string()
  .min(1)
  .describe("`approval_id` from list_pending_approvals (also returned by an upload that went to approval).");

/** What get_status / an upload answer for a post that has not been published because it waits for approval. */
export const APPROVAL_STATES = ["pending_approval", "draft", "approving", "rejected", "withdrawn", "expired"] as const;

const approvalNextStep: Record<string, string> = {
  pending_approval:
    "Nothing has been published yet, and that is expected: this team member's posts wait for the account owner or an Admin to approve them. The post was not rejected and is not an error. It is published when it is approved (at its date, now, or in the next queue slot). Tell the user it is waiting for approval. Polling get_status shows the same state until a reviewer decides; list_pending_approvals shows the queue.",
  draft:
    "Nothing has been published yet, and that is expected: this team member's posts are saved as drafts for the account owner or an Admin to review and schedule. It is not an error. Tell the user the draft is waiting for review. Polling get_status shows the same state until a reviewer decides; list_pending_approvals shows the queue.",
  approving: "The post is being approved right now; its job is about to be created. Check get_status again shortly.",
  rejected: "A reviewer rejected this post, so it will not be published. The reviewer's comment is in `decision_comment` (list_pending_approvals with the approval_id).",
  withdrawn: "This post was withdrawn or discarded before approval, so it will not be published.",
  expired: "Nobody approved this post before its date or the approval window ended, so it expired and will not be published.",
};

/**
 * Explain a post diverted to the approval queue (202 `pending_approval`, or a
 * status read of one) so the model does not mistake it for a failure.
 */
export function withApprovalNote(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const r = result as Record<string, unknown>;
  const diverted = r.pending_approval === true || (r.approval_id !== undefined && r.approval_id !== null && (typeof r.approval_status === "string" || typeof r.status === "string"));
  if (!diverted) return result;
  const state = String(r.approval_status ?? r.status ?? "");
  const next = approvalNextStep[state];
  if (!next) return result;
  return { ...r, next_step: next };
}

export function registerApprovalTools(server: McpServer, client: UploadPostMcpClient): RegisteredTool[] {
  const list = server.registerTool(
    "list_pending_approvals",
    {
      title: "List posts awaiting approval",
      description:
        "Posts created by team members (Editors and Contributors) that wait for the account owner or an Admin: status pending_approval (an Editor's post, published once approved) or draft (a Contributor's, the reviewer sets the date). By default only open ones, newest first. " +
        "Each item has approval_id, status, version (needed to approve), profile_username, platforms, post_type, title, caption, platform_content, scheduled_date, expires_at, author_email, author_role, and after a decision decided_by, decision_comment and job_id; closed ones are approved, rejected, withdrawn or expired. " +
        "With `approval_id` it returns that one item with its upload fields, preview_url and thumbnail_url (temporary links) and destinations_effective. Editors and Contributors see only their own posts. " +
        "Page with `before` = the previous `next_before`. " +
        DISABLED_NOTE,
      inputSchema: {
        approval_id: approvalIdField.optional(),
        status: z
          .array(z.enum(["pending_approval", "draft", "approving", "approved", "rejected", "withdrawn", "expired"]))
          .optional()
          .describe("Statuses to list. Default: the open ones (pending_approval, draft)."),
        profile_username: z.string().optional().describe("Only this Upload-Post profile."),
        author: z.string().optional().describe("Only posts by this team member email."),
        limit: z.number().int().min(1).max(200).optional().describe("Items per page, 1-200. Default 50."),
        before: z.string().optional().describe("`next_before` of the previous page."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "List posts awaiting approval",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async (args) => {
      const { approval_id, status, ...rest } = args as {
        approval_id?: string;
        status?: string[];
      } & Record<string, unknown>;
      if (approval_id) return client.request("GET", `${AP}/${encodeURIComponent(approval_id)}`);
      return client.request("GET", AP, {
        query: compact({ ...rest, status: status?.length ? status.join(",") : undefined }),
      });
    })
  );

  const approve = server.registerTool(
    "approve_post",
    {
      title: "Approve a post",
      description:
        "Approve a team member's post waiting for approval: Upload-Post creates its scheduled job and publishes it to the post's platforms. Owner and Admin only. " +
        "`version` is the item's `version` as reviewed; if the post was edited since, the call answers 409 approval_version_changed with the current item, which should be reviewed again. " +
        "When it publishes: `scheduled_date` (+ `timezone`) if sent; now for immediate posts or with `publish_now`; the next free queue slot for queued posts; otherwise the post's own date. " +
        "409 approval_expired (an Editor's post whose date has passed), scheduled_date_in_past (a draft whose proposed date passed: send a date or publish_now), approval_closed; 429 when the monthly upload allowance is used up. " +
        DISABLED_NOTE,
      inputSchema: {
        approval_id: approvalIdField,
        version: z.number().int().min(0).describe("The item's `version` that was reviewed."),
        comment: z.string().max(2000).optional().describe("Note for the author."),
        scheduled_date: z.string().optional().describe("ISO 8601 date to publish at instead of the post's own."),
        timezone: z.string().optional().describe("IANA timezone for scheduled_date."),
        publish_now: z.boolean().optional().describe("Publish right away."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Approve a post",
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    safe(async (args) => {
      const { approval_id, ...body } = args as { approval_id: string } & Record<string, unknown>;
      return client.request("POST", `${AP}/${encodeURIComponent(approval_id)}/approve`, { body: compact(body) });
    })
  );

  const reject = server.registerTool(
    "reject_post",
    {
      title: "Reject a post",
      description:
        "Reject a team member's post waiting for approval: it will not be published and the author is notified with the comment. Owner and Admin only. A rejected post cannot be reopened. 409 approval_closed when it was already decided. " +
        DISABLED_NOTE,
      inputSchema: {
        approval_id: approvalIdField,
        comment: z.string().min(1).max(2000).describe("Why it is rejected; shown to the author."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Reject a post",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    safe(async (args) => {
      const { approval_id, comment } = args as { approval_id: string; comment: string };
      return client.request("POST", `${AP}/${encodeURIComponent(approval_id)}/reject`, { body: { comment } });
    })
  );

  const edit = server.registerTool(
    "edit_pending_post",
    {
      title: "Edit a post awaiting approval",
      description:
        "Change a post while it waits for approval (its author or a reviewer). Same fields as editing a scheduled post: title and caption apply to every platform, platform_content {platform: {title, caption}} to some, fields holds other upload options by their form names, scheduled_date + timezone, cover_image_base64 / remove_cover (Instagram/Facebook Reels cover). Only what is sent changes. Every edit raises `version` by one. " +
        "409 approval_closed or approval_state_changed. " +
        DISABLED_NOTE,
      inputSchema: {
        approval_id: approvalIdField,
        title: z.string().optional(),
        caption: z.string().optional(),
        platform_content: z.record(z.record(z.unknown())).optional().describe("Per-platform text, e.g. {\"instagram\": {\"caption\": \"...\"}}."),
        fields: z.record(z.unknown()).optional().describe("Other upload options by their form field names."),
        scheduled_date: z.string().optional().describe("New ISO 8601 date."),
        timezone: z.string().optional().describe("IANA timezone for scheduled_date."),
        cover_image_base64: z.string().optional().describe("New Reels cover image, base64 or data URL."),
        remove_cover: z.boolean().optional(),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Edit a post awaiting approval",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    safe(async (args) => {
      const { approval_id, ...body } = args as { approval_id: string } & Record<string, unknown>;
      return client.request("PATCH", `${AP}/${encodeURIComponent(approval_id)}`, { body: compact(body) });
    })
  );

  const withdraw = server.registerTool(
    "withdraw_pending_post",
    {
      title: "Withdraw a post awaiting approval",
      description:
        "Withdraw (its author) or discard (a reviewer) a post waiting for approval: it becomes withdrawn, will not be published and its media is deleted. It cannot be undone. 409 approval_closed when it was already decided. " +
        DISABLED_NOTE,
      inputSchema: { approval_id: approvalIdField },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Withdraw a post awaiting approval",
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    safe(async (args) => {
      const { approval_id } = args as { approval_id: string };
      return client.request("DELETE", `${AP}/${encodeURIComponent(approval_id)}`);
    })
  );

  const team = server.registerTool(
    "get_team_info",
    {
      title: "Get team info",
      description:
        "Read-only team data. roles: the role matrix (owner, admin, editor, contributor, viewer and what each can do), whether roles and approvals are enabled, and the caller's own role and profiles. " +
        "members: the owner's team members with status and, with roles on, role and profiles (null = every profile); not available to members. " +
        "shared_with_me: accounts whose team the caller belongs to, with the caller's role there. " +
        "audit: what members did (post_created, published, scheduled_edited, scheduled_cancelled, approval_requested, draft_created, approval_edited, approved, rejected, approval_withdrawn, approval_expired, member_access_changed), newest first, owner and Admin only; filters actor, action, profile_username, target_id, since, until (ISO 8601), limit (1-200), cursor (= next_cursor). " +
        "Roles and member access are changed by the account owner in the dashboard.",
      inputSchema: {
        action: z.enum(["roles", "members", "shared_with_me", "audit"]),
        actor: z.string().optional().describe("audit: only this member email."),
        audit_action: z
          .enum([
            "post_created",
            "published",
            "scheduled_edited",
            "scheduled_cancelled",
            "approval_requested",
            "draft_created",
            "approval_edited",
            "approved",
            "rejected",
            "approval_withdrawn",
            "approval_expired",
            "member_access_changed",
          ])
          .optional()
          .describe("audit: only this kind of activity."),
        profile_username: z.string().optional().describe("audit: only this profile."),
        target_id: z.string().optional().describe("audit: only this approval or job id."),
        since: z.string().optional().describe("audit: ISO 8601, inclusive."),
        until: z.string().optional().describe("audit: ISO 8601, exclusive."),
        limit: z.number().int().min(1).max(200).optional().describe("audit: rows per page, 1-200. Default 50."),
        cursor: z.string().optional().describe("audit: `next_cursor` of the previous page."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: { title: "Get team info", readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    safe(async (args) => {
      const { action, audit_action, ...filters } = args as { action: string; audit_action?: string } & Record<string, unknown>;
      if (action === "roles") return client.request("GET", "/uploadposts/teams/roles");
      if (action === "members") return client.request("GET", "/uploadposts/teams/members");
      if (action === "shared_with_me") return client.request("GET", "/uploadposts/teams/shared-with-me");
      return client.request("GET", "/uploadposts/teams/audit", {
        query: compact({ ...filters, action: audit_action }),
      });
    })
  );

  return [list, approve, reject, edit, withdraw, team];
}
