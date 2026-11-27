# @upload-post/mcp

Official **Model Context Protocol (MCP)** server for [Upload-Post](https://www.upload-post.com).

[![smithery badge](https://smithery.ai/badge/upload-post/social-media-mcp)](https://smithery.ai/servers/upload-post/social-media-mcp) [![Glama](https://glama.ai/mcp/servers/Upload-Post/upload-post-mcp/badges/score.svg)](https://glama.ai/mcp/servers/Upload-Post/upload-post-mcp) [![npm](https://img.shields.io/npm/v/@upload-post/mcp)](https://www.npmjs.com/package/@upload-post/mcp)

Lets any MCP-compatible AI agent (ChatGPT, Claude Desktop, Claude Code, Cursor, …) publish, schedule, analyze and manage social media across **TikTok, Instagram, YouTube, LinkedIn, Facebook, Pinterest, Threads, Reddit, Bluesky, X, Google Business, Discord, Telegram and more** with a single API key, and answer DMs on Instagram, Bluesky, Telegram and **WhatsApp**.

> Built on top of the official [`upload-post`](https://www.npmjs.com/package/upload-post) SDK and the public Upload-Post REST API.

---

## Use it in ChatGPT (no setup)

Upload-Post is a plugin reviewed by OpenAI, listed in ChatGPT's **Plugins** (formerly Apps). [Open Upload-Post in ChatGPT](https://chatgpt.com/plugins/plugin_asdk_app_6a1fed02ff5c8191b4060c5807221f26) or search for *Upload-Post* in **Plugins**, click **Install**, then **Connect**, and sign in with OAuth. There is no MCP URL to paste, and you get the [Upload Studio](#chatgpt-video-upload-ui) widget for publishing video files, photos and carousels straight from your computer. OpenAI dots use the same plugin: select it in your dot's **Customize → Plugins** and review its permissions.

Prefer to wire it up by hand? In ChatGPT on the web, open **Plugins**, click **+**, choose **Add custom MCP server**, point it at `https://mcp.upload-post.com/mcp` and set authentication to **OAuth**. Custom MCP servers get write actions on Business, Enterprise and Edu workspaces.

## Use it in Claude (no setup)

Upload-Post is an official connector in Claude's connector directory. [Add Upload-Post to Claude](https://claude.ai/directory/upload-post), or in claude.ai, Claude Desktop or Claude Cowork open **Customize → Connectors**, browse the directory and search for *Upload-Post*, then click **Connect** and sign in with OAuth. There is no MCP URL to paste. On Team and Enterprise an owner may need to allow it first in **Organization settings**.

Prefer to wire it up by hand? Open **Customize → Connectors**, click **+ Add**, then **Add custom connector**, paste `https://mcp.upload-post.com/mcp`, click **Continue** and sign in with OAuth. Custom connectors work on every Claude plan (the Free plan allows one). In Claude Code: `claude mcp add --transport http upload-post https://mcp.upload-post.com/mcp`, or install the official Upload-Post plugin from the Claude directory.

## Use it in Perplexity Computer

Open **Plugins** in the sidebar (or **Customize → Connectors**), then **Add custom → Connector → Add MCP connector → Remote**. Use `https://mcp.upload-post.com/mcp` with the Streamable HTTP transport and OAuth (or your Upload-Post API key), click **Add**, then click the Upload-Post card to sign in.

## Use it in Gemini CLI

Install the extension and sign in with OAuth the first time Gemini calls a tool:

```bash
gemini extensions install https://github.com/Upload-Post/upload-post-mcp
```

---

## Two ways to run it yourself

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

Get your API key at <https://app.upload-post.com> → *API Keys*. Restart the client — you should see 58 `upload-post` tools.

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

### Sessions never expire

A hosted session does not live only in the memory of the process that opened it. The `Mcp-Session-Id` the client holds is a token signed by the server that carries the client's `initialize` (who it said it was, the protocol version, its capabilities). Any process with the same `UPLOAD_POST_MCP_SESSION_SECRET` rebuilds the session the first time it sees the id, so:

- a restart, a deploy or a second replica is invisible to the client: its next call is served, without "Session not found" and without re-initializing;
- there is no limit on how many sessions exist. `UPLOAD_POST_MCP_MAX_SESSIONS` and the idle TTL only bound how many are kept in memory at once;
- nothing is stored anywhere: no database, no file.

The id is not a credential. It holds no key, every request still has to present its own `Authorization`, and an id only opens again for the key it was issued to. Ids issued by versions before this (plain UUIDs) are not rebuilt: they say nothing about the client, so they get the 404 they always got, the client re-initializes once and holds a signed id from then on. A session the client ends with `DELETE` answers 404 afterwards. Without `UPLOAD_POST_MCP_SESSION_SECRET` the server signs with a key made up at start: after a restart those ids are unknown, the client gets a 404 and re-initializes (as before this change). `GET /health` shows `durableSessions`.

## What can the agent do?

The server exposes Upload-Post API tools plus one ChatGPT App UI launcher.

| Group         | Tools |
|---------------|-------|
| Upload        | `upload_video`, `upload_photos`, `upload_text`, `upload_document`, `open_upload_studio` |
| Media staging | `create_media_upload`, `complete_media_upload`, `get_media_upload`, `delete_media_upload` |
| Status        | `get_status`, `get_job_status`, `get_history`, `get_media` |
| Schedule      | `list_scheduled`, `cancel_scheduled`, `edit_scheduled`, `get_scheduled_post` (one post's options, preview and thumbnail; not exposed in ChatGPT yet) |
| Analytics     | `get_analytics`, `get_total_impressions`, `get_post_analytics`, `get_cached_post_analytics`, `get_platform_metrics` |
| Audience      | `get_audience`, `get_suggestions` |
| Users         | `get_account_info`, `list_users`, `get_connect_link`, `open_social_accounts`, `create_user`, `delete_user`, `generate_jwt`, `validate_jwt`, `manage_profile` (rename, disconnect one network, default Facebook / LinkedIn Page and Google Business location; not exposed in ChatGPT yet) |
| Pages/boards  | `get_facebook_pages`, `get_linkedin_pages`, `resolve_linkedin_organization`, `get_pinterest_boards`, `get_google_business_locations`, `get_google_business_reviews`, `reply_to_google_business_review`, `get_reddit_detailed_posts` |
| Pinterest and limits | `manage_pinterest_boards` (board sections, new boards and sections), `save_post` (save a Pin to a board, bookmark a Bluesky or X post), `get_publishing_limits` (Instagram and Threads posts left in 24 h), `pinterest_api_read` and `manage_pinterest_api` (Pinterest API v5: boards and sections, Pins, account and Pin analytics, trends, followers, websites) (not exposed in ChatGPT yet) |
| Facebook, Instagram, Threads | `facebook_page_read` (Page reviews, tagged and visitor posts, Insights on demand, video captions), `manage_facebook_video_captions`, `instagram_account_read` (stories live now, posts where the account is tagged), `get_threads_ghost_posts` (not exposed in ChatGPT yet) |
| X | `x_read` (mentions of the account, recent search and counts, likers, reposters, quotes, reposts of the account, bookmarks, followers, lists, trends, post and media analytics; paid plans; bookmarks, lists, followers, likers, reposts of the account and hidden replies need X connected or reconnected on or after 2026-11-25), `manage_x_lists`; `post_action` bookmark / unbookmark / unrepost, `save_post` and `comment_action` hide / unhide on X (not exposed in ChatGPT yet) |
| Posts         | `retry_post`, `unpublish_post`, `edit_post`, `repost_post`, `post_action` (not exposed in ChatGPT yet) |
| Best times    | `get_best_times`: the hours each connected account gets the most engagement; `update_queue_settings` with `slots: "auto"` fills the queue with them (not exposed in ChatGPT yet) |
| Telegram      | `manage_telegram_chat` (chat info, members, invite links, join requests, forum topics), `manage_telegram_bot` (bot profile and commands, updates, query answers, sticker sets), `manage_telegram_payments` (Stars, invoices, refunds, gifts, automatic payment answers), `manage_telegram_business` (Business account profile, stories, gifts, Stars) (not exposed in ChatGPT yet) |
| Bluesky       | `bluesky_read` (profiles, search, threads, feeds, notifications, account settings, drafts), `manage_bluesky_account` (profile, status, settings, preferences, drafts) (not exposed in ChatGPT yet) |
| YouTube       | `youtube_read` (videos, quota, playlists, captions, comments, search and catalogs, channel, sections, subscriptions, activities, broadcasts, streams, live chat), `manage_youtube_playlists`, `manage_youtube_comments`, `manage_youtube_channel`, `manage_youtube_videos` (rating, thumbnail, captions, abuse reports), `manage_youtube_live` (broadcasts, streams, live chat, chat moderators and bans) (not exposed in ChatGPT yet) |
| Google Business | `google_business_read` (posts, reviews, performance and search keywords, gallery, location info, catalogs, attributes, menus, services), `update_google_business_location` (edit the location info), `manage_google_business` (attributes, Google's suggested changes, lodging, menus, services, gallery, booking links, review reply deletion, listing reports) (not exposed in ChatGPT yet) |
| Comments      | `get_post_comments`, `create_comment`, `delete_comment`, `reply_to_comment`, `public_reply_to_comment`, `hide_comment`, `like_comment`, `pin_comment`, `edit_comment`, `hold_comment`, `approve_comment`, `ignore_comment`, `set_post_comments`, `comment_action` |
| TikTok        | `tiktok_music_trending`, `tiktok_music_search`, `tiktok_location_search`, `tiktok_publishing_settings` |
| DMs           | `send_dm` (Instagram, Bluesky; Telegram and WhatsApp outside ChatGPT), `list_dm_conversations`, `start_autodm` (one post: Instagram DM or public auto-reply on TikTok, YouTube, Facebook, Threads, Bluesky), `list_autodms`, `get_autodm_logs`, `pause_autodm`, `resume_autodm`, `stop_autodm`, `delete_autodm`, `manage_autodms` |
| WhatsApp      | `manage_whatsapp_templates` (list, create, edit and delete the message templates Meta approves, the only way to write after the 24 h window, and Meta's template library), `manage_whatsapp_business` (business profile, chat QR codes and links), `manage_whatsapp_number` (blocked users, commands and ice breakers, quality and messaging limit, display name, PIN, analytics), `manage_whatsapp_flows` (WhatsApp Flows) (not exposed in ChatGPT yet) |
| Phone numbers | `phone_numbers_read` (availability, countries and prices, numbers to buy, identity fields, your numbers, SMS, calls and voicemails, verification codes, usage, port-out details), `purchase_phone_number`, `send_sms`, `manage_phone_number` (call forwarding, voicemail, recording, transcription, WhatsApp verification), `release_phone_number`, `fix_phone_number_kyc` (fix a declined identity review, answer the reviewer), `manage_phone_kyc_links` (shareable KYC links for end users) (not generally available yet; not exposed in ChatGPT) |
| AutoDM rules  | `create_autodm_rule`, `list_autodm_rules`, `pause_autodm_rule`, `resume_autodm_rule`, `delete_autodm_rule`: account-wide Instagram rules (every post, story replies, story mentions, DM keywords) that never expire (not exposed in ChatGPT yet) |
| Webhooks      | `list_webhook_deliveries`, `get_webhook_delivery`, `redeliver_webhook`: 7-day log of the events sent to the user's webhook URLs, with attempts and manual redelivery; `list_webhook_subscriptions`, `create_webhook_subscription`, `delete_webhook_subscription`, `test_webhook_subscription`: extra destinations (n8n triggers, REST hooks) for chosen events; `manage_webhook_settings`: the account and per-profile webhook (the signing secret is never returned) (not exposed in ChatGPT yet) |
| Team approvals | `list_pending_approvals`, `approve_post`, `reject_post`, `edit_pending_post`, `withdraw_pending_post`: posts by Editors and Contributors waiting for the owner or an Admin; `get_team_info`: roles, members, shared accounts and the team activity log (not exposed in ChatGPT yet) |
| ChatGPT Ads   | `chatgpt_ads_read` (accounts, campaigns, ad groups, ads, insights, previews), `manage_chatgpt_ads` (launch, create, edit, activate, pause, archive; spend runs on the user's own OpenAI billing) (not exposed in ChatGPT yet) |
| FFmpeg        | `submit_ffmpeg_job`, `get_ffmpeg_job`, `download_ffmpeg_result`, `get_ffmpeg_consumption` |
| Queue         | `get_queue_settings`, `update_queue_settings`, `preview_queue`, `mark_queue_slot` (skip or free one slot; not exposed in ChatGPT yet) |
| Feedback      | `send_feedback`: the agent tells the Upload-Post team about an unclear error, a wrong tool description or a missing capability (not exposed in ChatGPT) |

Async uploads return a `request_id`. The agent should poll `get_status` (about every 10 seconds, for up to about 15 minutes) until `status` is `completed`, `failed` or `retryable`; `completed` means every platform finished, and each entry of `results` says whether it published. `pending_approval` waits for a team approval.

Every upload carries an `Idempotency-Key` derived from the tool, its arguments and a 10-minute time window, so a call repeated after a timeout does not publish twice: an identical call repeated in the following minutes returns the earlier result, marked `idempotent_replay: true`, while the same call made deliberately later publishes again. A failed upload is retried with `retry_post`, which only resends the platforms that failed.

A team member's post can go to the approval queue instead (the API answers `202` with `pending_approval: true` and an `approval_id`): nothing is published until the owner or an Admin approves it. The upload tools and `get_status` return that as a success with a `next_step` explaining it, not as an error. To act as a team member on the owner's account from a local server, set `UPLOAD_POST_ACT_AS_USER` to the owner's email.

Some features are not generally available yet and answer `503` until they are switched on: webhook subscriptions (`webhook_subscriptions_disabled`), the approval queue (`post_approvals_disabled`), the new YouTube actions (every `youtube_read` / `manage_youtube_*` action except videos, quota and the thumbnail: `youtube_feature_disabled`). Each tool's description says which of its actions are affected. Connecting a ChatGPT Ads account (it takes an OpenAI Ads API key), the per-network credential connections and rotating the webhook secret stay in the dashboard on purpose: an agent never handles those secrets.

### Per-platform: TikTok / YouTube / Instagram / LinkedIn / Facebook

One server covers every network; this is what each of the big five uses. Publishing always goes through the same upload tools with a `platform` list, so a single call can post one video to TikTok, Reels and Shorts at once.

| Platform | Publish | Network-specific helpers | Engage and measure |
|----------|---------|--------------------------|--------------------|
| TikTok | `upload_video` (videos, drafts), `upload_photos` (photo carousels) | `tiktok_publishing_settings`, `tiktok_music_trending`, `tiktok_music_search`, `tiktok_location_search` | `get_post_comments`, `create_comment`, `comment_action`, `get_post_analytics`, `get_audience`, `start_autodm` (public auto-reply) |
| YouTube | `upload_video` (videos and Shorts, with title, description and tags) | | `get_post_comments`, `comment_action` (hide / hold), `get_post_analytics`, `get_analytics`, `start_autodm` (public auto-reply) |
| Instagram | `upload_video` (Reels, Stories), `upload_photos` (posts, carousels, Stories) | | `get_post_comments`, `reply_to_comment`, `comment_action`, `send_dm`, `list_dm_conversations`, `start_autodm` (comment-to-DM on one post), `create_autodm_rule` (every post, stories, DM keywords), `get_post_analytics` |
| LinkedIn | `upload_text`, `upload_photos`, `upload_video`, `upload_document` (PDF, PPT, DOCX documents) | `get_linkedin_pages` (post as a company page), `resolve_linkedin_organization` (exact name and urn to @mention a company Page) | `get_post_comments`, `get_post_analytics`, `get_analytics` |
| Facebook | `upload_video`, `upload_photos`, `upload_text` | `get_facebook_pages` (pick the page) | `get_post_comments`, `comment_action` (hide / like / edit), `start_autodm` (public auto-reply), `get_post_analytics` |

Search terms people use for these: TikTok MCP server, YouTube MCP server / YouTube uploader MCP, Instagram MCP server, LinkedIn MCP server, Facebook MCP server.

### One tool per question, not per network

The Upload-Post API has no endpoint per social network: it has an endpoint per **question**, and a `platform` parameter saying who is being asked. `get_post_comments`, `get_post_analytics`, `get_audience`, `get_suggestions` and `comment_action` all work that way, so an agent learns one shape and reuses it for every network. Only the four `tiktok_*` tools are network-specific, because what they return (the Commercial Music Library, TikTok places, TikTok's per-account publishing settings) exists only on TikTok.

- `get_audience` — who follows the profile, where they are, when they are online, what they tap. Also `benchmark_categories`, and the niche averages to compare against when `benchmarkCategory` is set. The server clamps the window to at most 60 days ending before today, so a wider range is trimmed rather than rejected, and `range` in the response says which window was used.
- `get_suggestions` — hashtags (with `view_count`) or related keyword searches, told apart by `type`, not by a different tool.
- `get_post_comments` — top-level comments on a post, or, with `commentId`, the replies under one of them (TikTok, Threads, YouTube, Instagram, Facebook and LinkedIn Page posts; LinkedIn prefers the full `comment_urn`). Reads are cached for up to 60 seconds (up to 2 minutes on X); a comment created or deleted through Upload-Post by the same account shows up on the next read.
- `create_comment` on X — links are removed unless the account is allowed links on X (reported in `warnings`); a message that was only links fails with 400 `x_links_not_allowed`. Replies, post edits and reposts on X share a daily limit per X account (20 on the free plan, 200 on paid plans, reset at 00:00 UTC); past it the API answers 429 `x_daily_write_limit` with `retry_after` and a `Retry-After` header.
- `hide_comment`, `like_comment`, `pin_comment`, `edit_comment`, `hold_comment`, `approve_comment`, `ignore_comment`, `set_post_comments` — one tool per moderation operation. `comment_action` does the same through a single `action` argument and stays available everywhere except ChatGPT, which only gets the one-operation tools (the same goes for `manage_autodms`).
- `comment_action` — moderate a comment on TikTok (hide / like / pin), Facebook (hide / like / edit), Instagram (hide, or enable / disable comments on a post), YouTube (hide / hold), Threads (hide / approve / ignore), X (like) and Bluesky (hide / like). `like_comment` works on TikTok, Facebook, X and Bluesky outside ChatGPT (TikTok and Facebook there); an X account connected before likes were available reconnects X once to grant the like permission. Each value carries its own inverse, so nothing is permanent.
- `get_post_analytics` — per-post metrics, by `requestId` (posts published through Upload-Post, TikTok drafts once published publicly) or by `platformPostId` + `platform` + `user` (any post of the connected account). `post_metrics` is whatever the platform reports, so its shape varies: on TikTok it adds `retention`, `impression_sources`, `audience_types`, `new_followers`, `reach` and the watch times (`average_time_watched`, `total_time_watched`, `full_video_watched_rate`).

Errors are shared too: `platform_not_supported` (400, with the list of the networks that can answer), `invalid_parameter` (400), `tiktok_reconnect_required` (400), `reauth_required` (409) and 502 when the upstream network fails.

### TikTok capabilities

`get_post_comments`, `create_comment`, `delete_comment` and `comment_action` accept `platform: "tiktok"`, and `firstComment` works on TikTok like on every other network.

What a TikTok account can do depends on how it is connected. `list_users` returns a `capabilities` array on each TikTok account — `music`, `location`, `cover_image`, `cover_timestamp`, `draft`, `video_privacy`, `photo_privacy`, `profile_analytics`, `comments`, `trend_search` — and each tool's description names the one it needs. They are granted when the user connects TikTok, so an account connected before a capability existed has to reconnect before the matching tools answer; that is what a `tiktok_reconnect_required` error means.

`list_dm_conversations` (Instagram, WhatsApp, Bluesky, and outside ChatGPT Telegram: the private chats of the profile's own bot, which need its updates on) is cursor-paginated the same way, through `pagination.next_cursor` / `has_more`. It also takes `since` (Unix timestamp or ISO 8601, activity after that moment), `participant_id` (one thread) and `messages_limit` (latest messages per conversation, 1-25, default 10). Pages hold at most 50 conversations (25 on Bluesky). Message media comes back in `attachments` with `type` and `url`. Bluesky also takes `conversation_id` + `messages_cursor` (one conversation's older messages), `status` (`request` / `accepted`) and `read_state: "unread"`; `send_dm` on Bluesky takes a handle or DID, a shared post, `reply_to` and sender actions (read, react, accept, mute, leave). Bluesky DMs need an app password created with access to direct messages.

`get_media` and `get_cached_post_analytics` are cursor-paginated: feed the response's `next_cursor` back as `cursor` until `has_more` is false. LinkedIn, Discord and Telegram do not support media cursors and accept `limit` only. Prefer `get_cached_post_analytics` over `get_post_analytics` when scanning many posts — it replays previously fetched results and so avoids the live analytics rate limit of 100 requests / 5 minutes. Only contains posts previously fetched through a live per-post endpoint; there is no background refresh, so captured_at is the last time that post was read live.

FFmpeg jobs accept one public URL through `input_url` or multiple URLs through `files`. They run on Upload-Post's encoding servers, each in its own working directory. `full_command` is a single ffmpeg invocation with `{input}` (or `{input0}`, `{input1}`…) and `{output}` placeholders, run without a shell: it must start with `ffmpeg`, every `-i` must be an `{input}`/`{inputN}` placeholder or a `-f lavfi` source, and `{output}` is the only output. Protocols or URLs inside the command (`file:`, `concat:`, `subfile,`…), the `movie=`/`amovie=`/`sendcmd` filters, absolute paths other than fonts under `/usr/share/fonts`, `..`, `-safe 0` and shell metacharacters are rejected with a 400. Endless commands (`-stream_loop -1`, `-loop 1`, a lavfi source without a duration) need `-t`, `-shortest` or `-frames`, and `-stream_loop` goes from -1 to 100. Usage is charged at the longer of the input and output durations. Poll `get_ffmpeg_job` until completion, then call `download_ffmpeg_result`; it returns the result URL without streaming the processed binary through MCP. Nothing is posted until you pass that URL to an upload tool.

### WhatsApp

WhatsApp is open to every account as a **messaging channel**: posts are never published to it. The user connects their own WhatsApp Business number on the connection page (`get_connect_link` with `platforms: ["whatsapp"]`, or the WhatsApp card of `open_social_accounts`): they sign in with Meta and pick or register the number. Meta bills conversations to their own WhatsApp Business account.

- `send_dm` with `platform: "whatsapp"` and `recipient_id` = the phone number in international format: text (`message`, up to 4096 characters), files (`attachments`: image, video, audio, document or sticker by public `url` or `media_id`, with `caption` / `filename`), reply buttons (`buttons`, up to 3), a list (`list`) or a link button (`cta_url`) with optional `header` / `footer`, `location`, `contacts`, `reply_to`, a `reaction` (with `message_id`), and `sender_action` `mark_read` / `typing_on`.
- Free-form messages only reach someone within 24 h of their last message to the number. Outside that window send an approved `template` (`{ name, language, components }`); anything else fails with `meta_error_code` 131047. `manage_whatsapp_templates` lists, creates (Meta reviews them) and deletes templates.
- `list_dm_conversations` with `platform: "whatsapp"` returns the stored inbox (`participant_id` = phone number); files people send carry a `media_id`.
- `manage_whatsapp_business` reads and edits the business profile (about, description, address, email, websites, category) and manages the QR codes / links that open a chat with a prefilled message.
- Outside ChatGPT, `send_dm` on WhatsApp also sends Flows (`flow`), media carousels (`carousel`), location requests (`location_request`) and call buttons (`call_button`), and `recipient_id` can be a WhatsApp user id for people who reached the number without a phone; `list_dm_conversations` and the `dm_received` webhook carry `user_id`, `username` and `phone` for each person. `manage_whatsapp_number` blocks users and manages the number (commands, ice breakers, display name, PIN, analytics) and `manage_whatsapp_flows` builds the Flows.

### Phone numbers

Upload-Post rents real phone numbers to paid accounts (an active subscription with at least one paid invoice; the Free plan and trials get `402 phone_numbers_paid_plan_required` with an `upgrade_url`) to receive SMS and calls, verify WhatsApp Business on them and send SMS. Not generally available yet: the API answers `403 phone_numbers_not_available` until phone numbers are available for the account, and `phone_numbers_read` with `action: "config"` answers `enabled: false`. API reference: https://docs.upload-post.com/api/phone-numbers. Terms: https://docs.upload-post.com/resources/phone-number-terms.

- **Buying** (`purchase_phone_number`): the monthly price varies by country and number type: 1.5 times our carrier's monthly cost, rounded up to the next whole unit, at least 3 and at most 30 (numbers that would cost more are not offered). For example a carrier cost of 2.40 gives 3.60, so 4 per month; 7.30 gives 10.95, so 11. `phone_numbers_read` `countries` and `search_available` show the real price, in the account's billing currency (USD, EUR or GBP, the same amount in each). No setup fee, charged on the account's subscription (prorated now, then on each renewal); usage (outbound SMS, forwarded minutes, recording, transcription) goes on the next invoice and `phone_numbers_read` `usage` shows it line by line, in the same currency. Every purchase sends the end user's identity (`end_user`) and accepts the terms (`accept_terms: true` plus the `terms_version` from `config`). When the end user is an individual (a consumer), the purchase also needs `immediate_start_consent: true`: their express request to start the service now, within the 14-day withdrawal period (they pay for the days already provided if they withdraw, and lose the right once the service is fully provided). Without it the tool sends nothing and tells the agent to show the user the consent text and ask (the API itself answers `400 immediate_start_consent_required`). Consumers withdraw through support: the number is released and the part not provided is refunded. `purchase_intent_id` is the idempotency key: a retry with the same id never charges twice. Countries that need identity documents answer `202` with `status: "kyc_required"` and nothing charged; the agent reads `kyc_fields`, collects them and calls again with `values` and `documents` (base64, or a file path on a local server). The number then stays `pending_regulatory` until our carrier approves it. A `202` with `status: "pending_payment"` means paid while the carrier confirms the order: it ends `active` or `failed` (refunded), usually within about 15 minutes, and must not be bought again. Countries in this first version: US, GB, ES, FR, DE, IT, MX, BR (local, mobile and national numbers, no toll-free); at most 5 numbers per account by default and one purchase every 10 minutes.
- **Declined identity review**: a declined review (`regulatory_declined`, `phone_number_declined` webhook and an email) keeps the payment and the monthly charge is paused (nothing renews). `phone_numbers_read` `kyc_review` shows the review status, which requirements were declined (`needs_fix`), the fields to send again and the reviewer's comments; `fix_phone_number_kyc` `resubmit` sends only the corrected `values`, `documents` and/or `end_user` and submits the review again (back to `pending_regulatory`, never charged again), and `reply` answers the reviewer. If the number is gone, `resubmit` answers `409 phone_number_unavailable` with `keeps_payment: true`: send `phone_number` with another available number of the same country and type at no higher price. While declined, the number carries `declined_at` and `remediation_deadline_at` (`declined_at` + 30 days), the last day to fix it; the agent tells the user that date. If nothing is fixed within 30 days, or the number is released, the purchase is cancelled and refunded and the number released. Once approved the number turns active and billing resumes.
- **Shareable KYC links** (`manage_phone_kyc_links`): `create` makes a white-label page (no login, single use, 7 days, your `branding`, `redirect_url`, `language` en, es or pt-BR) where your end user fills in their own identity and documents and accepts the terms; when they submit it, the number is bought and **billed to your account**. At most 20 active links; `revoke` stops one at once (a used link cannot be revoked: release the number instead). `phone_numbers_read` `kyc_links` lists them with their status and the number each one bought. An individual end user also gives the immediate-start consent on the page. The page is for the end user only: no tool fills it in. Guide: https://docs.upload-post.com/guides/phone-number-kyc-link.
- **Calls**: no outbound calls and **no emergency calls** (112 / 911). `manage_phone_number` `update_voice` sets forwarding (to geographic or mobile numbers in the number's country or the end user's country), voicemail, recording and transcription.
- **SMS**: `send_sms` sends from non-US/CA numbers; US and Canadian numbers receive SMS but cannot send yet (`403 sms_registration_required`). STOP opt-outs are honoured, at most 10 messages per recipient per 24 h and 1 per second per number.
- **WhatsApp**: `manage_phone_number` `prepare_whatsapp`, then the user connects WhatsApp (`get_connect_link` with `platforms: ["whatsapp"]`), adds the number in Meta's window and chooses **Phone call** to get the code; Upload-Post answers the call and the agent polls `phone_numbers_read` `codes` for the code.
- **Release** (`release_phone_number`, `confirm: true`) is final: WhatsApp on the number stops working and the carrier may give the number to someone else. `port_out_info` gives what another carrier needs to take the number instead.
- Webhook events (opt-in by name in `webhook_events` or a webhook subscription): `sms_received`, `call_received`, `voicemail_received`, `phone_number_activated`, `phone_number_declined`, `phone_number_released`, `phone_number_port_out`, `phone_number_kyc_comment` (the carrier's reviewer wrote a comment), `phone_number_kyc_resubmitted` (corrections sent, back to `pending_regulatory`).
- Buying, KYC, fixing a review and answering its reviewer, KYC links, release and port-out details are for the account owner or an Admin (`403 phone_numbers_owner_only` for other team members).

### Telegram, Bluesky and Google Business

The resource tools (`manage_telegram_chat`, `manage_telegram_bot`, `bluesky_read`, `manage_bluesky_account`, `google_business_read`) take an `action` and a `params` object with the REST API's own field names, so one tool covers a whole resource without a tool per endpoint. Deletions and other changes that cannot be undone carry the API's own `confirm: true`, which the agent sets only after the user approves.

Publishing takes the new per-network options in `platformOptions`: sponsored content (`paidPartnership`, `facebookSponsorId`), Telegram (`telegramPoll`, `telegramLocation`, `telegramVenue`, `telegramContact`, `telegramDice`, `telegramReplyMarkup` buttons, `telegramPin`, `telegramDisableNotification`, `telegramProtectContent`, `telegramMessageThreadId`, `telegramHasSpoiler`, `telegramCaptionOverflow`…), Bluesky (`blueskyTags`, `blueskyThreadgate`, `blueskyPostgate`, `blueskyQuoteUri`, `blueskyThreadOverflow`, `blueskyCaptions`, `blueskyVideoPresentation`, `blueskyGifAsVideo`) and Google Business (`gbpScheduledTime`, `gbpRecurrence*`, `gbpMultiMedia`, `gbpUploadToGallery`). Telegram paid broadcasts (`telegramAllowPaidBroadcast`) and the end-client approval flag of `generate_jwt` (`clientApproval`) show up once the installed `upload-post` SDK sends them (2.22.0 or later): uploads go through the SDK, which drops fields it does not know. `unpublish_post` deletes Telegram posts (`delete_all_messages` for the messages a long post was split into), `get_analytics` takes `telegram`, and `list_dm_conversations` takes Bluesky's `view: "summary"` and `include: "unread_counts"`.

Country targeting: `upload_video`, `upload_photos` and `upload_text` take `platformOptions.facebookTargeting` (who can see a Facebook Page post) and `facebookFeedTargeting` (who it is shown to first). `{ countries: ["GB", "US"] }` with ISO 3166-1 alpha-2 codes is sent as Meta's `{ geo_locations: { countries: [...] } }`; any other key goes to Meta as is. LinkedIn Company Page posts (and `upload_document`) take `linkedinTargetGeoLocations` (`urn:li:geo:<id>` URNs) and the other `linkedinTarget*` facets (industries, seniorities, job functions, degrees, fields of study, organizations (schools), staff count ranges, interface locales, raw `linkedinTargetEntities`), plus `linkedinTargetCheckAudience` to refuse a post that reaches fewer than 300 followers. YouTube cannot restrict countries through its API.

YouTube works the same way (`youtube_read` and five `manage_youtube_*` tools). Each account has a daily YouTube allowance for these calls (200 units on the free plan, 2,000 on paid plans, reset at midnight Pacific time; `youtube_read` with `action: "quota"` shows what is left): reads cost about 1 unit, most writes 50 and caption uploads 400 or more. Images and caption files are taken by public URL (`image_url`, `file_url`, `thumbnail_url`), never as a path. Uploads take `youtubeLocalizations` and `youtubeBrandPartner`, and `edit_post` edits YouTube videos (title, description, tags, privacy, translations, brand partner…).

Also outside ChatGPT: `create_comment` takes `imageUrl` for TikTok image comments and posts top-level Instagram comments on the account's own posts, `manage_instagram_messaging_profile` sets the Instagram ice breakers and persistent menu, `get_post_comments` returns Instagram `like_count` and `hidden`, `get_analytics` Instagram `breakdowns_detail`, `get_post_analytics` Instagram `profile_activity` and `reels_skip_rate`, `get_suggestions` takes `type: "trending"` (the searches trending on TikTok now; an empty list comes with `warnings`) and `personalized`, and `get_post_analytics` documents TikTok's `media_type` and `engagement_likes`. The new upload options of the API (Threads GIFs, spoilers and ghost posts, the X video card and clips, Facebook backdating) reach these tools once the `upload-post` SDK sends them.

These tools and parameters are not in ChatGPT's surface yet: they join it with the next app review. `npm run check` compares what ChatGPT sees with the reviewed snapshot in `scripts/fixtures/chatgpt-tools.json`.

### Confirmation before acting

Tools that publish or reach other people as the user run in two steps. Called without `confirmed: true`, they return `status: "confirmation_required"` with a preview of exactly what would go out (text, media, platforms or recipients, buttons, keywords, timing) and do nothing; the model shows it to the user and repeats the call with `confirmed: true` once they approve. This covers `upload_video`, `upload_photos`, `upload_text`, `upload_document`, `send_dm`, `reply_to_comment`, `public_reply_to_comment`, `create_comment`, `reply_to_google_business_review`, `edit_comment`, `unpublish_post`, `start_autodm` and `manage_autodms` with `action: "start"`, `create_autodm_rule`, `redeliver_webhook`, `edit_post`, `repost_post`, `post_action` (except private bookmarks), the YouTube comment and live chat writes, live chat bans, abuse reports and the YouTube deletions, `manage_chatgpt_ads` when it spends money or cannot be undone (activating, archiving, updating, or creating something active; pausing and paused drafts run straight away), `create_webhook_subscription`, `delete_webhook_subscription`, `test_webhook_subscription`, `manage_webhook_settings` when it changes or removes where events go or sends a test notification, `approve_post`, `reject_post`, `withdraw_pending_post`, `manage_profile` disconnecting a network, `purchase_phone_number`, `send_sms`, `release_phone_number`, `fix_phone_number_kyc`, `manage_phone_kyc_links`, `save_post` on Pinterest, Telegram invoices and Business stories, deleting a Google review reply, plus `comment_action` / `hide_comment` when they edit a comment or ban its author. `delete_user` deletes only when `confirm_username` repeats the profile name. Uploads with a `scheduledDate` or `addToQueue` run straight away, because a scheduled or queued post can still be reviewed and cancelled before it publishes; this also lets scheduled, unattended runs post. ChatGPT, which asks the user before every write tool, keeps the single-step tools.

Reddit publishing is switched off while the Reddit app is unavailable: `reddit` is not offered as a platform and asking for it fails with `reddit_unavailable`. Self-hosters can set `UPLOAD_POST_REDDIT_ENABLED=true` once it is back.

### ChatGPT video upload UI

`open_upload_studio` renders a ChatGPT Apps component for file-based publishing: one video, or one or more images (up to 10, for a carousel; pass `mediaType: "photos"`). For each file the widget creates a short-lived Upload-Post/R2 staging upload, PUTs the file directly to R2 (files up to 200 MB are read into memory first, since some mobile pickers hand over files the browser cannot stream; network errors are retried twice with the same signed URL) and completes the upload, one file at a time, then calls `upload_video` or `upload_photos` with the returned temporary media URLs in order. For photos it can instead hand the staged URLs back to ChatGPT ("Send to ChatGPT"), which then calls `upload_photos` itself, e.g. with a different caption per platform. `upload_video` and `upload_photos` refuse `/mnt/data` and sandbox attachment paths and point the model at the Studio.

The widget speaks the ChatGPT Apps SDK bridge, so it is **only advertised to ChatGPT** (detected from `clientInfo` at `initialize`; override the match with `UPLOAD_POST_STUDIO_CLIENTS=<regex>`). Every other host (claude.ai, Claude Desktop, Claude Code, Cursor, …) does not see the tool or its `ui://` resource; instead `create_media_upload` / `complete_media_upload` are exposed to the model with step-by-step guidance, and `upload_video` tells the assistant to ask for a public URL or send the user to the dashboard when the client cannot PUT the file itself.

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

### Connect social accounts from the chat (MCP Apps)

`open_social_accounts` shows one card per network (TikTok, Instagram, YouTube, LinkedIn, Facebook, X, Threads, Pinterest, Bluesky, Google Business, Telegram and the rest under "More networks"), each marked connected, needs reconnecting or not connected. It is an [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) view (`ui://upload-post/social-accounts.html`, `text/html;profile=mcp-app`), built on the open standard rather than the ChatGPT-only bridge.

- **One button per network.** The click asks the server for a link at that moment (the view calls `create_social_connect_link`, visible to the view only) and opens it in a new tab through the host (`ui/open-link`): network sign-ins such as TikTok, Meta or Google do not run inside an iframe. The link is a signed one-click page of the selected profile that shows only that network, with no Upload-Post login, and it names the network (`&connect=tiktok`) so the page starts that connection by itself: the user goes through Upload-Post straight to the network's sign-in; networks connected with a form (Bluesky, Telegram, Discord, Mastodon, WordPress, …) open the profile's full connection page. For a profile the MCP did not create, the link is minted with `preserve_settings`, so its white-label connection settings (logo, texts, redirect, platform list) are never touched. The dashboard is only the fallback: several profiles and none selected, or the API not answering.
- **No "done" needed.** After a click the view checks again every 5 s, for at most 3 minutes per click and 120 checks per view, and stops as soon as the network is connected. A new connection turns the card green and updates the model's context (`ui/update-model-context`); a "Continue in the chat" button sends a message only when the user clicks it.
- **Who sees it.** Only hosts that declare MCP Apps support in `initialize` (`capabilities.extensions["io.modelcontextprotocol/ui"].mimeTypes` containing `text/html;profile=mcp-app`). Hosts that do not declare it keep the text flow (`list_users` → `get_connect_link`). ChatGPT does not get it yet: its tool surface stays the one OpenAI reviewed until the next app submission. `UPLOAD_POST_MCP_APPS=off` turns the view off for everyone.
- Expired connections (`reauth_required`) get the same signed link as new ones, in the view and in upload errors.

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
| `UPLOAD_POST_ACT_AS_USER` | stdio   | —                                  | Team members: the account owner's email, sent as `X-Act-As-User` so the server acts on the owner's account with the member's role. Never applied in `--http` mode. |
| `UPLOAD_POST_MCP_PORT`    | http    | `8080`                             | Port for `--http` mode.                  |
| `UPLOAD_POST_MCP_MAX_BODY_MB` | http | `10`                            | Largest `/mcp` request body accepted; bigger ones get `413`. |
| `UPLOAD_POST_MCP_VALIDATE_API_KEYS` | http | `true`                    | Check a pasted API key once against `GET /uploadposts/me` (cached) before opening a session for it; a rejected key gets `401`. |
| `UPLOAD_POST_MCP_KEY_CHECK_TTL_MS` | http | `600000`                   | How long an accepted key is trusted before it is checked again. |
| `UPLOAD_POST_MCP_SESSION_SECRET` | http | random at start              | Key that signs session ids. Set it (any long random string) so sessions survive a restart or a deploy, and give every replica the same one. |
| `UPLOAD_POST_MCP_MAX_SESSIONS` | http | `2000`                         | Sessions kept in memory (about 2 MB each); past it the longest-idle one leaves memory and is rebuilt on its next request. Not a limit on how many sessions exist. |
| `UPLOAD_POST_MCP_MAX_SESSIONS_PER_KEY` | http | `200`                  | Sessions of one credential kept in memory; past it that credential's own longest-idle one leaves memory (and is rebuilt when used again). |
| `UPLOAD_POST_MCP_SESSION_TTL_MS` | http | `1800000`                    | Idle time after which a session leaves memory. It still works afterwards: it is rebuilt on its next request. |
| `UPLOAD_POST_MCP_AUTH_FAIL_MAX` | http | `20`                          | `401`s on `/mcp` one client IP may collect per window; past it that IP gets `429` + `Retry-After` (sessions and keys already verified still pass; one request per probe interval is checked normally). `0` turns it off. |
| `UPLOAD_POST_MCP_AUTH_FAIL_WINDOW_S` | http | `300`                    | Window for the count above; a held IP is released this long after its last failure. |
| `UPLOAD_POST_MCP_AUTH_FAIL_PROBE_S` | http | `30`                      | While held, one request per this many seconds goes through the normal auth path. |
| `UPLOAD_POST_MCP_TRUST_PROXY` | http | `auto`                          | Whether the client IP is the last `X-Forwarded-For` hop: `auto` (only when the peer is a private address, i.e. a local reverse proxy), `true` or `false`. |
| `UPLOAD_POST_MCP_ALLOW_LOCAL_FILES` | http | `false`                  | Let tools read media from file paths on the server's disk. Off for a shared host (only http(s) URLs are accepted); turn it on only when the HTTP server runs next to your own files. stdio always allows paths. |
| `UPLOAD_POST_MCP_APPS`    | both    | on                                 | `off` stops advertising MCP Apps views (the social accounts cards) to every host. |
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
- In ChatGPT Apps, prefer `open_upload_studio` for user-selected video and image files. It avoids local-path handoff issues by uploading to short-lived Upload-Post/R2 staging, then passing temporary media URLs to `upload_video` / `upload_photos`.
- In any other client with a local file: if the client can run HTTP requests (Claude Code, Cursor, a script), stage it with `create_media_upload` → PUT the bytes to `upload_url` → `complete_media_upload`, then pass the returned `media_url` to `upload_video`. Hosted chats without that ability (claude.ai) need a public HTTPS URL or the dashboard at https://app.upload-post.com.
- To send video **bytes directly** (a client that holds the file rather than a URL), pass `videoBase64` to `upload_video` instead of `videoPathOrUrl`. The server writes it to a temp file, uploads, then deletes it. Inline bytes are capped at `UPLOAD_POST_MAX_INLINE_MB` (default 100 MB), and in `--http` mode the whole request at `UPLOAD_POST_MCP_MAX_BODY_MB` (default 10 MB, roughly 7 MB of video once base64-encoded) — for larger videos use a public URL.
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
- OAuth metadata is served both at `/.well-known/oauth-protected-resource` and at the path-inserted form `/.well-known/oauth-protected-resource/mcp` (RFC 9728 §3.1), and likewise for `oauth-authorization-server`.
- In `--http` mode the server writes one stderr line per failed request and per OAuth/well-known request (method, path, status, auth scheme, user agent — never query strings or credentials). Set `UPLOAD_POST_MCP_ACCESS_LOG=all` to log every request or `off` to disable it.
- If ChatGPT shows `redirect_uri not on allow-list` during OAuth, add the exact `redirect_uri` from the failing authorize request to the Upload-Post backend OAuth redirect allow-list. For ChatGPT clients this is typically on `https://chatgpt.com/.../oauth/callback` or `https://chat.openai.com/.../oauth/callback`.
- OAuth redirect callbacks are pre-allowed for: Claude (claude.ai/claude.com), ChatGPT, Cursor, VS Code (stable + Insiders), Smithery, Glama, Toolhouse, Perplexity (standard + Enterprise), Mistral Studio debugger and Postman — plus any `http://localhost`/loopback redirect (RFC 8252), which covers Claude Code, Windsurf, Cline, Continue, Goose, Gemini CLI and other `mcp-remote`-style clients. Platforms without a documented fixed callback (e.g. Grok, Le Chat production) are added on request.
- All tools declare MCP `readOnlyHint`/`destructiveHint` annotations so clients can surface confirmation prompts for destructive operations, and the tools that publish or message people also require an explicit `confirmed: true` (see [Confirmation before acting](#confirmation-before-acting)).

Report a security issue: **info@upload-post.com** (encrypted PGP available on request).

---

## License

MIT © Upload-Post
