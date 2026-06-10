# @upload-post/mcp

Official **Model Context Protocol (MCP)** server for [Upload-Post](https://www.upload-post.com).

Lets any MCP-compatible AI agent (Claude Desktop, Claude Code, Cursor, …) publish, schedule, analyze and manage social media across **TikTok, Instagram, YouTube, LinkedIn, Facebook, Pinterest, Threads, Reddit, Bluesky, X, Google Business, Discord, Telegram and more** with a single API key.

> Built on top of the official [`upload-post`](https://www.npmjs.com/package/upload-post) SDK and the public Upload-Post REST API.

---

## Two ways to use it

### A) Local stdio (single-user) — simplest

The server runs on your machine, spawned by the MCP client. Add to `~/.claude/mcp.json` (or Cursor settings, etc.):

```jsonc
{
  "mcpServers": {
    "upload-post": {
      "command": "npx",
      "args": ["-y", "@upload-post/mcp"],
      "env": { "UPLOAD_POST_API_KEY": "YOUR_API_KEY" }
    }
  }
}
```

Get your API key at <https://app.upload-post.com> → *API Keys*. Restart the client — you should see 45 `upload-post` tools.

### B) Hosted HTTP (multi-tenant) — share one server with many users

Run the server on any Docker-capable host (Fly, Railway, Cloud Run, your own box…) and let each user connect with **their own** Upload-Post API key. The server stores nothing per user.

```jsonc
{
  "mcpServers": {
    "upload-post": {
      "url": "https://mcp.your-domain.com/mcp",
      "headers": {
        "Authorization": "ApiKey YOUR_OWN_UPLOAD_POST_API_KEY"
      }
    }
  }
}
```

`Authorization: Bearer <key>` is also accepted, for clients that only allow Bearer.

---

## What can the agent do?

The server exposes Upload-Post API tools plus one ChatGPT App UI launcher.

| Group         | Tools |
|---------------|-------|
| Upload        | `upload_video`, `upload_photos`, `upload_text`, `upload_document`, `open_upload_studio` |
| Media staging | `create_media_upload`, `complete_media_upload`, `get_media_upload`, `delete_media_upload` |
| Status        | `get_status`, `get_job_status`, `get_history`, `get_media` |
| Schedule      | `list_scheduled`, `cancel_scheduled`, `edit_scheduled` |
| Analytics     | `get_analytics`, `get_total_impressions`, `get_post_analytics`, `get_platform_metrics` |
| Users         | `get_account_info`, `list_users`, `create_user`, `delete_user`, `generate_jwt`, `validate_jwt` |
| Pages/boards  | `get_facebook_pages`, `get_linkedin_pages`, `get_pinterest_boards`, `get_google_business_locations`, `select_google_business_location`, `get_reddit_detailed_posts` |
| Comments      | `get_post_comments`, `reply_to_comment`, `public_reply_to_comment` |
| DMs           | `send_dm`, `list_dm_conversations`, `manage_autodms` |
| FFmpeg        | `submit_ffmpeg_job`, `get_ffmpeg_job`, `download_ffmpeg_result`, `get_ffmpeg_consumption` |
| Queue         | `get_queue_settings`, `update_queue_settings`, `preview_queue` |

Async uploads return a `request_id`. The agent should poll `get_status` until `success: true`.

### ChatGPT video upload UI

`open_upload_studio` renders a ChatGPT Apps component for file-based video publishing. The widget creates a short-lived Upload-Post/R2 staging upload, PUTs the local video directly to R2, completes the upload, then calls `upload_video` with the returned temporary media URL.

The staging object is deleted after 24 hours whether it is used or not. Scheduled/queued posts remain safe because `upload_video` copies the temporary URL into the existing durable scheduler storage before execution.

Claude and other MCP clients can use the same flow without the ChatGPT UI: call `create_media_upload`, PUT the file to `upload_url`, call `complete_media_upload`, then pass `media_url` to `upload_video`.

Set `UPLOAD_POST_R2_CONNECT_DOMAINS` on the MCP host to the comma-separated origins used by the backend's R2 signed URLs when they differ from the defaults (for example `https://<account>.r2.cloudflarestorage.com,https://<bucket>.<account>.r2.cloudflarestorage.com`) so the ChatGPT component CSP allows the browser PUT.

The R2 bucket CORS policy must allow browser uploads. A restrictive policy can include your actual widget origin; for fastest validation, use:

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

---

## Local / development

```bash
git clone https://github.com/Upload-Post/upload-post-mcp.git
cd upload-post-mcp
npm install
npm run build

# stdio (default — used by Claude Desktop, Cursor)
UPLOAD_POST_API_KEY=... node dist/index.js

# HTTP streamable (for hosted deployments)
UPLOAD_POST_API_KEY=... node dist/index.js --http --port 8080
```

Inspect the live tool surface with the official inspector:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

---

## Configuration

| Env var                   | Mode    | Default                            | Description                              |
|---------------------------|---------|------------------------------------|------------------------------------------|
| `UPLOAD_POST_API_KEY`     | stdio   | — (required)                       | Single user's Upload-Post API key. **Ignored in `--http` mode** — keys come per request. |
| `UPLOAD_POST_BASE_URL`    | both    | `https://api.upload-post.com/api`  | Override for self-hosted / staging.      |
| `UPLOAD_POST_MCP_PORT`    | http    | `8080`                             | Port for `--http` mode.                  |
| `OPENAI_APPS_CHALLENGE_TOKEN` | http | Current Upload-Post challenge token | Optional override for ChatGPT Apps domain verification at `/.well-known/openai-apps-challenge`. |

CLI flags:

- `--http` — start the streamable HTTP transport instead of stdio
- `--port <n>` — port for HTTP mode

HTTP endpoints:

- `POST /mcp` — JSON-RPC over MCP streamable HTTP. **Requires `Authorization: ApiKey <key>` (or `Bearer <key>`)** on every request. The key is the user's own Upload-Post API key; the server uses it only for that session and stores nothing.
- `GET /healthz` — liveness probe, always open. Returns `{"ok":true}`.

Auth model in `--http` mode is the same pattern Resend, Tavily, Brave Search and other API-key-native services use for their hosted MCPs: the upstream key *is* the auth.

---

## Deploy with Docker

The repo ships with a multi-stage `Dockerfile` and a `.dockerignore`. On any Docker-capable PaaS (Fly.io, Railway, Render, Cloud Run, fly machines, your own box…):

1. Point the PaaS at this repo and select **Dockerfile** as the build pack.
2. **Port: 8080** (matches `EXPOSE 8080`).
3. **Environment variables**: none are required. Optionally set `UPLOAD_POST_BASE_URL` if you point at staging.
4. **Health check path**: `/healthz` (HTTP, port 8080).
5. **Domain**: attach a domain, e.g. `mcp.your-domain.com`, and provision TLS (most PaaS do this automatically via Let's Encrypt).

Deploy. The server is now ready for any number of users. Each user adds the endpoint to their MCP client config with **their own** Upload-Post API key:

```jsonc
{
  "mcpServers": {
    "upload-post": {
      "url": "https://mcp.your-domain.com/mcp",
      "headers": {
        "Authorization": "ApiKey USER_OWN_UPLOAD_POST_API_KEY"
      }
    }
  }
}
```

> Without an `Authorization` header the server returns `401`. The header is the only credential — invalid Upload-Post keys will surface as upstream errors on the first tool call.

Local test of the production image:

```bash
docker build -t upload-post-mcp .
docker run --rm -p 8080:8080 upload-post-mcp
curl http://localhost:8080/healthz   # → {"ok":true}
curl -i -X POST http://localhost:8080/mcp \
  -H "content-type: application/json" \
  -d '{}'                               # → 401 (no Authorization)
```

---

## Tips for prompting the agent

- Prefer **public URLs** over local paths when uploading — local paths only work if the MCP server runs on the user's machine.
- In ChatGPT Apps, prefer `open_upload_studio` for user-selected video files. It avoids local-path handoff issues by uploading to short-lived Upload-Post/R2 staging, then passing a temporary media URL to `upload_video`.
- To send video **bytes directly** (a client that holds the file rather than a URL), pass `videoBase64` to `upload_video` instead of `videoPathOrUrl`. The server writes it to a temp file, uploads, then deletes it. Inline bytes are capped at `UPLOAD_POST_MAX_INLINE_MB` (default 100 MB) — for larger videos use a public URL.
- Always create the profile first (`create_user`) and connect socials in the Upload-Post dashboard before publishing.
- For scheduled posts, pass ISO 8601 dates with timezone, e.g. `"2026-12-25T10:00:00Z"` + `"timezone": "Europe/Madrid"`.

---

## Privacy & data handling

This server is a **stateless proxy** to the Upload-Post API. Per request, the only data it processes is the user's API key (or OAuth access token resolved to one) and the arguments of the tool call being executed. No user data is persisted by the MCP container itself.

- **What we receive per request**: the `Authorization` header, the MCP tool name + arguments, and any media URLs/paths the agent passes.
- **What we forward**: the tool arguments to the Upload-Post API on behalf of the authenticated user.
- **What we store**: nothing per-user. OAuth tokens are stored upstream in the Upload-Post backend, hashed (SHA-256), so a breach of token storage cannot impersonate users.
- **What we log**: HTTP method, path, status code, and an opaque request ID. No tool arguments, no API keys, no tokens.

Full Upload-Post privacy policy (data collection, retention, third-party sharing, contact, GDPR/CCPA): **https://upload-post.com/privacy**

To revoke a connector's access at any time, open **Connected Apps** in [app.upload-post.com](https://app.upload-post.com).

---

## Security

- All traffic is TLS-terminated at the edge (HTTPS only).
- `/mcp` requires a valid `Authorization` header on every request; OAuth access tokens are short-lived (1 h access + 90 d refresh with rotation per RFC 6749 §10.4).
- The server validates the `Origin` header against an allow-list (`claude.ai`, `claude.com`, `chatgpt.com`, `chat.openai.com`, `app.upload-post.com`, `localhost`) to mitigate DNS-rebinding attacks from browser-based clients. Extend with `OAUTH_EXTRA_ALLOWED_ORIGINS` (comma-separated) when self-hosting behind a custom dashboard.
- If ChatGPT shows `redirect_uri not on allow-list` during OAuth, add the exact `redirect_uri` from the failing authorize request to the Upload-Post backend OAuth redirect allow-list. For ChatGPT clients this is typically on `https://chatgpt.com/.../oauth/callback` or `https://chat.openai.com/.../oauth/callback`.
- All tools declare MCP `readOnlyHint`/`destructiveHint` annotations so clients can surface confirmation prompts for destructive operations.

Report a security issue: **info@upload-post.com** (encrypted PGP available on request).

---

## License

MIT © Upload-Post
