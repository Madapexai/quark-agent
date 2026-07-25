# 17 Channels

The same Agent instance can be exposed through 17 different channels. All have real API implementations - no stubs.

## Channel Matrix

| # | Channel | Use Case | Protocol |
|---|---------|----------|----------|
| 1 | `CliChannel` | Local terminal REPL | stdin/stdout |
| 2 | `HttpChannel` | Web UI, REST API, SSE | HTTP + SSE |
| 3 | `DiscordChannel` | Discord bot | Gateway WebSocket |
| 4 | `SlackChannel` | Slack bot | Events API |
| 5 | `TelegramChannel` | Telegram bot | Bot API polling |
| 6 | `FeishuChannel` | Feishu / Lark bot | Event subscription |
| 7 | `WeChatChannel` | WeChat bot | HTTP callback |
| 8 | `WhatsAppChannel` | WhatsApp Cloud API | Webhook + Graph API |
| 9 | `SignalChannel` | Signal messenger | signal-cli-rest-api |
| 10 | `EmailChannel` | Email bot | IMAP + SMTP |
| 11 | `SmsChannel` | SMS via Twilio | Webhook + REST |
| 12 | `MatrixChannel` | Matrix client | Client-Server API |
| 13 | `MattermostChannel` | Mattermost bot | REST + WebSocket |
| 14 | `DingTalkChannel` | DingTalk bot | Outgoing webhook |
| 15 | `WeComChannel` | Enterprise WeChat | Callback + AES decrypt |
| 16 | `RelayChannel` | Cross-channel routing | Config-based |
| 17 | `WebUI` | Dashboard | HTTP + SSE + JWT |

## Common API

Every channel implements the same contract:

```ts
import { createAgent, CliChannel, HttpChannel } from "quark-agent";

const { agent } = await createAgent({ apiKey: process.env.GLM_API_KEY!, profile: "full" });

// Pick your entrypoint - same agent, different surface
new CliChannel({ agent }).start();
// or
new HttpChannel({ agent, port: 3456 }).start();
```

## Channel-Specific Features

### WhatsApp
- HMAC-SHA256 signature verification
- Cloud API message sending
- Supports text, image, template messages

### Email
- Self-built IMAP/SMTP (zero npm dependencies)
- TLS support (ports 465/993)
- Auto-fetch unread emails

### WeCom
- AES-256-CBC message decryption
- EncodingAESKey support
- Access token caching

### Matrix
- `/sync` long-polling with incremental sync
- Room filtering
- Auto-reconnect

### Mattermost
- WebSocket event streaming
- Bot authentication challenge
- Posted event handling
