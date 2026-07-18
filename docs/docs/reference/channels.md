# 7 Channels

The same Agent instance can be exposed through 7 different channels. Pick one (or several) — they all share the same runtime, tools, and skills.

## Channel Matrix

| Channel | Use Case | Two-way? |
|---|---|:---:|
| `CliChannel` | Local terminal REPL | ✅ |
| `HttpChannel` | Web UI, REST API, SSE streaming | ✅ |
| `FeishuChannel` | Feishu / Lark bot | ✅ |
| `WeComChannel` | WeCom (企业微信) bot | ✅ |
| `TelegramChannel` | Telegram bot | ✅ |
| `GithubChannel` | GitHub issue / PR comments | ✅ |
| `WebhookChannel` | Generic incoming webhook | inbound |

## Common API

Every channel implements the same contract:

```ts
import { createAgent, CliChannel, HttpChannel } from "quark-agent";

const { agent } = await createAgent({ apiKey: process.env.ARK_API_KEY!, profile: "full" });

// Pick your entrypoint — same agent, different surface
new CliChannel({ agent }).start();
// or
new HttpChannel({ agent, port: 3456 }).start();
```

## HTTP + SSE

The `HttpChannel` exposes:

- `POST /api/chat/stream` — SSE streaming chat (the main entrypoint)
- `POST /api/chat` — non-streaming chat (returns full JSON)
- `GET /api/status` — health check

SSE event types:

| Event | Payload | When |
|---|---|---|
| `thinking` | `{ content }` | Agent is reasoning |
| `tool_call` | `{ name, args }` | About to invoke a tool |
| `tool_result` | `{ name, result }` | Tool returned |
| `text_delta` | `{ content }` | Streamed token |
| `text` | `{ content }` | Full final text (non-streaming fallback) |
| `done` | `{}` | Stream complete |
| `error` | `{ message }` | Something broke |

## Feishu / WeCom / Telegram

Each chat channel expects a bot token in `.env`:

```env
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_VERIFICATION_TOKEN=

# WeCom
WECOM_CORP_ID=
WECOM_AGENT_ID=
WECOM_SECRET=

# Telegram
TELEGRAM_BOT_TOKEN=
```

Then start the channel:

```ts
new FeishuChannel({ agent }).start();
new WeComChannel({ agent }).start();
new TelegramChannel({ agent }).start();
```

## GitHub

The `GithubChannel` listens for webhook events (issue comments, PR comments) and replies in-thread. Set:

```env
GITHUB_WEBHOOK_SECRET=
GITHUB_TOKEN=        # PAT with repo:comment permission
```

## Webhook

The most flexible — accepts any POST with a `message` field. Useful for Zapier, n8n, custom integrations.

```bash
curl -X POST http://localhost:3456/webhook \
  -H "Content-Type: application/json" \
  -d '{"message": "What is 2+2?"}'
```
