import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { compact } from "../client.js";
import { genericResultOutputSchema, safe } from "../schemas.js";

export function registerFfmpegTools(server: McpServer, client: UploadPostMcpClient): void {
  server.registerTool(
    "submit_ffmpeg_job",
    {
      title: "Submit FFmpeg processing job",
      description:
        "Submit a private FFmpeg processing job through Upload-Post. Provide `input_url` for one input, or `files` for multiple public URLs. Optionally provide `full_command` beginning with ffmpeg for explicit trim/transcode/watermark/thumbnail commands. Returns a `job_id` you can poll with `get_ffmpeg_job`.",
      inputSchema: {
        input_url: z
          .string()
          .optional()
          .describe("Public URL of the input media. Use this for a single source file."),
        files: z
          .array(z.string())
          .min(1)
          .optional()
          .describe("Public URLs of multiple input media files, when the job needs more than one source."),
        full_command: z
          .string()
          .optional()
          .describe("Optional explicit command. Must start with `ffmpeg`; shell metacharacters are rejected by the API."),
        output_filename: z
          .string()
          .optional()
          .describe("Optional preferred output filename, e.g. clip.mp4 or thumbnail.jpg."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async (args) => {
      const { sourceUrl, outputFilename, input_url, files, ...rest } = args as {
        sourceUrl?: string;
        outputFilename?: string;
        input_url?: string;
        files?: string[];
        [key: string]: unknown;
      };
      const inputUrl = input_url ?? sourceUrl;
      return client.request("POST", "/uploadposts/ffmpeg/jobs/upload", {
        body: compact({
          ...rest,
          files: files ?? (inputUrl ? [inputUrl] : undefined),
          output_filename: rest.output_filename ?? outputFilename,
        }),
      });
    })
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
      outputSchema: genericResultOutputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async ({ jobId }) =>
      client.request("GET", `/uploadposts/ffmpeg/jobs/${encodeURIComponent(jobId as string)}`)
    )
  );

  server.registerTool(
    "download_ffmpeg_result",
    {
      title: "Get FFmpeg result download URL",
      description:
        "Returns the download URL and metadata for a completed FFmpeg job without streaming the processed file through MCP.",
      inputSchema: {
        jobId: z.string(),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async ({ jobId }) => {
      const status = await client.request<Record<string, unknown>>(
        "GET",
        `/uploadposts/ffmpeg/jobs/${encodeURIComponent(jobId as string)}`
      );
      const result =
        status.result && typeof status.result === "object"
          ? (status.result as Record<string, unknown>)
          : undefined;
      const downloadUrl = result?.download_url ?? status.download_url;
      if (typeof downloadUrl !== "string" || !downloadUrl) {
        throw new Error("FFmpeg result is not ready or has no download URL.");
      }
      return {
        job_id: jobId,
        status: status.status,
        download_url: downloadUrl,
      };
    })
  );

  server.registerTool(
    "get_ffmpeg_consumption",
    {
      title: "Get FFmpeg quota usage",
      description: "Monthly FFmpeg processing minutes used vs. plan allowance.",
      inputSchema: {},
      outputSchema: genericResultOutputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async () => client.request("GET", "/uploadposts/ffmpeg/consumption"))
  );
}
