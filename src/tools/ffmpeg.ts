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
        title: "Submit FFmpeg processing job",
        readOnlyHint: false,
        openWorldHint: true,
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
        "Poll the status of an FFmpeg job. When status is 'finished', call `download_ffmpeg_result` to obtain a publishable `media_url` (or the authenticated download URL).",
      inputSchema: {
        jobId: z.string(),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Poll FFmpeg job status",
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
        "Returns how to get a finished FFmpeg job's output without streaming it through MCP. For video and image outputs it returns a temporary public `media_url` (signed, no API key, deleted 24 h after the job finished) that you can pass straight to upload_video / upload_photos as the video URL / photo URL. It also returns `download_url`, which needs the user's Upload-Post API key.",
      inputSchema: {
        jobId: z.string(),
      },
      outputSchema: genericResultOutputSchema,
      annotations: {
        title: "Get FFmpeg result download URL",
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
      const encoderUrl = result?.download_url ?? status.download_url;
      const state = String(status.status ?? "").toLowerCase();
      const finished = ["finished", "completed", "done", "success"].includes(state);
      if (!finished && (typeof encoderUrl !== "string" || !encoderUrl)) {
        throw new Error("FFmpeg result is not ready or has no download URL.");
      }
      // Never hand back the encoder's own URL: it only answers to Upload-Post's
      // internal key and gives the customer a 401. The documented endpoint
      // streams the same file with the customer's API key.
      const downloadUrl = `${client.baseUrl}/uploadposts/ffmpeg/jobs/${encodeURIComponent(
        jobId as string
      )}/download`;
      // The API mirrors video/image outputs into media staging and signs a
      // temporary GET URL: that one is public, so it can be published directly.
      const mediaUrl = typeof result?.media_url === "string" && result.media_url ? result.media_url : undefined;
      if (mediaUrl) {
        return {
          job_id: jobId,
          status: status.status,
          media_url: mediaUrl,
          media_url_expires_in_seconds: result?.media_url_expires_in_seconds,
          download_url: downloadUrl,
          download_auth: "Authorization: Apikey <your Upload-Post API key>",
          next_step:
            "Pass media_url as the video URL (upload_video) or photo URL (upload_photos) to publish the result; " +
            "no API key is needed for it. It is temporary: call download_ffmpeg_result again for a fresh one if it " +
            "expired, and note the copy is deleted 24 h after the job finished. download_url is the same file " +
            "behind the user's API key, for a manual download.",
        };
      }
      return {
        job_id: jobId,
        status: status.status,
        download_url: downloadUrl,
        download_auth: "Authorization: Apikey <your Upload-Post API key>",
        next_step:
          "This URL requires the user's Upload-Post API key in the Authorization header, so it is not public: " +
          "do not pass it as video_url to upload_video. Tell the user to download it with their key " +
          "(or use the SDK/CLI already configured with it) and then upload the downloaded file.",
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
        title: "Get FFmpeg quota usage",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    safe(async () => client.request("GET", "/uploadposts/ffmpeg/consumption"))
  );
}
