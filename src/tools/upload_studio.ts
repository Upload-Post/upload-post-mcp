import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VideoPlatform } from "../schemas.js";

const UPLOAD_STUDIO_URI = "ui://upload-post/video-upload-studio.html";
const WIDGET_DOMAIN = (
  process.env.UPLOAD_POST_WIDGET_DOMAIN ??
  process.env.OAUTH_ISSUER ??
  "https://mcp.upload-post.com"
).replace(/\/$/, "");
const DEFAULT_R2_CONNECT_DOMAINS = [
  "https://0de16d5f5e344fe4757ecd62640a9ea3.r2.cloudflarestorage.com",
  "https://upload-post-schedulers-eu3.0de16d5f5e344fe4757ecd62640a9ea3.r2.cloudflarestorage.com",
];
const R2_CONNECT_DOMAINS = (
  process.env.UPLOAD_POST_R2_CONNECT_DOMAINS ??
  process.env.UPLOAD_POST_R2_CONNECT_DOMAIN ??
  DEFAULT_R2_CONNECT_DOMAINS.join(",")
)
  .split(",")
  .map((domain) => domain.trim().replace(/\/$/, ""))
  .filter(Boolean);

const InstagramVideoMediaType = z.enum(["REELS", "STORIES"]);

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
    "A compact Upload-Post video uploader that stages a local video in Upload-Post/R2, then publishes through upload_video.",
  "openai/widgetPrefersBorder": true,
  "openai/widgetDomain": WIDGET_DOMAIN,
  "openai/widgetCSP": {
    connect_domains: R2_CONNECT_DOMAINS,
    resource_domains: [],
  },
};

