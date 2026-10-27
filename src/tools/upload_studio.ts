import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredResource, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PhotoPlatform, REDDIT_ENABLED, REDDIT_UNAVAILABLE, VideoPlatform } from "../schemas.js";

// The URI keeps its historical "video" name: ChatGPT caches the template by URI.
const UPLOAD_STUDIO_URI = "ui://upload-post/video-upload-studio.html";
const WIDGET_DOMAIN = (
  process.env.UPLOAD_POST_WIDGET_DOMAIN ??
  process.env.OAUTH_ISSUER ??
  "https://mcp.upload-post.com"
).replace(/\/$/, "");
const DEFAULT_R2_CONNECT_DOMAINS = [
  "https://0de16d5f5e344fe4757ecd62640a9ea3.r2.cloudflarestorage.com",
  "https://upload-post-schedulers-eu3.0de16d5f5e344fe4757ecd62640a9ea3.r2.cloudflarestorage.com",
  "https://346a933178393d200f7a17065933e0bd.r2.cloudflarestorage.com",
  "https://upload-post-schedulers-eu3.346a933178393d200f7a17065933e0bd.r2.cloudflarestorage.com",
];
const R2_CONNECT_DOMAINS = (
  process.env.UPLOAD_POST_R2_CONNECT_DOMAINS ??
  process.env.UPLOAD_POST_R2_CONNECT_DOMAIN ??
  DEFAULT_R2_CONNECT_DOMAINS.join(",")
)
  .split(",")
  .map((domain) => domain.trim().replace(/\/$/, ""))
  .filter(Boolean);

/** REELS/STORIES for video, IMAGE (feed)/STORIES for photos. */
const InstagramMediaType = z.enum(["REELS", "STORIES", "IMAGE"]);
const StudioMediaType = z.enum(["video", "photos"]);
const StudioPlatform = z
  .enum([
    ...new Set([...VideoPlatform.options, ...PhotoPlatform.options]),
  ] as [string, ...string[]])
  .describe(`Target social platform. ${REDDIT_UNAVAILABLE}`);

/** Max images per carousel in the Studio (Instagram's carousel limit). */
export const STUDIO_MAX_PHOTOS = 10;

const resourceMeta = {
  ui: {
    prefersBorder: true,
    domain: WIDGET_DOMAIN,
    csp: {
      connectDomains: R2_CONNECT_DOMAINS,
      resourceDomains: [],
    },
  },
  "openai/widgetDescription":
    "A compact Upload-Post uploader that stages a local video, or one or more images for a carousel, in Upload-Post/R2, then publishes through upload_video or upload_photos.",
  "openai/widgetPrefersBorder": true,
  "openai/widgetDomain": WIDGET_DOMAIN,
  "openai/widgetCSP": {
    connect_domains: R2_CONNECT_DOMAINS,
    resource_domains: [],
  },
};

export interface UploadStudioHandles {
  tool: RegisteredTool;
  resource: RegisteredResource;
}

/**
 * ChatGPT-only. The widget uses the Apps SDK bridge (`window.openai`,
 * `text/html+skybridge`); `buildServer` disables both handles for other hosts.
 */
export function registerUploadStudio(server: McpServer): UploadStudioHandles {
  const resource = server.registerResource(
    "upload-post-video-upload-studio",
    UPLOAD_STUDIO_URI,
    {
      title: "Upload-Post Upload Studio",
      description: "Browser UI for uploading and publishing a video, a photo or a photo carousel with Upload-Post.",
      mimeType: "text/html+skybridge",
      _meta: resourceMeta,
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/html+skybridge",
          text: uploadStudioHtml,
          _meta: resourceMeta,
        },
      ],
    })
  );

  const tool = server.registerTool(
    "open_upload_studio",
    {
      title: "Open upload studio",
      description:
        "Open the upload studio in the user's browser for local or attached videos AND images (one photo or a carousel of up to " +
        STUDIO_MAX_PHOTOS +
        " images). Use this FIRST when the user attaches a video or image(s) and does not provide a public HTTPS URL. Do not try upload_video or upload_photos with /mnt/data, sandbox, or other mounted local paths first: a hosted MCP server cannot read files on the client's machine. Pass `mediaType: \"photos\"` for images/carousels and `\"video\"` (default) for a video. The Studio lets the user select the file(s) in the browser, stages them in short-lived Upload-Post storage, and publishes them through Upload-Post; for photos it can also hand the staged media URLs back to you, in order, to pass to upload_photos (for example to set a different caption per platform). " +
        REDDIT_UNAVAILABLE,
      inputSchema: {
        mediaType: StudioMediaType.optional().describe(
          "What the user wants to publish: \"video\" (default) or \"photos\" (one image or a carousel)."
        ),
        user: z.string().optional().describe("Optional Upload-Post profile name to prefill."),
        platforms: z
          .array(StudioPlatform)
          .optional()
          .describe(`Optional platforms to preselect. ${REDDIT_UNAVAILABLE}`),
        title: z.string().optional().describe("Optional caption/title to prefill."),
        description: z.string().optional().describe("Optional description to prefill."),
        firstComment: z.string().optional().describe("Optional first comment to prefill."),
        instagramMediaType: InstagramMediaType.optional().describe(
          "Instagram format to preselect: REELS or STORIES for video, IMAGE (feed) or STORIES for photos."
        ),
      },
      outputSchema: {
        mediaType: StudioMediaType,
        user: z.string(),
        platforms: z.array(StudioPlatform),
        title: z.string(),
        description: z.string(),
        firstComment: z.string(),
        instagramMediaType: InstagramMediaType,
      },
      annotations: {
        title: "Open upload studio",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
      _meta: {
        ui: {
          resourceUri: UPLOAD_STUDIO_URI,
          visibility: ["model", "app"],
        },
        "openai/outputTemplate": UPLOAD_STUDIO_URI,
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Opening upload studio…",
        "openai/toolInvocation/invoked": "Upload studio opened",
      },
    },
    async (args) => {
      const input = args as {
        mediaType?: z.infer<typeof StudioMediaType>;
        user?: string;
        platforms?: string[];
        title?: string;
        description?: string;
        firstComment?: string;
        instagramMediaType?: z.infer<typeof InstagramMediaType>;
      };
      const mediaType = input.mediaType ?? "video";
      const title = input.title ?? input.description ?? "";
      const igDefault = mediaType === "photos" ? "IMAGE" : "REELS";
      const ig = input.instagramMediaType;
      // REELS is video-only and IMAGE photo-only; fall back to that kind's default.
      const instagramMediaType =
        !ig || (mediaType === "photos" ? ig === "REELS" : ig === "IMAGE") ? igDefault : ig;
      return {
        structuredContent: {
          mediaType,
          user: input.user ?? "",
          platforms: input.platforms?.length ? input.platforms : ["instagram"],
          title,
          description: input.description ?? title,
          firstComment: input.firstComment ?? "",
          instagramMediaType,
        },
        content: [
          {
            type: "text",
            text:
              mediaType === "photos"
                ? "Upload-Post photo studio is ready. The user selects one image or several for a carousel."
                : "Upload-Post video studio is ready.",
          },
        ],
      };
    }
  );

  return { tool, resource };
}

const uploadStudioHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root {
        color-scheme: light dark;
        --bg: #f7f4ee;
        --panel: #fffaf2;
        --ink: #211b14;
        --muted: #756b5d;
        --line: #dfd4c2;
        --accent: #ff6a3d;
        --accent-ink: #fff7f0;
        --soft: #efe6d8;
        --ok: #147b52;
        --warn: #a14b10;
        --bad: #b42318;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #151311;
          --panel: #201c18;
          --ink: #f6efe5;
          --muted: #b7aa98;
          --line: #3a3027;
          --soft: #2b251f;
          --accent: #ff7a4f;
          --accent-ink: #1e120d;
          --ok: #54c897;
          --warn: #f5a15d;
          --bad: #ff7a70;
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--ink);
      }
      .shell {
        max-width: 980px;
        margin: 0 auto;
        padding: 18px;
      }
      .top {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 16px;
      }
      .eyebrow {
        margin: 0 0 4px;
        color: var(--muted);
        font-size: 12px;
        letter-spacing: .14em;
        text-transform: uppercase;
      }
      h1 {
        margin: 0;
        font-size: 24px;
        line-height: 1.1;
      }
      .chip {
        border: 1px solid var(--line);
        border-radius: 999px;
        padding: 6px 10px;
        color: var(--muted);
        background: color-mix(in srgb, var(--panel) 78%, transparent);
        font-size: 12px;
        white-space: nowrap;
      }
      .grid {
        display: grid;
        grid-template-columns: minmax(260px, .85fr) minmax(320px, 1.15fr);
        gap: 14px;
      }
      .panel {
        border: 1px solid var(--line);
        border-radius: 22px;
        background: var(--panel);
        box-shadow: 0 18px 40px rgba(49, 35, 16, .08);
      }
      .drop {
        min-height: 360px;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      .dropTarget {
        border: 1.5px dashed var(--line);
        border-radius: 18px;
        background: var(--soft);
        min-height: 170px;
        display: grid;
        place-items: center;
        text-align: center;
        padding: 16px;
        transition: border-color .16s ease, transform .16s ease;
      }
      .dropTarget.is-over {
        border-color: var(--accent);
        transform: translateY(-1px);
      }
      .dropTitle {
        margin: 0 0 6px;
        font-size: 17px;
        font-weight: 700;
      }
      .dropHint {
        margin: 0;
        color: var(--muted);
        font-size: 13px;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      button {
        appearance: none;
        border: 1px solid var(--line);
        border-radius: 12px;
        background: var(--panel);
        color: var(--ink);
        padding: 10px 12px;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
      }
      button.primary {
        border-color: color-mix(in srgb, var(--accent) 75%, var(--line));
        background: var(--accent);
        color: var(--accent-ink);
      }
      button:disabled {
        cursor: not-allowed;
        opacity: .58;
      }
      #connectButton {
        margin-top: 12px;
      }
      #connectButton[hidden] {
        display: none;
      }
      .fileMeta {
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 10px;
        color: var(--muted);
        font-size: 13px;
        word-break: break-word;
      }
      video {
        width: 100%;
        max-height: 260px;
        border-radius: 16px;
        background: #000;
      }
      .form {
        padding: 16px;
      }
      .row {
        display: grid;
        grid-template-columns: 1fr 170px;
        gap: 10px;
      }
      label {
        display: block;
        margin: 0 0 6px;
        color: var(--muted);
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: .08em;
      }
      input[type="text"], textarea, select {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 13px;
        background: color-mix(in srgb, var(--panel) 90%, white 10%);
        color: var(--ink);
        padding: 11px 12px;
        font: inherit;
        outline: none;
      }
      textarea {
        min-height: 126px;
        resize: vertical;
      }
      input[type="text"]:focus, textarea:focus, select:focus {
        border-color: var(--accent);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
      }
      .field {
        margin-bottom: 13px;
      }
      .platforms {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      .platform {
        display: flex;
        align-items: center;
        gap: 8px;
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 9px 10px;
        background: color-mix(in srgb, var(--panel) 86%, var(--soft));
        color: var(--ink);
        font-size: 13px;
        text-transform: none;
        letter-spacing: 0;
      }
      .platform input {
        accent-color: var(--accent);
      }
      .footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        border-top: 1px solid var(--line);
        margin-top: 14px;
        padding-top: 14px;
      }
      .status {
        color: var(--muted);
        font-size: 13px;
      }
      .status[data-tone="ok"] { color: var(--ok); }
      .status[data-tone="warn"] { color: var(--warn); }
      .status[data-tone="bad"] { color: var(--bad); }
      pre {
        display: none;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        margin: 14px 0 0;
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 12px;
        background: var(--soft);
        color: var(--ink);
        font-size: 12px;
      }
      .thumbs {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
        gap: 8px;
      }
      .thumbs[hidden] { display: none; }
      .thumb {
        position: relative;
        margin: 0;
        aspect-ratio: 1 / 1;
        border: 1px solid var(--line);
        border-radius: 12px;
        overflow: hidden;
        background: var(--soft);
      }
      .thumb img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .thumbName {
        padding: 8px;
        font-size: 12px;
        color: var(--muted);
        word-break: break-word;
      }
      .thumbIndex {
        position: absolute;
        top: 6px;
        left: 6px;
        min-width: 22px;
        padding: 2px 6px;
        border-radius: 999px;
        background: var(--accent);
        color: var(--accent-ink);
        font-size: 12px;
        font-weight: 700;
        text-align: center;
      }
      .thumbTools {
        position: absolute;
        right: 4px;
        bottom: 4px;
        display: flex;
        gap: 4px;
      }
      .thumbTools button {
        padding: 2px 7px;
        border-radius: 8px;
        font-size: 12px;
        line-height: 1.4;
      }
      @media (max-width: 760px) {
        .shell { padding: 14px; }
        .grid, .row { grid-template-columns: 1fr; }
        .platforms { grid-template-columns: 1fr; }
        .top, .footer { flex-direction: column; align-items: stretch; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header class="top">
        <div>
          <p class="eyebrow">Upload-Post</p>
          <h1 id="studioTitle">Video upload studio</h1>
        </div>
        <div id="statusChip" class="chip">Ready</div>
      </header>

      <main class="grid">
        <section class="panel drop">
          <div id="dropTarget" class="dropTarget">
            <div>
              <p id="dropTitle" class="dropTitle">Select a video or images</p>
              <p id="dropHint" class="dropHint">One video (MP4/MOV recommended), or up to 10 images (JPG, PNG, WEBP, GIF) for a carousel. Files upload to Upload-Post staging only when you publish.</p>
            </div>
          </div>
          <input id="fileInput" type="file" accept="video/*,image/jpeg,image/png,image/webp,image/gif" multiple hidden />
          <div class="actions">
            <button id="pickButton" type="button">Choose files</button>
            <button id="libraryButton" type="button">ChatGPT files</button>
          </div>
          <div id="fileMeta" class="fileMeta">Nothing selected yet.</div>
          <video id="preview" controls hidden></video>
          <div id="thumbs" class="thumbs" hidden></div>
        </section>

        <section class="panel form">
          <div class="row">
            <div class="field">
              <label for="profile">Profile</label>
              <input id="profile" type="text" autocomplete="off" placeholder="automated-tests" />
            </div>
            <div class="field">
              <label for="instagramFormat">Instagram</label>
              <select id="instagramFormat"></select>
            </div>
          </div>

          <div class="field">
            <label>Platforms</label>
            <div id="platforms" class="platforms"></div>
          </div>

          <div class="field">
            <label for="caption">Caption</label>
            <textarea id="caption" placeholder="Write the post caption..."></textarea>
          </div>

          <div class="field">
            <label for="firstComment">First comment</label>
            <input id="firstComment" type="text" placeholder="Optional" />
          </div>

          <div class="footer">
            <div id="statusText" class="status">Waiting for a video or images.</div>
            <div class="actions">
              <button id="handoffButton" type="button" hidden>Send to ChatGPT</button>
              <button id="publishButton" class="primary" type="button">Publish video</button>
            </div>
          </div>
          <pre id="result"></pre>
          <button id="connectButton" class="primary" type="button" hidden>Connect accounts</button>
        </section>
      </main>
    </div>

    <script>
      (function () {
        var openai = window.openai || {};
        // [value, label, video, photos]
        var platformDefs = [
          ["instagram", "Instagram", true, true],
          ["tiktok", "TikTok", true, true],
          ["youtube", "YouTube", true, false],
          ["linkedin", "LinkedIn", true, true],
          ["facebook", "Facebook", true, true],
          ["pinterest", "Pinterest", true, true],
          ["threads", "Threads", true, true],
${REDDIT_ENABLED ? `          ["reddit", "Reddit", true, true],\n` : ""}          ["bluesky", "Bluesky", true, true],
          ["x", "X", true, true],
          ["google_business", "Google Business", true, true],
          ["discord", "Discord", true, true],
          ["telegram", "Telegram", true, true],
          ["mastodon", "Mastodon", true, true],
          ["lemmy", "Lemmy", false, true],
          ["wordpress", "WordPress", true, true]
        ];
        var instagramFormats = {
          video: [["REELS", "Reels"], ["STORIES", "Stories"]],
          photos: [["IMAGE", "Feed"], ["STORIES", "Stories"]]
        };
        var state = {
          kind: "video",
          // Each item: { file, fileId, fileName, mimeType, size, previewUrl, mediaUrl }
          items: [],
          stagedMediaUrls: []
        };

        var els = {
          studioTitle: document.getElementById("studioTitle"),
          statusChip: document.getElementById("statusChip"),
          statusText: document.getElementById("statusText"),
          fileInput: document.getElementById("fileInput"),
          pickButton: document.getElementById("pickButton"),
          libraryButton: document.getElementById("libraryButton"),
          dropTarget: document.getElementById("dropTarget"),
          fileMeta: document.getElementById("fileMeta"),
          preview: document.getElementById("preview"),
          thumbs: document.getElementById("thumbs"),
          profile: document.getElementById("profile"),
          instagramFormat: document.getElementById("instagramFormat"),
          platforms: document.getElementById("platforms"),
          caption: document.getElementById("caption"),
          firstComment: document.getElementById("firstComment"),
          handoffButton: document.getElementById("handoffButton"),
          publishButton: document.getElementById("publishButton"),
          result: document.getElementById("result"),
          connectButton: document.getElementById("connectButton")
        };
        var connectUrl = "";
        // Kind the platform list and Instagram formats were last drawn for.
        var renderedKind = "";

        function initialData() {
          var persisted = (openai.widgetState && openai.widgetState.uploadPostStudio) || {};
          return Object.assign(
            {},
            persisted.form || {},
            openai.toolOutput || {},
            openai.toolInput || {}
          );
        }

        function setStatus(text, tone) {
          els.statusText.textContent = text;
          els.statusText.dataset.tone = tone || "";
          els.statusChip.textContent = tone === "ok" ? "Ready" : tone === "bad" ? "Needs attention" : "Working";
          notifyHeight();
        }

        function notifyHeight() {
          if (!openai.notifyIntrinsicHeight) return;
          window.requestAnimationFrame(function () {
            openai.notifyIntrinsicHeight(document.body.scrollHeight);
          });
        }

        function renderPlatforms(selected) {
          var selectedSet = new Set((selected && selected.length ? selected : ["instagram"]).map(String));
          var photos = state.kind === "photos";
          var available = platformDefs.filter(function (item) {
            return photos ? item[3] : item[2];
          });
          if (!available.some(function (item) { return selectedSet.has(item[0]); })) {
            selectedSet = new Set(["instagram"]);
          }
          els.platforms.innerHTML = "";
          available.forEach(function (item) {
            var value = item[0];
            var label = item[1];
            var wrap = document.createElement("label");
            wrap.className = "platform";
            var input = document.createElement("input");
            input.type = "checkbox";
            input.value = value;
            input.checked = selectedSet.has(value);
            input.addEventListener("change", saveState);
            var span = document.createElement("span");
            span.textContent = label;
            wrap.appendChild(input);
            wrap.appendChild(span);
            els.platforms.appendChild(wrap);
          });
        }

        function renderInstagramFormats(value) {
          var options = instagramFormats[state.kind] || instagramFormats.video;
          var keep = options.some(function (item) { return item[0] === value; }) ? value : options[0][0];
          els.instagramFormat.innerHTML = "";
          options.forEach(function (item) {
            var option = document.createElement("option");
            option.value = item[0];
            option.textContent = item[1];
            els.instagramFormat.appendChild(option);
          });
          els.instagramFormat.value = keep;
        }

        function selectedPlatforms() {
          return Array.from(els.platforms.querySelectorAll("input:checked")).map(function (input) {
            return input.value;
          });
        }

        function currentForm() {
          return {
            mediaType: state.kind,
            user: els.profile.value.trim(),
            platforms: selectedPlatforms(),
            title: els.caption.value.trim(),
            description: els.caption.value.trim(),
            firstComment: els.firstComment.value.trim(),
            instagramMediaType: els.instagramFormat.value
          };
        }

        function saveState() {
          if (!openai.setWidgetState) return;
          openai.setWidgetState({
            uploadPostStudio: {
              form: currentForm(),
              files: state.items.map(function (item) {
                return { fileId: item.fileId, fileName: item.fileName, mimeType: item.mimeType };
              }),
              // Staged media URLs in carousel order, so the model can pass them to upload_photos.
              stagedMediaUrls: state.stagedMediaUrls
            }
          });
        }

        // Re-label the Studio for the kind of media being published.
        function setKind(kind) {
          state.kind = kind === "photos" ? "photos" : "video";
          if (renderedKind !== state.kind || !els.platforms.children.length) {
            renderedKind = state.kind;
            var keepPlatforms = els.platforms.children.length ? selectedPlatforms() : null;
            renderPlatforms(keepPlatforms || initialData().platforms);
            renderInstagramFormats(els.instagramFormat.value || initialData().instagramMediaType);
          }
          var count = state.items.length;
          var photos = state.kind === "photos";
          els.studioTitle.textContent = photos
            ? (count > 1 ? "Carousel upload studio" : "Photo upload studio")
            : "Video upload studio";
          els.publishButton.textContent = photos
            ? (count > 1 ? "Publish carousel" : "Publish photo")
            : "Publish video";
          els.handoffButton.hidden = !(photos && openai.sendFollowUpMessage);
        }

        function formatBytes(bytes) {
          if (!bytes && bytes !== 0) return "";
          var units = ["B", "KB", "MB", "GB"];
          var size = bytes;
          var unit = 0;
          while (size >= 1024 && unit < units.length - 1) {
            size = size / 1024;
            unit += 1;
          }
          return size.toFixed(unit === 0 ? 0 : 1) + " " + units[unit];
        }

        // --- media selection (pure helpers, exercised by scripts/check-connect-guidance.mjs) ---
        var MAX_PHOTOS = 10;
        var VIDEO_EXT = /\\.(mp4|mov|m4v|webm|mpeg|mpg|avi|mkv)$/i;
        var IMAGE_EXT = /\\.(jpe?g|png|webp|gif)$/i;
        var IMAGE_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"];

        function fileKind(name, type) {
          var mime = String(type || "").toLowerCase();
          if (mime.indexOf("video/") === 0 || VIDEO_EXT.test(name || "")) return "video";
          if (IMAGE_TYPES.indexOf(mime) >= 0 || IMAGE_EXT.test(name || "")) return "image";
          if (mime.indexOf("image/") === 0) return "unsupported-image";
          return "";
        }

        function guessImageMime(name, type) {
          var mime = String(type || "").toLowerCase();
          if (IMAGE_TYPES.indexOf(mime) >= 0) return mime === "image/jpg" ? "image/jpeg" : mime;
          var match = /\\.([a-z0-9]+)$/i.exec(name || "");
          var ext = match ? match[1].toLowerCase() : "";
          if (ext === "png") return "image/png";
          if (ext === "webp") return "image/webp";
          if (ext === "gif") return "image/gif";
          return "image/jpeg";
        }

        // items: [{ name, type }] -> { kind: "video" | "photos" } or { error }
        function classifySelection(items) {
          if (!items || !items.length) return { error: "Select a video, or one or more images." };
          var kinds = items.map(function (item) { return fileKind(item.name, item.type); });
          if (kinds.indexOf("unsupported-image") >= 0) {
            return { error: "That image format is not supported. Use JPG, PNG, WEBP or GIF (export HEIC photos as JPG)." };
          }
          if (kinds.indexOf("") >= 0) {
            return { error: "Only videos and images (JPG, PNG, WEBP, GIF) can be published from here." };
          }
          if (kinds.indexOf("video") >= 0) {
            if (items.length > 1) {
              return { error: "Select one video, or one or more images for a carousel. Videos and images can't be mixed in one post." };
            }
            return { kind: "video" };
          }
          if (items.length > MAX_PHOTOS) {
            return { error: "Select up to " + MAX_PHOTOS + " images per carousel (you picked " + items.length + ")." };
          }
          return { kind: "photos" };
        }

        function parseToolJson(result) {
          if (!result) throw new Error("Tool returned no response.");
          if (result.structuredContent) {
            // Tools wrap payloads via ok() as { result: <payload> }. Unwrap so
            // callers read fields (success, upload_url, …) at the top level,
            // matching the unwrapped JSON we'd get from the text branch below.
            var sc = result.structuredContent;
            return sc && typeof sc === "object" && "result" in sc ? sc.result : sc;
          }
          if (Array.isArray(result.content)) {
            var text = result.content.map(function (item) {
              return item && item.text ? item.text : "";
            }).join("\\n").trim();
            if (text) {
              try {
                return JSON.parse(text);
              } catch (error) {
                throw new Error(text);
              }
            }
          }
          return result;
        }

        function originFromUrl(value) {
          try {
            return new URL(value).origin;
          } catch (error) {
            return "unknown upload origin";
          }
        }

        function explainBrowserUploadFailure(error, uploadUrl) {
          var detail = error && error.message ? error.message : String(error || "Failed to fetch");
          var browserOrigin = window.location && window.location.origin ? window.location.origin : "unknown browser origin";
          var uploadOrigin = originFromUrl(uploadUrl);
          return new Error(
            "Browser could not upload the file to Upload-Post/R2 staging (" + detail + "). " +
            "This is usually R2 CORS or widget CSP. Allow the R2 bucket origin " + uploadOrigin +
            " to receive PUT requests from " + browserOrigin +
            " (or use AllowedOrigins '*'), with methods PUT, GET, HEAD and headers Content-Type or '*'."
          );
        }

        // label: "" for a video, " 2 of 5" style suffix for carousel images.
        async function stageLocalFile(item, mediaType, label) {
          var photo = mediaType === "image";
          var file = item.file;
          var contentType = item.mimeType || file.type || (photo ? "image/jpeg" : "video/mp4");
          setStatus("Creating Upload-Post upload URL" + label + "…", "warn");
          var created = parseToolJson(await openai.callTool("create_media_upload", {
            filename: item.fileName || file.name || (photo ? "chatgpt-image-upload.jpg" : "chatgpt-video-upload.mp4"),
            contentType: contentType,
            contentLength: file.size,
            mediaType: photo ? "image" : "video",
            source: "mcp_chatgpt"
          }));
          if (!created.success || !created.upload_url || !created.upload_id) {
            throw new Error(created.message || "Could not create media upload.");
          }

          setStatus(photo
            ? "Uploading image" + label + " to Upload-Post staging…"
            : "Uploading video to Upload-Post staging…", "warn");
          var putHeaders = Object.assign({}, created.headers || {});
          if (!putHeaders["Content-Type"]) putHeaders["Content-Type"] = contentType;
          var put;
          try {
            put = await fetch(created.upload_url, {
              method: created.method || "PUT",
              mode: "cors",
              headers: putHeaders,
              body: file
            });
          } catch (error) {
            throw explainBrowserUploadFailure(error, created.upload_url);
          }
          if (!put.ok) {
            throw new Error("R2 upload failed with HTTP " + put.status + ".");
          }

          setStatus("Validating staged media" + label + "…", "warn");
          var completed = parseToolJson(await openai.callTool("complete_media_upload", {
            uploadId: created.upload_id
          }));
          if (!completed.success || !completed.media_url) {
            throw new Error(completed.message || "Could not complete media upload.");
          }
          return completed.media_url;
        }

        async function libraryDownloadUrl(item, label) {
          if (!item.fileId) {
            throw new Error(state.kind === "photos" ? "Select at least one image first." : "Select a video first.");
          }
          if (!openai.getFileDownloadUrl) {
            throw new Error("ChatGPT file download URLs are not available in this session.");
          }
          setStatus("Preparing temporary download URL" + label + "…", "warn");
          var ref = await openai.getFileDownloadUrl({ fileId: item.fileId });
          var downloadUrl = typeof ref === "string" ? ref : ref.downloadUrl || ref.download_url;
          if (!downloadUrl) {
            throw new Error("ChatGPT did not return a file download URL.");
          }
          return downloadUrl;
        }

        // Stages every selected file one after another (so a carousel never holds
        // more than one unfinished staging slot) and returns the URLs in order.
        // Staged images are reused on a retry, so a failed publish does not stage
        // the whole carousel again.
        async function resolveMediaUrls() {
          var photos = state.kind === "photos";
          var total = state.items.length;
          if (!total) throw new Error(photos ? "Select at least one image first." : "Select a video first.");
          var urls = [];
          for (var i = 0; i < total; i += 1) {
            var item = state.items[i];
            var label = photos && total > 1 ? " (" + (i + 1) + " of " + total + ")" : "";
            if (photos && item.mediaUrl && item.stagedAt && Date.now() - item.stagedAt < 5 * 3600 * 1000) {
              urls.push(item.mediaUrl);
              continue;
            }
            var url = item.file
              ? await stageLocalFile(item, photos ? "image" : "video", label)
              : await libraryDownloadUrl(item, label);
            if (photos && item.file) {
              item.mediaUrl = url;
              item.stagedAt = Date.now();
            }
            urls.push(url);
          }
          state.stagedMediaUrls = photos ? urls.slice() : [];
          saveState();
          return urls;
        }
        // --- end media selection ---

        function clearSelection() {
          state.items.forEach(function (item) {
            if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
          });
          state.items = [];
          state.stagedMediaUrls = [];
          els.preview.hidden = true;
          els.preview.removeAttribute("src");
          els.thumbs.hidden = true;
          els.thumbs.innerHTML = "";
        }

        function moveItem(index, delta) {
          var target = index + delta;
          if (target < 0 || target >= state.items.length) return;
          var moved = state.items.splice(index, 1)[0];
          state.items.splice(target, 0, moved);
          renderSelection();
        }

        function removeItem(index) {
          var removed = state.items.splice(index, 1)[0];
          if (removed && removed.previewUrl) URL.revokeObjectURL(removed.previewUrl);
          renderSelection();
        }

        function renderSelection() {
          var photos = state.kind === "photos";
          var items = state.items;
          state.stagedMediaUrls = [];
          setKind(state.kind);
          els.preview.hidden = true;
          els.thumbs.innerHTML = "";
          els.thumbs.hidden = !photos || !items.length;
          if (!items.length) {
            els.fileMeta.textContent = "Nothing selected yet.";
            setStatus(photos ? "Waiting for images." : "Waiting for a video or images.", "");
            saveState();
            return;
          }
          var fromLibrary = !items[0].file;
          var where = fromLibrary ? " · ChatGPT file library" : " · Upload-Post staging";
          if (!photos) {
            var video = items[0];
            if (video.previewUrl) {
              els.preview.src = video.previewUrl;
              els.preview.hidden = false;
            }
            els.fileMeta.textContent = video.fileName + (fromLibrary ? "" : " · " + formatBytes(video.size)) + where;
            setStatus(fromLibrary ? "Library video selected. Ready to publish." : "Video selected. Ready to publish.", "ok");
            saveState();
            return;
          }
          items.forEach(function (item, index) {
            var tile = document.createElement("figure");
            tile.className = "thumb";
            if (item.previewUrl) {
              var img = document.createElement("img");
              img.src = item.previewUrl;
              img.alt = item.fileName;
              tile.appendChild(img);
            } else {
              var name = document.createElement("div");
              name.className = "thumbName";
              name.textContent = item.fileName;
              tile.appendChild(name);
            }
            var badge = document.createElement("span");
            badge.className = "thumbIndex";
            badge.textContent = String(index + 1);
            tile.appendChild(badge);
            var tools = document.createElement("div");
            tools.className = "thumbTools";
            [["←", "Move earlier", -1], ["→", "Move later", 1]].forEach(function (def) {
              var button = document.createElement("button");
              button.type = "button";
              button.textContent = def[0];
              button.title = def[1];
              button.disabled = items.length < 2 || (def[2] < 0 ? index === 0 : index === items.length - 1);
              button.addEventListener("click", function () { moveItem(index, def[2]); });
              tools.appendChild(button);
            });
            var remove = document.createElement("button");
            remove.type = "button";
            remove.textContent = "×";
            remove.title = "Remove";
            remove.addEventListener("click", function () { removeItem(index); });
            tools.appendChild(remove);
            tile.appendChild(tools);
            els.thumbs.appendChild(tile);
          });
          var totalBytes = items.reduce(function (sum, item) { return sum + (item.size || 0); }, 0);
          var summary = items.length === 1 ? items[0].fileName : items.length + " images, published in this order";
          els.fileMeta.textContent = summary + (fromLibrary ? "" : " · " + formatBytes(totalBytes)) + where;
          setStatus(items.length > 1 ? "Carousel selected. Ready to publish." : "Image selected. Ready to publish.", "ok");
          saveState();
        }

        function setLocalFiles(fileList) {
          var files = Array.from(fileList || []);
          if (!files.length) return;
          var verdict = classifySelection(files.map(function (file) {
            return { name: file.name || "", type: file.type || "" };
          }));
          if (verdict.error) {
            setStatus(verdict.error, "bad");
            return;
          }
          clearSelection();
          state.kind = verdict.kind;
          state.items = files.map(function (file, index) {
            var photo = verdict.kind === "photos";
            return {
              file: file,
              fileId: "",
              fileName: file.name || (photo ? "chatgpt-image-" + (index + 1) + ".jpg" : "chatgpt-video-upload.mp4"),
              mimeType: photo ? guessImageMime(file.name, file.type) : (file.type || "video/mp4"),
              size: file.size,
              previewUrl: URL.createObjectURL(file)
            };
          });
          renderSelection();
        }

        async function setLibraryFiles() {
          if (!openai.selectFiles) return;
          var files = await openai.selectFiles();
          files = Array.isArray(files) ? files : [];
          if (!files.length) return;
          var described = files.map(function (file) {
            return {
              name: file.fileName || file.file_name || "",
              type: file.mimeType || file.mime_type || "",
              fileId: file.fileId || file.file_id || ""
            };
          });
          var verdict = classifySelection(described);
          if (verdict.error) {
            setStatus(verdict.error, "bad");
            return;
          }
          clearSelection();
          state.kind = verdict.kind;
          state.items = described.map(function (file, index) {
            var photo = verdict.kind === "photos";
            return {
              file: null,
              fileId: file.fileId,
              fileName: file.name || (photo ? "chatgpt-library-image-" + (index + 1) + ".jpg" : "chatgpt-library-video.mp4"),
              mimeType: file.type,
              size: 0,
              previewUrl: ""
            };
          });
          renderSelection();
        }

        function applyInitial() {
          var data = initialData();
          els.profile.value = data.user || "";
          els.caption.value = data.title || data.description || "";
          els.firstComment.value = data.firstComment || "";
          state.kind = data.mediaType === "photos" ? "photos" : "video";
          renderPlatforms(data.platforms);
          renderInstagramFormats(data.instagramMediaType);
          renderedKind = state.kind;
          setKind(state.kind);
          els.fileMeta.textContent = "Nothing selected yet.";
          els.statusText.textContent = state.kind === "photos" ? "Waiting for images." : "Waiting for a video or images.";
          els.libraryButton.hidden = !openai.selectFiles;
          [els.profile, els.caption, els.firstComment, els.instagramFormat].forEach(function (el) {
            el.addEventListener("input", saveState);
            el.addEventListener("change", saveState);
          });
          if (!openai.callTool) {
            setStatus("This widget must run inside ChatGPT Apps.", "bad");
            els.publishButton.disabled = true;
            els.handoffButton.disabled = true;
          }
          notifyHeight();
        }

        function resultText(result) {
          if (!result) return "No response.";
          if (Array.isArray(result.content)) {
            return result.content.map(function (item) {
              return item && item.text ? item.text : JSON.stringify(item);
            }).join("\\n");
          }
          if (result.structuredContent) return JSON.stringify(result.structuredContent, null, 2);
          return JSON.stringify(result, null, 2);
        }

        // upload_* answers "connect your accounts first" with a connect_url
        // (structured) and the same link in the text.
        function findConnectUrl(result) {
          var structured = result && result.structuredContent && result.structuredContent.result;
          if (structured && typeof structured.connect_url === "string") return structured.connect_url;
          var match = /https:\\/\\/app\\.upload-post\\.com\\/(?:connect\\?token=[^\\s"')]+|manage-users)/.exec(resultText(result));
          return match ? match[0].replace(/[.,;:]+$/, "") : "";
        }

        function showConnect(url) {
          connectUrl = url || "";
          els.connectButton.hidden = !connectUrl;
        }

        function requireForm() {
          var form = currentForm();
          if (!form.user) throw new Error("Profile is required.");
          if (!form.platforms.length) throw new Error("Select at least one platform.");
          if (!state.items.length) {
            throw new Error(state.kind === "photos" ? "Select at least one image first." : "Select a video first.");
          }
          return form;
        }

        async function publish() {
          var form = requireForm();
          var photos = state.kind === "photos";
          var urls = await resolveMediaUrls();
          var platformOptions = {};
          if (form.platforms.indexOf("instagram") >= 0) {
            platformOptions.instagramMediaType = form.instagramMediaType;
          }
          var toolName = photos ? "upload_photos" : "upload_video";
          var payload = photos
            ? {
                photosPathsOrUrls: urls,
                user: form.user,
                platforms: form.platforms,
                title: form.title,
                description: form.description,
                firstComment: form.firstComment || undefined,
                asyncUpload: true,
                platformOptions: platformOptions
              }
            : {
                videoPathOrUrl: urls[0],
                videoFilename: state.items[0].fileName || "chatgpt-video-upload.mp4",
                user: form.user,
                platforms: form.platforms,
                title: form.title,
                description: form.description,
                firstComment: form.firstComment || undefined,
                asyncUpload: true,
                platformOptions: platformOptions
              };
          setStatus("Calling Upload-Post…", "warn");
          var result = await openai.callTool(toolName, payload);
          els.result.style.display = "block";
          els.result.textContent = resultText(result);
          showConnect(findConnectUrl(result));
          if (result && result.isError) {
            setStatus(connectUrl
              ? "Connect your social accounts, then publish again."
              : (photos ? "Upload-Post could not publish these images." : "Upload-Post could not publish this video."), "bad");
            return;
          }
          setStatus("Upload queued. You can close this window; request_id is only for optional status checks.", "ok");
        }

        // Stage the images and hand the URLs back to ChatGPT, which then calls
        // upload_photos itself (e.g. with a different caption per platform).
        async function handOff() {
          if (state.kind !== "photos") return;
          if (!state.items.length) throw new Error("Select at least one image first.");
          var form = currentForm();
          var urls = await resolveMediaUrls();
          var lines = [
            "The Upload-Post studio staged " + urls.length + (urls.length === 1 ? " image" : " images (a carousel)") + ".",
            "Publish them with upload_photos, passing photosPathsOrUrls exactly in this order:",
            JSON.stringify(urls)
          ];
          if (form.user) lines.push("Profile (user): " + form.user);
          if (form.platforms.length) lines.push("Platforms: " + form.platforms.join(", "));
          if (form.title) lines.push("Caption: " + form.title);
          if (form.firstComment) lines.push("First comment: " + form.firstComment);
          lines.push("The staged URLs stay valid for a few hours. Ask me for anything still missing, such as a different caption per platform, before publishing.");
          setStatus("Sending the staged images to ChatGPT…", "warn");
          await openai.sendFollowUpMessage({ prompt: lines.join("\\n") });
          setStatus("Images staged and sent to ChatGPT.", "ok");
        }

        els.pickButton.addEventListener("click", function () {
          els.fileInput.click();
        });
        els.fileInput.addEventListener("change", function (event) {
          setLocalFiles(event.target.files);
          event.target.value = "";
        });
        els.libraryButton.addEventListener("click", function () {
          setLibraryFiles().catch(function (error) {
            setStatus(error.message || String(error), "bad");
          });
        });
        ["dragenter", "dragover"].forEach(function (name) {
          els.dropTarget.addEventListener(name, function (event) {
            event.preventDefault();
            els.dropTarget.classList.add("is-over");
          });
        });
        ["dragleave", "drop"].forEach(function (name) {
          els.dropTarget.addEventListener(name, function (event) {
            event.preventDefault();
            els.dropTarget.classList.remove("is-over");
          });
        });
        els.dropTarget.addEventListener("drop", function (event) {
          setLocalFiles(event.dataTransfer && event.dataTransfer.files);
        });
        els.connectButton.addEventListener("click", function () {
          if (!connectUrl) return;
          if (openai.openExternal) {
            openai.openExternal({ href: connectUrl });
          } else {
            window.open(connectUrl, "_blank", "noopener");
          }
        });

        function runAction(action) {
          els.publishButton.disabled = true;
          els.handoffButton.disabled = true;
          els.result.style.display = "none";
          showConnect("");
          action()
            .catch(function (error) {
              els.result.style.display = "block";
              els.result.textContent = error && error.message ? error.message : String(error);
              setStatus(error && error.message ? error.message : String(error), "bad");
            })
            .finally(function () {
              els.publishButton.disabled = false;
              els.handoffButton.disabled = false;
              saveState();
              notifyHeight();
            });
        }
        els.publishButton.addEventListener("click", function () {
          runAction(publish);
        });
        els.handoffButton.addEventListener("click", function () {
          runAction(handOff);
        });

        applyInitial();
      })();
    </script>
  </body>
</html>`;
