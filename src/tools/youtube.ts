import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UploadPostMcpClient } from "../client.js";
import { genericResultOutputSchema, safe } from "../schemas.js";
import { apiConfirmField, callRoute, mergeArgs, paramsField, type Route } from "./resource.js";

/**
 * YouTube channel management beyond publishing: reads (videos, playlists,
 * captions, comments, search, channel, live) and writes grouped by resource.
 * Files are taken by public URL only (`*_url`): the server never reads a path.
 */

const Y = "/uploadposts/youtube";

/** One sentence every YouTube tool carries, so the agent plans its calls. */
export const YOUTUBE_QUOTA =
  "Every call spends the account's daily YouTube allowance (free plan 200 units, paid plans 2,000; resets at midnight Pacific time; youtube_read quota shows what is left): reads cost about 1 unit, most writes 50, captions 400-450, so batch reads and avoid needless writes.";

const READ_ROUTES: Record<string, Route> = {
  videos: { method: "GET", path: `${Y}/videos` },
  quota: { method: "GET", path: `${Y}/quota` },
  rating: { method: "GET", path: `${Y}/videos/rating` },
  playlists: { method: "GET", path: `${Y}/playlists` },
  playlist_items: { method: "GET", path: `${Y}/playlists/{playlist_id}/items` },
  playlist_image: { method: "GET", path: `${Y}/playlists/{playlist_id}/image` },
  captions: { method: "GET", path: `${Y}/captions` },
  comments: { method: "GET", path: `${Y}/comments` },
  comment_replies: { method: "GET", path: `${Y}/comments/replies` },
  search: { method: "GET", path: `${Y}/search` },
  categories: { method: "GET", path: `${Y}/categories` },
  languages: { method: "GET", path: `${Y}/languages` },
  regions: { method: "GET", path: `${Y}/regions` },
  channel: { method: "GET", path: `${Y}/channel` },
  channel_lookup: { method: "GET", path: `${Y}/channel/lookup` },
  channel_sections: { method: "GET", path: `${Y}/channel/sections` },
  subscriptions: { method: "GET", path: `${Y}/subscriptions` },
  activities: { method: "GET", path: `${Y}/activities` },
  broadcasts: { method: "GET", path: `${Y}/live/broadcasts` },
  broadcast: { method: "GET", path: `${Y}/live/broadcasts/{broadcast_id}` },
  streams: { method: "GET", path: `${Y}/live/streams` },
  stream: { method: "GET", path: `${Y}/live/streams/{stream_id}` },
  live_chat: { method: "GET", path: `${Y}/live/chat` },
  super_chats: { method: "GET", path: `${Y}/live/super-chats` },
};

const PLAYLIST_ROUTES: Record<string, Route> = {
  create: { method: "POST", path: `${Y}/playlists` },
  update: { method: "PATCH", path: `${Y}/playlists/{playlist_id}` },
  delete: { method: "DELETE", path: `${Y}/playlists/{playlist_id}` },
  add_video: { method: "POST", path: `${Y}/playlists/{playlist_id}/items` },
  update_video: { method: "PATCH", path: `${Y}/playlists/{playlist_id}/items/{item_id}` },
  remove_video: { method: "DELETE", path: `${Y}/playlists/{playlist_id}/items/{item_id}` },
  set_image: { method: "POST", path: `${Y}/playlists/{playlist_id}/image` },
  replace_image: { method: "PUT", path: `${Y}/playlists/{playlist_id}/image` },
  delete_image: { method: "DELETE", path: `${Y}/playlists/{playlist_id}/image` },
};

const COMMENT_ROUTES: Record<string, Route> = {
  create: { method: "POST", path: `${Y}/comments` },
  edit: { method: "PATCH", path: `${Y}/comments/{comment_id}` },
  delete: { method: "DELETE", path: `${Y}/comments/{comment_id}` },
  moderate: { method: "POST", path: `${Y}/comments/moderate` },
};

