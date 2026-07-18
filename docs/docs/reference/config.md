# Configuration

All configuration is via environment variables, loaded from `e2e/.env` (or your shell). No hardcoded secrets anywhere in the codebase.

## LLM Providers

Three priorities, tried in order:

### Priority 1 — Volcengine Ark (OpenAI-compatible)

```env
ARK_API_KEY=
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/coding/v3
ARK_MODEL=doubao-seed-code
```

### Priority 2 — Model Proxy (Anthropic format)

Useful if you run [anthropic-proxy](https://github.com/maxnowack/anthropic-proxy) locally to bridge Claude API.

```env
MODEL_PROXY_URL=http://127.0.0.1:43191
MODEL_PROXY_KEY=
```

### Priority 3 — Direct OpenAI-compatible

Works with OpenAI, Ollama, vLLM, Together, Groq, OpenRouter — anything that speaks OpenAI's chat completions API.

```env
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1   # or http://localhost:11434/v1 for Ollama
OPENAI_MODEL=gpt-4o-mini
```

## Channels

| Env | Channel | Purpose |
|---|---|---|
| `PORT` | HTTP | Port for `HttpChannel` (default 3456) |
| `FEISHU_APP_ID` `FEISHU_APP_SECRET` `FEISHU_VERIFICATION_TOKEN` | Feishu | Feishu / Lark bot |
| `WECOM_CORP_ID` `WECOM_AGENT_ID` `WECOM_SECRET` | WeCom | 企业微信 bot |
| `TELEGRAM_BOT_TOKEN` | Telegram | Telegram bot |
| `GITHUB_WEBHOOK_SECRET` `GITHUB_TOKEN` | GitHub | GitHub webhook + reply |

## Image Generation

```env
IMAGE_API_URL=
IMAGE_API_KEY=
IMAGE_MODEL=flux-1.1-pro
```

## Memory

```env
MEMORY_DB_PATH=./.data/memory.sqlite
MEMORY_COMPRESS_THRESHOLD=50   # entries above this trigger compression
```

## Sandbox

```env
SANDBOX_TIMEOUT_MS=10000   # run_code timeout
SANDBOX_MAX_MEMORY_MB=128
```

## Logging

```env
LOG_LEVEL=info   # debug | info | warn | error
```

## Profile Defaults

The 6 built-in profiles:

| Profile | Tools Included |
|---|---|
| `minimal` | run_code only |
| `coding` | file, search, shell, run_code |
| `research` | web, run_code, todo, memory |
| `full` | all 16 tools |
| `coding-with-web` | coding + web |
| `research-with-code` | research + file/search/shell |

You can always add more categories on top:

```ts
createAgent({
  profile: "coding",
  extraCategories: ["web", "image"],
});
```
