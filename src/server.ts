import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PACKAGE_VERSION, UploadPostMcpClient } from "./client.js";
import { registerUploadTools } from "./tools/upload.js";
import { registerStatusTools } from "./tools/status.js";
import { registerScheduleTools } from "./tools/schedule.js";
import { registerAnalyticsTools } from "./tools/analytics.js";
import { registerUserTools } from "./tools/users.js";
import { registerPagesTools } from "./tools/pages.js";
import { registerCommentTools } from "./tools/comments.js";
import { registerDmTools } from "./tools/dms.js";
import { registerFfmpegTools } from "./tools/ffmpeg.js";
import { registerQueueTools } from "./tools/queue.js";

export function buildServer(client: UploadPostMcpClient): McpServer {
  const server = new McpServer(
    {
      name: "upload-post",
      version: PACKAGE_VERSION,
    },
    {
      instructions:
        "Tools for publishing, scheduling, analyzing and managing social media posts via Upload-Post (TikTok, Instagram, YouTube, LinkedIn, Facebook, Pinterest, Threads, Reddit, Bluesky, X, Google Business). Async uploads return a request_id — poll get_status until success.",
    }
  );

  registerUploadTools(server, client);
  registerStatusTools(server, client);
  registerScheduleTools(server, client);
  registerAnalyticsTools(server, client);
  registerUserTools(server, client);
  registerPagesTools(server, client);
  registerCommentTools(server, client);
  registerDmTools(server, client);
  registerFfmpegTools(server, client);
  registerQueueTools(server, client);

  return server;
}