const CHANNEL_ROUTES: Record<string, Route> = {
  update: { method: "PATCH", path: `${Y}/channel` },
  create_section: { method: "POST", path: `${Y}/channel/sections` },
  update_section: { method: "PATCH", path: `${Y}/channel/sections/{section_id}` },
  delete_section: { method: "DELETE", path: `${Y}/channel/sections/{section_id}` },
  set_banner: { method: "POST", path: `${Y}/channel/banner` },
  set_watermark: { method: "POST", path: `${Y}/channel/watermark` },
  remove_watermark: { method: "DELETE", path: `${Y}/channel/watermark` },
  subscribe: { method: "POST", path: `${Y}/subscriptions` },
  unsubscribe: { method: "DELETE", path: `${Y}/subscriptions/{subscription_id}` },
};

const VIDEO_ROUTES: Record<string, Route> = {
  rate: { method: "POST", path: `${Y}/videos/{video_id}/rate` },
  set_thumbnail: { method: "POST", path: `${Y}/thumbnail` },
  upload_caption: { method: "POST", path: `${Y}/captions` },
  update_caption: { method: "PUT", path: `${Y}/captions/{caption_id}` },
  delete_caption: { method: "DELETE", path: `${Y}/captions/{caption_id}` },
};

const LIVE_ROUTES: Record<string, Route> = {
  create_broadcast: { method: "POST", path: `${Y}/live/broadcasts` },
  update_broadcast: { method: "PATCH", path: `${Y}/live/broadcasts/{broadcast_id}` },
  delete_broadcast: { method: "DELETE", path: `${Y}/live/broadcasts/{broadcast_id}` },
  bind: { method: "POST", path: `${Y}/live/broadcasts/{broadcast_id}/bind` },
  transition: { method: "POST", path: `${Y}/live/broadcasts/{broadcast_id}/transition` },
  insert_cuepoint: { method: "POST", path: `${Y}/live/broadcasts/{broadcast_id}/cuepoint` },
  create_stream: { method: "POST", path: `${Y}/live/streams` },
  update_stream: { method: "PATCH", path: `${Y}/live/streams/{stream_id}` },
  delete_stream: { method: "DELETE", path: `${Y}/live/streams/{stream_id}` },
  send_chat_message: { method: "POST", path: `${Y}/live/chat` },
  close_poll: { method: "POST", path: `${Y}/live/chat/polls/{message_id}/close` },
  delete_chat_message: { method: "DELETE", path: `${Y}/live/chat/messages/{message_id}` },
};

/** Fields that carry a file: only public URLs are accepted here. */
const FILE_FIELDS = ["image", "file", "thumbnail"];

const actionEnum = (routes: Record<string, Route>) => z.enum(Object.keys(routes) as [string, ...string[]]);
const userField = z.string().describe("Upload-Post profile name with YouTube connected.");
const idField = (what: string) => z.string().optional().describe(what);

const writeAnnotations = (title: string) => ({
  title,
  readOnlyHint: false,
  openWorldHint: true,
  destructiveHint: true,
});

