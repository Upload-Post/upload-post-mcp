import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { safe } from "../schemas.js";

/**
 * FFmpeg editor endpoints. Note the path is `/ffmpeg-editor` (sibling of the
 * other `/uploadposts/*` resources), as documented at
 * https://docs.upload-post.com/llm.txt — Media Processing.
 */
export function registerFfmpegTools(server: McpServer, client: UploadPostMcpClient): void {
  server.registerTool(
    "submit_ffmpeg_job",
    {
      title: "Submit FFmpeg processing job",
      description:
        "Submit an FFmpeg job (transcode, trim, watermark, generate thumbnail, …). Returns a `job_id` you can poll with `get_ffmpeg_job`.",
      inputSchema: {
        sourceUrl: z.string().describe("Public URL of the input media."),
        operation: z
          .string()
          .describe("Operation name: 'transcode', 'trim', 'watermark', 'thumbnail', etc."),
        params: z
          .record(z.unknown())
          .optional()
          .describe("Operation-specific parameters (start/end seconds, output format, …)."),
        outputFilename: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    safe(async (args) =>
      client.request("POST", "/ffmpeg-editor", {
        body: compact(args as Record<string, unknown>),
      })
    )
  );

  server.registerTool(
    "get_ffmpeg_job",
    {
      title: "Poll FFmpeg job status",
      description:
        "Poll the status of an FFmpeg job. When status is 'completed', call `download_ffmpeg_result` to obtain the file.",
      inputSchema: {
        jobId: z.string(),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ jobId }) =>
      client.request("GET", "/ffmpeg-editor/status", { query: { job_id: jobId } })
    )
  );

  server.registerTool(
    "download_ffmpeg_result",
    {
      title: "Get FFmpeg result download URL",
      description: "Returns the download URL (and metadata) for the processed file of a completed FFmpeg job.",
      inputSchema: {
        jobId: z.string(),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ jobId }) =>
      client.request("GET", "/ffmpeg-editor/download", { query: { job_id: jobId } })
    )
  );

  server.registerTool(
    "get_ffmpeg_consumption",
    {
      title: "Get FFmpeg quota usage",
      description: "Monthly FFmpeg processing minutes used vs. plan allowance.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe(async () => client.request("GET", "/ffmpeg-editor/consumption"))
  );
}
