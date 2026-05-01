import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { safe } from "../schemas.js";

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
    },
    safe(async (args) =>
      client.request("POST", "/uploadposts/ffmpeg/jobs/upload", {
        body: compact(args as Record<string, unknown>),
      })
    )
  );

  server.registerTool(
    "get_ffmpeg_job",
    {
      title: "Get FFmpeg job status",
      description:
        "Status and (when ready) download URL of an FFmpeg job. Includes the result file URL once `status` is 'completed'.",
      inputSchema: {
        jobId: z.string(),
      },
    },
    safe(async ({ jobId }) =>
      client.request("GET", `/uploadposts/ffmpeg/jobs/${encodeURIComponent(jobId as string)}`)
    )
  );

  server.registerTool(
    "get_ffmpeg_consumption",
    {
      title: "Get FFmpeg quota usage",
      description: "Monthly FFmpeg processing minutes used vs. plan allowance.",
      inputSchema: {},
    },
    safe(async () => client.request("GET", "/uploadposts/ffmpeg/consumption"))
  );
}