export function registerYoutubeTools(server: McpServer, client: UploadPostMcpClient): RegisteredTool[] {
  const run = (routes: Record<string, Route>) =>
    safe(async (args) => {
      const fields = mergeArgs(args as Record<string, unknown>);
      const sent = FILE_FIELDS.filter((k) => fields[k] !== undefined);
      if (sent.length) {
        throw new Error(`Pass files by public URL (${sent.map((k) => `${k}_url`).join(", ")}), not as ${sent.join(", ")}.`);
      }
      return callRoute(client, routes[(args as { action: string }).action], fields);
    });

  const read = server.registerTool(
    "youtube_read",
    {
      title: "Read YouTube",
      description:
        "Read-only YouTube data of the connected channel. Fields go in `params` with the API's names; lists page with max_results and page_token. " +
        "videos (ids up to 50, parts, include_owner_details: status, processing, statistics, translations); quota (the account's allowance left today); rating (ids: the channel's like/dislike); " +
        "playlists (ids or channel_id), playlist_items (playlist_id), playlist_image (playlist_id); captions (video_id: caption tracks); " +
        "comments (video_id, or scope: channel for the whole channel; moderation_status published|heldForReview|likelySpam, order, search, include_replies), comment_replies (parent_id); " +
        "search (q, for_mine, channel_id, type video|channel|playlist, order, published_after…; few searches per day: free plan 1, paid 5), categories (region), languages, regions; " +
        "channel (settings, branding, translations, statistics), channel_lookup (for_handle, ids), channel_sections, subscriptions (filter mine|my_subscribers), activities; " +
        "broadcasts (status active|upcoming|completed), broadcast (broadcast_id), streams, stream (stream_id; include_stream_key returns the secret key to the owner), live_chat (broadcast_id or live_chat_id, page_token; wait polling_interval_ms between reads), super_chats. " +
        YOUTUBE_QUOTA,
      inputSchema: {
        action: actionEnum(READ_ROUTES),
        user: z.string().optional().describe("Upload-Post profile name with YouTube connected (not needed for quota and catalogs)."),
        params: paramsField("See the description for each action's fields."),
      },
      outputSchema: genericResultOutputSchema,
      annotations: { title: "Read YouTube", readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    },
    run(READ_ROUTES)
  );

  const playlists = server.registerTool(
    "manage_youtube_playlists",
    {
      title: "Manage YouTube playlists",
      description:
        "Playlists of the connected channel. create (title, description, privacy_status public|unlisted|private, default_language, localizations); update (playlist_id; only what you send changes, localizations_remove); delete (playlist_id; the videos stay, needs `confirm`); " +
        "add_video (playlist_id, video_id, position, note), update_video (playlist_id, item_id: move with position or change note), remove_video (playlist_id, item_id, needs `confirm`); " +
        "set_image / replace_image (playlist_id, image_url: square JPEG or PNG; replace needs `confirm`), delete_image (needs `confirm`). " +
        YOUTUBE_QUOTA,
      inputSchema: {
        action: actionEnum(PLAYLIST_ROUTES),
        user: userField,
        playlist_id: idField("The playlist (every action but create)."),
        item_id: idField("update_video / remove_video: the playlist item id from youtube_read playlist_items (not the video id)."),
        params: paramsField("See the description for each action's fields."),
        confirm: apiConfirmField,
      },
      outputSchema: genericResultOutputSchema,
      annotations: writeAnnotations("Manage YouTube playlists"),
    },
    run(PLAYLIST_ROUTES)
  );

  const comments = server.registerTool(
    "manage_youtube_comments",
    {
      title: "Manage YouTube comments",
      description:
        "Comments on the connected channel's videos, as the channel. create (text, and parent_id to reply or video_id for a new comment; idempotency_key); edit (comment_id, text: only the channel's own comments); delete (comment_id, own comments only, needs `confirm`); " +
        "moderate (comment_ids up to 50, status published|heldForReview|rejected, ban_author; rejected or banning needs `confirm`). Read them with youtube_read comments. " +
        YOUTUBE_QUOTA,
      inputSchema: {
        action: actionEnum(COMMENT_ROUTES),
        user: userField,
        comment_id: idField("edit / delete: the comment."),
        params: paramsField("See the description for each action's fields."),
        confirm: apiConfirmField,
      },
      outputSchema: genericResultOutputSchema,
      annotations: writeAnnotations("Manage YouTube comments"),
    },
    run(COMMENT_ROUTES)
  );

  const channel = server.registerTool(
    "manage_youtube_channel",
    {
      title: "Manage the YouTube channel",
      description:
        "Settings of the connected channel. update (description, keywords, country, default_language, unsubscribed_trailer, localizations {lang: {title, description}}, localizations_remove; only what you send changes; the channel name cannot be changed here); " +
        "channel page sections: create_section (type, title, playlists, channels, position 0-9), update_section / delete_section (section_id; delete needs `confirm`); " +
        "set_banner (image_url); set_watermark (image_url, timing_type, offset_ms, duration_ms; needs `confirm`), remove_watermark (needs `confirm`); " +
        "subscribe (channel_id) and unsubscribe (subscription_id from youtube_read subscriptions). " +
        YOUTUBE_QUOTA,
      inputSchema: {
        action: actionEnum(CHANNEL_ROUTES),
        user: userField,
        section_id: idField("update_section / delete_section: the section."),
        subscription_id: idField("unsubscribe: the subscription id."),
        params: paramsField("See the description for each action's fields."),
        confirm: apiConfirmField,
      },
      outputSchema: genericResultOutputSchema,
      annotations: writeAnnotations("Manage the YouTube channel"),
    },
    run(CHANNEL_ROUTES)
  );

  const videos = server.registerTool(
    "manage_youtube_videos",
    {
      title: "Manage YouTube videos",
      description:
        "Per-video actions on the connected channel (edit title, description, tags, privacy and translations with edit_post). rate (video_id, rating like|dislike|none); set_thumbnail (video_id, thumbnail_url); " +
        "captions: upload_caption (video_id, file_url, language, name, is_draft; 400+ units, more than a free plan's whole day), update_caption (caption_id, file_url and/or is_draft false to publish a draft; replacing the file needs `confirm`), delete_caption (caption_id, needs `confirm`). " +
        YOUTUBE_QUOTA,
      inputSchema: {
        action: actionEnum(VIDEO_ROUTES),
        user: userField,
        video_id: idField("rate / set_thumbnail / upload_caption: the video."),
        caption_id: idField("update_caption / delete_caption: the track id from youtube_read captions."),
        params: paramsField("See the description for each action's fields."),
        confirm: apiConfirmField,
      },
      outputSchema: genericResultOutputSchema,
      annotations: writeAnnotations("Manage YouTube videos"),
    },
    run(VIDEO_ROUTES)
  );

  const live = server.registerTool(
    "manage_youtube_live",
    {
      title: "Manage YouTube live",
      description:
        "Live broadcasts of the connected channel. Upload-Post does not send video: it returns the ingestion URL and stream key for the user's encoder (the key is a secret; share it only with the user). " +
        "create_broadcast (title, scheduled_start_time, privacy_status, description, made_for_kids, enable_auto_start, enable_auto_stop, latency_preference…; create_stream true also creates and binds a stream), update_broadcast, delete_broadcast (needs `confirm`); " +
        "bind (stream_id, or unbind true); transition (status testing|live|complete; live and complete need `confirm`); insert_cuepoint (duration_secs: an ad break); " +
        "create_stream (title, ingestion_type, resolution, frame_rate), update_stream, delete_stream (needs `confirm`; encoders using its key stop); " +
        "live chat of the channel's own broadcasts: send_chat_message (broadcast_id or live_chat_id, message up to 200 characters or poll {question, options}; daily limit per channel), close_poll (message_id), delete_chat_message (message_id, needs `confirm`). " +
        YOUTUBE_QUOTA,
      inputSchema: {
        action: actionEnum(LIVE_ROUTES),
        user: userField,
        broadcast_id: idField("The broadcast (update, delete, bind, transition, insert_cuepoint; or the chat to write to)."),
        stream_id: idField("update_stream / delete_stream, or the stream to bind."),
        message_id: idField("close_poll / delete_chat_message: the chat message."),
        params: paramsField("See the description for each action's fields."),
        confirm: apiConfirmField,
      },
      outputSchema: genericResultOutputSchema,
      annotations: writeAnnotations("Manage YouTube live"),
    },
    run(LIVE_ROUTES)
  );

  return [read, playlists, comments, channel, videos, live];
}
