# Configuration

All configuration is via environment variables, loaded from `e2e/.env` (or your shell). No hardcoded secrets anywhere in the codebase.

## Unified Config System (v0.3.0)

Starting with v0.3.0, configuration is unified across a config file, environment variables, and CLI flags — resolved through a deterministic priority chain.

### Config File Format

Quark Agent reads `.quark-agent.json` from the project root (or the path specified by `--config`):

```json
{
  "llm": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "apiKey": "",
    "baseUrl": "https://api.openai.com/v1"
  },
  "sandbox": {
    "timeoutMs": 10000,
    "maxMemoryMb": 128,
    "policy": "balanced"
  },
  "moa": {
    "enabled": true,
    "defaultTier": "medium"
  },
  "checkpoint": {
    "enabled": true,
    "autoSaveIntervalMs": 30000,
    "dir": ".checkpoints"
  },
  "channels": {
    "http": { "port": 3456 },
    "feishu": {
      "appId": "",
      "appSecret": "",
      "verificationToken": ""
    }
  },
  "logging": {
    "level": "info"
  }
}
```

Generate a starter config interactively:

```bash
quark-agent setup
```

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| **LLM Providers** | | |
| `MICRO_LLM_PROVIDER` | LLM provider (`openai` \| `anthropic` \| `gemini` \| `ark`) | `openai` |
| `MICRO_LLM_MODEL` | Model name | `gpt-4o-mini` |
| `QUARK_API_KEY` | Primary API key (any provider) | — |
| `ARK_API_KEY` | Volcengine Ark API key | — |
| `ARK_BASE_URL` | Ark base URL | `https://ark.cn-beijing.volces.com/api/coding/v3` |
| `ARK_MODEL` | Ark model name | `doubao-seed-code` |
| `MODEL_PROXY_URL` | Anthropic proxy URL | — |
| `MODEL_PROXY_KEY` | Anthropic proxy key | — |
| `OPENAI_API_KEY` | OpenAI-compatible API key | — |
| `OPENAI_BASE_URL` | OpenAI-compatible base URL | `https://api.openai.com/v1` |
| `OPENAI_MODEL` | OpenAI-compatible model name | `gpt-4o-mini` |
| `ANTHROPIC_API_KEY` | Anthropic API key (direct) | — |
| `ANTHROPIC_MODEL` | Anthropic model name | `claude-sonnet-4-20250514` |
| `GEMINI_API_KEY` | Google Gemini API key | — |
| `GEMINI_MODEL` | Gemini model name | `gemini-2.0-flash` |
| **Channels** | | |
| `PORT` | HTTP channel port | `3456` |
| `FEISHU_APP_ID` | Feishu / Lark app ID | — |
| `FEISHU_APP_SECRET` | Feishu / Lark app secret | — |
| `FEISHU_VERIFICATION_TOKEN` | Feishu verification token | — |
| `WECOM_CORP_ID` | WeCom corp ID | — |
| `WECOM_AGENT_ID` | WeCom agent ID | — |
| `WECOM_SECRET` | WeCom secret | — |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token | — |
| `DISCORD_BOT_TOKEN` | Discord bot token | — |
| `DISCORD_GUILD_ID` | Discord guild (server) ID | — |
| `SLACK_BOT_TOKEN` | Slack bot OAuth token (`xoxb-...`) | — |
| `SLACK_APP_TOKEN` | Slack app-level token (`xapp-...`) | — |
| `GITHUB_WEBHOOK_SECRET` | GitHub webhook secret | — |
| `GITHUB_TOKEN` | GitHub API token | — |
| **Image Generation** | | |
| `IMAGE_API_URL` | Image generation API URL | — |
| `IMAGE_API_KEY` | Image generation API key | — |
| `IMAGE_MODEL` | Image model name | `flux-1.1-pro` |
| **Memory** | | |
| `MEMORY_DB_PATH` | SQLite database path | `./.data/memory.sqlite` |
| `MEMORY_COMPRESS_THRESHOLD` | Compression trigger threshold | `50` |
| **Sandbox** | | |
| `SANDBOX_TIMEOUT_MS` | Code execution timeout | `10000` |
| `SANDBOX_MAX_MEMORY_MB` | Max memory for sandbox | `128` |
| `SANDBOX_POLICY` | Security policy preset | `balanced` |
| `SANDBOX_AUTO_APPROVE` | Tool auto-approve mode (`all` \| `safe` \| `none`) | `safe` |
| **Checkpoint** | | |
| `CHECKPOINT_DIR` | Checkpoint storage directory | `.checkpoints` |
| `CHECKPOINT_AUTO_SAVE_MS` | Auto-save interval in ms | `30000` |
| **MoA** | | |
| `MOA_ENABLED` | Enable Mixture of Agents routing | `false` |
| `MOA_DEFAULT_TIER` | Default model tier | `medium` |
| **Logging** | | |
| `LOG_LEVEL` | Log level (`debug` \| `info` \| `warn` \| `error`) | `info` |

### Priority Chain

Configuration values are resolved in this order (later wins):

```
Defaults  <  Config file (.quark-agent.json)  <  Environment variables  <  CLI flags
```

Example — the model is resolved as:

1. **Default**: `gpt-4o-mini`
2. **Config file**: `.quark-agent.json` → `llm.model: "gpt-4o"`
3. **Env var**: `OPENAI_MODEL=gpt-4o-mini`
4. **CLI flag**: `--model gpt-4`

Final value: `gpt-4` (CLI flag wins).

### Setup Wizard

Run the interactive setup wizard to generate a config file and validate API keys:

```bash
quark-agent setup
```

The wizard will:

1. Prompt for LLM provider and API key
2. Validate the key with a test request
3. Ask which channels to enable
4. Set sandbox policy and auto-approve mode
5. Optionally enable MoA and checkpointing
6. Write `.quark-agent.json` to the current directory

Non-interactive mode (CI-friendly):

```bash
quark-agent setup --provider openai --api-key $OPENAI_API_KEY --policy balanced --yes
```

---

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
