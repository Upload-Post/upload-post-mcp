# @upload-post/mcp

Official **Model Context Protocol (MCP)** server for [Upload-Post](https://www.upload-post.com).

Lets any MCP-compatible AI agent (Claude Desktop, Claude Code, Cursor, …) publish, schedule, analyze and manage social media across **TikTok, Instagram, YouTube, LinkedIn, Facebook, Pinterest, Threads, Reddit, Bluesky, X, Google Business and more** with a single API key.

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

Get your API key at <https://app.upload-post.com> → *API Keys*. Restart the client — you should see 51 `upload-post` tools.

### B) Hosted HTTP (multi-tenant) — share one server with many users

Run the server somewhere (Coolify / Fly / Railway / your own box) and let each user connect with **their own** Upload-Post API key. The server stores nothing per user.

```jsonc
{
  "mcpServers": {
    "upload-post": {
      "url": "https://mcp.tu-dominio.com/mcp",
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

The server exposes **40 tools** — every one maps 1:1 to an endpoint documented at <https://docs.upload-post.com/llm.txt>.

| Group         | Tools |
|---------------|-------|
| Upload        | `upload_video`, `upload_photos`, `upload_text`, `upload_document` |
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

CLI flags:

- `--http` — start the streamable HTTP transport instead of stdio
- `--port <n>` — port for HTTP mode

HTTP endpoints:

- `POST /mcp` — JSON-RPC over MCP streamable HTTP. **Requires `Authorization: ApiKey <key>` (or `Bearer <key>`)** on every request. The key is the user's own Upload-Post API key; the server uses it only for that session and stores nothing.
- `GET /healthz` — liveness probe, always open. Returns `{"ok":true}`.

Auth model in `--http` mode is the same pattern Resend, Tavily, Brave Search and other API-key-native services use for their hosted MCPs: the upstream key *is* the auth.

---

## Deploy on Coolify (Docker)

The repo ships with a multi-stage `Dockerfile` and a `.dockerignore`. In Coolify:

1. **New Resource → Application → Public/Private Git Repository**, point it at this repo.
2. **Build Pack: Dockerfile**. Coolify auto-detects `Dockerfile` at the root.
3. **Port: 8080** (matches `EXPOSE 8080`).
4. **Environment variables**: none are required. Optionally set `UPLOAD_POST_BASE_URL` if you point at staging.
5. **Health check path**: `/healthz` (HTTP, port 8080).
6. **Domain**: attach a domain, e.g. `mcp.tu-dominio.com`. Coolify provisions TLS via Let's Encrypt automatically.

Deploy. The server is now ready for any number of users. Each user adds the endpoint to their MCP client config with **their own** Upload-Post API key:

```jsonc
{
  "mcpServers": {
    "upload-post": {
      "url": "https://mcp.tu-dominio.com/mcp",
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
- Always create the profile first (`create_user`) and connect socials in the Upload-Post dashboard before publishing.
- For scheduled posts, pass ISO 8601 dates with timezone, e.g. `"2026-12-25T10:00:00Z"` + `"timezone": "Europe/Madrid"`.

---

## License

MIT © Upload-Post
