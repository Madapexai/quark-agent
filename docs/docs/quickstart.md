# Quick Start

Get a running agent in 30 seconds.

## 1. Install

```bash
# Option A: Zero install - run directly from GitHub
npx github:Madapexai/quark-agent setup
npx github:Madapexai/quark-agent chat

# Option B: Clone and run locally
git clone https://github.com/Madapexai/quark-agent.git
cd quark-agent
npm install
```

Requirements: Node.js >= 20, an LLM API key (see below).

## 2. Configure

```bash
npx tsx bin/cli.ts setup
```

The interactive setup wizard walks you through:

1. **Choose provider** - 22 options (GLM, DeepSeek, OpenAI, Anthropic, Ollama...)
2. **Enter API key** - Paste your key
3. **Select model** - Pick from 49 models
4. **Select channels** - CLI, HTTP, Discord, Slack, Telegram...
5. **Select sandbox** - strict / balanced / permissive

This creates `.quark-agent.json` in your home directory.

### Get a Free API Key

| Provider | Cost | Where to get |
|---|---|---|
| **GLM / ZhipuAI** | Free | https://open.bigmodel.cn/ |
| **Agnes AI** | Free ($0/1M tokens) | https://wiki.agnes-ai.com/ |
| **Ollama** (local) | Free | https://ollama.ai/ |

## 3. Run

```bash
# Interactive chat (default)
npx tsx bin/cli.ts chat

# One-shot Q&A
npx tsx bin/cli.ts ask "What is 2+2?"

# HTTP + SSE server
npx tsx bin/cli.ts serve --port 3456

# WebUI Dashboard (port 8788)
npx tsx bin/cli.ts dashboard
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `quark-agent setup` | Interactive setup wizard |
| `quark-agent chat` | Interactive chat (default) |
| `quark-agent ask "question"` | One-shot Q&A |
| `quark-agent serve --port` | HTTP + SSE server |
| `quark-agent dashboard` | WebUI dashboard (port 8788) |
| `quark-agent add <package>` | Install plugin from npm/Git |
| `quark-agent list` | List installed plugins |
| `quark-agent evolve` | Run prompt self-evolution |

## 4. Dashboard

The dashboard provides a full WebUI for chat, configuration, and management:

```bash
npx tsx bin/cli.ts dashboard --port 8788
```

Then open http://localhost:8788 in your browser.

### First Login

On first start, a random admin password is generated and printed to the console:

```
============================================================
[dashboard] 首次启动 - 管理员账号已创建
  用户名: admin
  密码:   WDWoM7SLmpim9aMh
  请妥善保存此密码，登录后立即修改！
============================================================
```

Log in with these credentials, then change your password in Settings.

### Dashboard Features

- **Chat** - SSE streaming, multimodal upload (drag & drop / paste)
- **Sessions** - Multiple chat sessions with history
- **Settings** - Provider, model, channels, sandbox configuration
- **Tools** - View and manage available tools
- **Plugins** - Install/uninstall skills

## 5. Programmatic API

```ts
import { createAgent } from "quark-agent";

const { agent } = await createAgent({
  apiKey: process.env.GLM_API_KEY!,
  profile: "coding",          // coding-only tools
  extraCategories: ["web"],   // plus the Web category
});

// Run a task
const result = await agent.run("Create a hello.js file");
console.log(result.reply);
```

## 6. OpenAI Compatible API

Quark Agent exposes an OpenAI-compatible endpoint - use any OpenAI SDK:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8788/v1",
    api_key="any"  # auth handled by dashboard JWT
)

response = client.chat.completions.create(
    model="quark-agent",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

See [OpenAI Compatible API](./features/openai-api.md) for details.

## Next Steps

- [What's New in v1.0.0](./changelog.md)
- [Features](./features/mcp.md)
- [22 Providers](./reference/providers.md)
- [17 Channels](./reference/channels.md)
- [API Endpoints](./reference/api-endpoints.md)
