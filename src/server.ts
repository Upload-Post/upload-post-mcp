import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PACKAGE_VERSION, UploadPostMcpClient } from "./client.js";
import { registerUploadTools } from "./tools/upload.js";
import { registerStatusTools } from "./tools/status.js";
import { registerScheduleTools } from "./tools/schedule.js";
import { registerAnalyticsTools } from "./tools/analytics.js";
import { registerAudienceTools } from "./tools/audience.js";
import { registerUserTools } from "./tools/users.js";
import { registerPagesTools } from "./tools/pages.js";
import { registerCommentTools } from "./tools/comments.js";
import { registerPostTools } from "./tools/posts.js";
import { registerDmTools } from "./tools/dms.js";
import { registerFfmpegTools } from "./tools/ffmpeg.js";
import { registerQueueTools } from "./tools/queue.js";
import { registerUploadStudio } from "./tools/upload_studio.js";
import { registerMediaUploadTools } from "./tools/media_uploads.js";
import {
  detectClientProfile,
  isChatGpt,
  type ClientInfoLike,
  type SessionContext,
} from "./client_profile.js";

export function buildServer(client: UploadPostMcpClient, clientInfo?: ClientInfoLike): McpServer {
  const server = new McpServer(
    {
      name: "upload-post",
      title: "Upload-Post",
      version: PACKAGE_VERSION,
      websiteUrl: "https://www.upload-post.com",
      description:
        "Publish, schedule and analyze social media across TikTok, Instagram, YouTube, LinkedIn, Facebook, X, Threads, Pinterest, Reddit, Bluesky, Google Business, Discord and Telegram.",
      // Branding over the protocol, so clients don't have to sniff the origin
      // for a favicon and show whatever they cached for the host instead.
      icons: [
        {
          src: "https://www.upload-post.com/favicon-32.png",
          mimeType: "image/png",
          sizes: ["32x32"],
        },
        {
          src: "https://www.upload-post.com/favicon-192.png",
          mimeType: "image/png",
          sizes: ["192x192"],
        },
        {
          src: "https://www.upload-post.com/favicon-512.png",
          mimeType: "image/png",
          sizes: ["512x512"],
        },
      ],
    },
    {
      instructions:
        "Tools for publishing, scheduling, analyzing and managing social media posts via Upload-Post (TikTok, Instagram, YouTube, LinkedIn, Facebook, Pinterest, Threads, Reddit, Bluesky, X, Google Business, Discord, Telegram). Async uploads return a request_id — poll get_status until success.",
    }
  );

  // One McpServer per session (HTTP) or per process (stdio), so the context is
  // effectively per connected client.
  const ctx: SessionContext = {};

  const uploadTools = registerUploadTools(server, client, ctx);
  registerStatusTools(server, client);
  registerScheduleTools(server, client);
  registerAnalyticsTools(server, client);
  registerAudienceTools(server, client);
  registerUserTools(server, client);
  registerPagesTools(server, client);
  registerCommentTools(server, client);
  registerPostTools(server, client);
  registerDmTools(server, client);
  registerFfmpegTools(server, client);
  registerQueueTools(server, client);
  const mediaTools = registerMediaUploadTools(server, client);
  const studio = registerUploadStudio(server);

  // Tools are registered before we know who is on the other end. Once the
  // client has introduced itself, shape the surface for that host: ChatGPT keeps
  // the Studio widget as-is; everyone else gets the staging tools exposed to the
  // model and no widget metadata that would fail to render.
  const applyProfile = (info: ClientInfoLike | undefined): void => {
    const profile = detectClientProfile(info);
    if (ctx.profile?.kind === profile.kind && ctx.profile.name === profile.name) return;
    ctx.profile = profile;
    process.stderr.write(
      `[upload-post-mcp] client ${profile.name}/${profile.version} → ${profile.kind}\n`
    );
    if (isChatGpt(ctx)) return;
    studio.tool.disable();
    studio.resource.disable();
    uploadTools.applyClientProfile(ctx);
    mediaTools.applyClientProfile(ctx);
  };

  // HTTP sessions know the client from the `initialize` body before any
  // `tools/list` can arrive; stdio (and anything that skips the seed) falls
  // back to the `initialized` notification.
  if (clientInfo) applyProfile(clientInfo);
  server.server.oninitialized = () => applyProfile(server.server.getClientVersion());

  return server;
}