export function registerUploadStudio(server: McpServer): void {
  server.registerResource(
    "upload-post-video-upload-studio",
    UPLOAD_STUDIO_URI,
    {
      title: "Upload-Post Video Studio",
      description: "ChatGPT UI for uploading and publishing a video with Upload-Post.",
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

  server.registerTool(
    "open_upload_studio",
    {
      title: "Open upload studio",
      description:
        "Open the ChatGPT UI for local/attached video uploads. Use this FIRST when the user attaches a video in ChatGPT or claude.ai and does not provide a public HTTPS URL. Do not try upload_video with /mnt/data, sandbox, or mounted local paths first: hosted MCP servers cannot read those files. The Studio lets the user select the file in the browser, stages it in short-lived Upload-Post/R2 storage, and publishes it through Upload-Post.",
      inputSchema: {
        user: z.string().optional().describe("Optional Upload-Post profile name to prefill."),
        platforms: z.array(VideoPlatform).optional().describe("Optional platforms to preselect."),
        title: z.string().optional().describe("Optional caption/title to prefill."),
        description: z.string().optional().describe("Optional description to prefill."),
        firstComment: z.string().optional().describe("Optional first comment to prefill."),
        instagramMediaType: InstagramVideoMediaType.optional().describe(
          "Instagram video format to preselect."
        ),
      },
      outputSchema: {
        user: z.string(),
        platforms: z.array(VideoPlatform),
        title: z.string(),
        description: z.string(),
        firstComment: z.string(),
        instagramMediaType: InstagramVideoMediaType,
      },
      annotations: {
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
        user?: string;
        platforms?: Array<z.infer<typeof VideoPlatform>>;
        title?: string;
        description?: string;
        firstComment?: string;
        instagramMediaType?: z.infer<typeof InstagramVideoMediaType>;
      };
      const title = input.title ?? input.description ?? "";
      return {
        structuredContent: {
          user: input.user ?? "",
          platforms: input.platforms?.length ? input.platforms : ["instagram"],
          title,
          description: input.description ?? title,
          firstComment: input.firstComment ?? "",
          instagramMediaType: input.instagramMediaType ?? "REELS",
        },
        content: [
          {
            type: "text",
            text: "Upload-Post video studio is ready.",
          },
        ],
      };
    }
  );
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
          <h1>Video upload studio</h1>
        </div>
        <div id="statusChip" class="chip">Ready</div>
      </header>

      <main class="grid">
        <section class="panel drop">
          <div id="dropTarget" class="dropTarget">
            <div>
              <p class="dropTitle">Select a video</p>
              <p class="dropHint">MP4/MOV recommended. The file uploads to Upload-Post staging only when you publish.</p>
            </div>
          </div>
          <input id="fileInput" type="file" accept="video/*" hidden />
          <div class="actions">
            <button id="pickButton" type="button">Choose file</button>
            <button id="libraryButton" type="button">ChatGPT files</button>
          </div>
          <div id="fileMeta" class="fileMeta">No video selected.</div>
          <video id="preview" controls hidden></video>
        </section>

        <section class="panel form">
          <div class="row">
            <div class="field">
              <label for="profile">Profile</label>
              <input id="profile" type="text" autocomplete="off" placeholder="automated-tests" />
            </div>
            <div class="field">
              <label for="instagramFormat">Instagram</label>
              <select id="instagramFormat">
                <option value="REELS">Reels</option>
                <option value="STORIES">Stories</option>
              </select>
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
            <div id="statusText" class="status">Waiting for a video.</div>
            <button id="publishButton" class="primary" type="button">Publish video</button>
          </div>
          <pre id="result"></pre>
        </section>
      </main>
    </div>

    <script>
      (function () {
        var openai = window.openai || {};
        var platformDefs = [
          ["instagram", "Instagram"],
          ["tiktok", "TikTok"],
          ["youtube", "YouTube"],
          ["linkedin", "LinkedIn"],
          ["facebook", "Facebook"],
          ["pinterest", "Pinterest"],
          ["threads", "Threads"],
          ["bluesky", "Bluesky"],
          ["x", "X"],
          ["google_business", "Google Business"]
        ];
        var state = {
          file: null,
          fileId: "",
          fileName: "",
          mimeType: "",
          previewUrl: ""
        };

        var els = {
          statusChip: document.getElementById("statusChip"),
          statusText: document.getElementById("statusText"),
          fileInput: document.getElementById("fileInput"),
          pickButton: document.getElementById("pickButton"),
          libraryButton: document.getElementById("libraryButton"),
          dropTarget: document.getElementById("dropTarget"),
          fileMeta: document.getElementById("fileMeta"),
          preview: document.getElementById("preview"),
          profile: document.getElementById("profile"),
          instagramFormat: document.getElementById("instagramFormat"),
          platforms: document.getElementById("platforms"),
          caption: document.getElementById("caption"),
          firstComment: document.getElementById("firstComment"),
          publishButton: document.getElementById("publishButton"),
          result: document.getElementById("result")
        };

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
          els.platforms.innerHTML = "";
          platformDefs.forEach(function (item) {
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

        function selectedPlatforms() {
          return Array.from(els.platforms.querySelectorAll("input:checked")).map(function (input) {
            return input.value;
          });
        }

        function currentForm() {
          return {
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
              file: {
                fileId: state.fileId,
                fileName: state.fileName,
                mimeType: state.mimeType
              }
            }
          });
        }

        function applyInitial() {
          var data = initialData();
          els.profile.value = data.user || "";
          els.caption.value = data.title || data.description || "";
          els.firstComment.value = data.firstComment || "";
          els.instagramFormat.value = data.instagramMediaType || "REELS";
          renderPlatforms(data.platforms);
          els.libraryButton.hidden = !openai.selectFiles;
          [els.profile, els.caption, els.firstComment, els.instagramFormat].forEach(function (el) {
            el.addEventListener("input", saveState);
            el.addEventListener("change", saveState);
          });
          if (!openai.callTool) {
            setStatus("This widget must run inside ChatGPT Apps.", "bad");
            els.publishButton.disabled = true;
          }
          notifyHeight();
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

        function setLocalFile(file) {
          if (!file) return;
          var name = file.name || "";
          var looksLikeVideo =
            (file.type && file.type.indexOf("video/") === 0) ||
            /\\.(mp4|mov|m4v|webm|mpeg|mpg|avi|mkv)$/i.test(name);
          if (!looksLikeVideo) {
            setStatus("Select a video file.", "bad");
            return;
          }
          if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
          state.file = file;
          state.fileId = "";
          state.fileName = file.name || "chatgpt-video-upload.mp4";
          state.mimeType = file.type || "video/mp4";
          state.previewUrl = URL.createObjectURL(file);
          els.preview.src = state.previewUrl;
          els.preview.hidden = false;
          els.fileMeta.textContent = state.fileName + " · " + formatBytes(file.size) + " · Upload-Post staging";
          setStatus("Video selected. Ready to publish.", "ok");
          saveState();
        }

        async function setLibraryFile() {
          if (!openai.selectFiles) return;
          var files = await openai.selectFiles();
          var file = files && files[0];
          if (!file) return;
          state.file = null;
          state.fileId = file.fileId || file.file_id || "";
          state.fileName = file.fileName || file.file_name || "chatgpt-library-video.mp4";
          state.mimeType = file.mimeType || file.mime_type || "";
          if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
          state.previewUrl = "";
          els.preview.hidden = true;
          els.preview.removeAttribute("src");
          els.fileMeta.textContent = state.fileName + " · ChatGPT file library";
          setStatus("Library video selected. Ready to publish.", "ok");
          saveState();
        }

        function parseToolJson(result) {
          if (!result) throw new Error("Tool returned no response.");
          if (result.structuredContent) return result.structuredContent;
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

        async function uploadLocalFileToStaging(file) {
          var contentType = state.mimeType || file.type || "video/mp4";
          setStatus("Creating Upload-Post upload URL…", "warn");
          var created = parseToolJson(await openai.callTool("create_media_upload", {
            filename: state.fileName || file.name || "chatgpt-video-upload.mp4",
            contentType: contentType,
            contentLength: file.size,
            mediaType: "video",
            source: "mcp_chatgpt"
          }));
          if (!created.success || !created.upload_url || !created.upload_id) {
            throw new Error(created.message || "Could not create media upload.");
          }

          setStatus("Uploading video to Upload-Post staging…", "warn");
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

          setStatus("Validating staged media…", "warn");
          var completed = parseToolJson(await openai.callTool("complete_media_upload", {
            uploadId: created.upload_id
          }));
          if (!completed.success || !completed.media_url) {
            throw new Error(completed.message || "Could not complete media upload.");
          }
          return completed.media_url;
        }

        async function ensureDownloadUrl() {
          if (state.file) {
            return uploadLocalFileToStaging(state.file);
          }
          if (!state.fileId) {
            throw new Error("Select a video first.");
          }
          if (!openai.getFileDownloadUrl) {
            throw new Error("ChatGPT file download URLs are not available in this session.");
          }
          setStatus("Preparing temporary download URL…", "warn");
          var ref = await openai.getFileDownloadUrl({ fileId: state.fileId });
          var downloadUrl = typeof ref === "string" ? ref : ref.downloadUrl || ref.download_url;
          if (!downloadUrl) {
            throw new Error("ChatGPT did not return a file download URL.");
          }
          return downloadUrl;
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

        async function publish() {
          var form = currentForm();
          if (!form.user) throw new Error("Profile is required.");
          if (!form.platforms.length) throw new Error("Select at least one platform.");
          if (!state.file && !state.fileId) throw new Error("Select a video first.");
          var downloadUrl = await ensureDownloadUrl();
          var platformOptions = {};
          if (form.platforms.indexOf("instagram") >= 0) {
            platformOptions.instagramMediaType = form.instagramMediaType;
          }
          var payload = {
            videoPathOrUrl: downloadUrl,
            videoFilename: state.fileName || "chatgpt-video-upload.mp4",
            user: form.user,
            platforms: form.platforms,
            title: form.title,
            description: form.description,
            firstComment: form.firstComment || undefined,
            asyncUpload: true,
            platformOptions: platformOptions
          };
          setStatus("Calling Upload-Post…", "warn");
          var result = await openai.callTool("upload_video", payload);
          els.result.style.display = "block";
          els.result.textContent = resultText(result);
          setStatus("Upload started. Poll status with request_id.", "ok");
        }

        els.pickButton.addEventListener("click", function () {
          els.fileInput.click();
        });
        els.fileInput.addEventListener("change", function (event) {
          setLocalFile(event.target.files && event.target.files[0]);
        });
        els.libraryButton.addEventListener("click", function () {
          setLibraryFile().catch(function (error) {
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
          setLocalFile(event.dataTransfer.files && event.dataTransfer.files[0]);
        });
        els.publishButton.addEventListener("click", function () {
          els.publishButton.disabled = true;
          els.result.style.display = "none";
          publish()
            .catch(function (error) {
              els.result.style.display = "block";
              els.result.textContent = error && error.message ? error.message : String(error);
              setStatus(error && error.message ? error.message : String(error), "bad");
            })
            .finally(function () {
              els.publishButton.disabled = false;
              saveState();
              notifyHeight();
            });
        });

        applyInitial();
      })();
    </script>
  </body>
</html>`;
