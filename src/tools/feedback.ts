import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { genericResultOutputSchema, safe } from "../schemas.js";

/**
 * Feedback from the agent to the Upload-Post team.
 *
 * Agents hit confusing errors and gaps in the tool descriptions far more often
 * than people do, and never write to support about it. This tool is the
 * channel: one call, stored by the API (POST /api/uploadposts/feedback) and
 * read by the team in a daily digest. It reaches nobody but Upload-Post.
 */

export function registerFeedbackTools(server: McpServer, client: UploadPostMcpClient): RegisteredTool {
  return server.registerTool(
    "send_feedback",
    {
      title: "Send feedback to the Upload-Post team",
      description:
        "Tell the Upload-Post team about a problem with this API or these tools: an error you could not understand, a tool description that did not match what happened, something that looks like a bug, or a capability you needed and could not find. " +
        "Use it once per problem, after you have tried to solve it; do not use it for errors the response already explains (expired connection, plan limit, payment). " +
        "Describe the API, not the user's content: never include credentials, personal data or the text of the user's posts. " +
        "It does not open a support ticket and gets no reply; for help with their account, the user can write to info@upload-post.com.",
      inputSchema: {
        message: z
          .string()
          .min(10)
          .max(4000)
          .describe("What you tried, what you expected and what happened. Quote the error message if there was one."),
        category: z
          .enum(["bug", "docs", "error_message", "feature_request", "other"])
          .optional()
          .describe("bug: wrong behaviour. docs: a tool description or the docs were wrong or missing. error_message: an error you could not act on. feature_request: something you needed. other."),
        tool: z
          .string()
          .max(200)
          .optional()
          .describe("Tool (or API endpoint) the problem is about, e.g. upload_video."),
        requestId: z
          .string()
          .max(100)
          .optional()
          .describe("request_id from the failed response, if there was one."),
        agent: z
          .string()
          .max(100)
          .optional()
          .describe("Which assistant you are, e.g. Claude, ChatGPT, Cursor."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Send feedback to the Upload-Post team",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    safe(async (args) => {
      const a = args as {
        message: string;
        category?: string;
        tool?: string;
        requestId?: string;
        agent?: string;
      };
      return client.request("POST", "/uploadposts/feedback", {
        body: compact({
          message: a.message,
          category: a.category,
          endpoint: a.tool ? `mcp:${a.tool}` : undefined,
          request_id: a.requestId,
          agent: a.agent,
        }),
      });
    })
  );
}
