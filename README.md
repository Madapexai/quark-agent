# ⚛️ Quark Agent

> **The tiniest AI agent framework.** Quark-sized core, universe-sized possibilities.

Quark Agent is a micro-kernel AI agent framework where the core is smaller than 5KB (gzipped), and everything else — tools, skills, channels, providers — is a snap-in plugin. Like quarks combining into particles, mix any skills to build the agent you need.

---

## ✨ Why Quark Agent?

| | Quark Agent | Claude Code | Codex CLI | Hermes |
|---|---|---|---|---|
| **Core size** | <5KB gzip | — | — | — |
| **Plugin system** | ✅ First-class | ❌ | ❌ | ❌ |
| **Skill composition** | ✅ Free mix | Fixed set | Fixed set | Fixed set |
| **Self-evolving** | ✅ GEPA optimizer | ❌ | ❌ | ❌ |
| **Multi-channel** | ✅ CLI/HTTP/Feishu/WeChat/Telegram/GitHub/Webhook | CLI only | CLI only | CLI only |
| **A2A protocol** | ✅ Built-in | ❌ | ❌ | ❌ |
| **Profile presets** | ✅ minimal/coding/data/qa/research/full | — | — | — |
| **Language** | TypeScript | — | — | — |

---

## 🚀 Quick Start

```bash
# Clone
git clone https://github.com/your-username/quark-agent.git
cd quark-agent

# Install
npm install

# Configure
cp e2e/.env.example e2e/.env
# Edit .env with your API key

# Run the demo
npx tsx e2e/demo-server.ts
# → Open http://localhost:3456
```

### One-liner to create an agent

```typescript
import { createAgent } from "quark-agent";

const { agent } = await createAgent({
  config: { model: "doubao-seed-code" },
  apiKey: process.env.ARK_API_KEY!,
  baseURL: "https://ark.cn-beijing.volces.com/api/coding/v3",
  profile: "coding",           // start with coding toolset
  extraCategories: ["web"],    // add web tools
  ossPackages: ["axios"],      // auto-wrap npm packages as tools
});

const result = await agent.run({ input: "Refactor the auth module" });
```

---

## 🧩 Core Concept: Skills You Can Mix

Quark Agent ships **16 built-in tools** organized in 7 categories. Pick what you need — or build your own.

### Built-in Tools

| Category | Tools | Description |
|----------|-------|-------------|
| 📁 **File Ops** | `read_file`, `write_file`, `edit_file`, `list_dir` | Read, write, edit, and list files |
| 🔍 **Search** | `search_files` (grep), `find_files` (glob) | Find files and search content |
| 🐚 **Shell** | `shell` | Execute commands with timeout & sandbox |
| 🌐 **Web** | `web_search`, `web_fetch` | Search the web, fetch pages |
| 💻 **Code** | `run_code` | Execute JS/Python in sandbox |
| 🎨 **Multimodal** | `generate_image` | Text-to-image generation |
| 📋 **Tasks** | `todo_write`, `task_list` | Track multi-step progress |
| 🧠 **Memory** | `memory_save`, `memory_search` | Persistent key-value memory |
| 🌤️ **Data** | `weather` | Real-time weather data |

### Profile Presets

Don't want all tools? Use profiles to start lean:

```typescript
// minimal  → 3 tools (code_exec, memory_recall, http_get)
// coding   → file ops + search + shell + run_code
// data     → csv read + analyze + code_exec
// qa       → web_search + web_fetch + memory
// research → web + code + memory + todo
// full     → everything
```

### Build Your Own Skill

```typescript
import { defineAction, ActionRegistry } from "quark-agent";

// One definition → exposed to agent/HTTP/CLI/MCP/A2A
const mySkill = defineAction({
  name: "send_email",
  description: "Send an email",
  parameters: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
  handler: async (args) => { /* ... */ return { sent: true }; },
});

// Register and use
const registry = new ActionRegistry();
registry.register(mySkill);
```

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Channels                          │
│  CLI · HTTP · Feishu · WeChat · Telegram · GitHub   │
├─────────────────────────────────────────────────────┤
│                  Agent Runtime                       │
│  ReAct Loop · Planner · Sub-Agent · Self-Healer     │
├──────────┬──────────┬──────────┬───────────────────┤
│  Tools   │  Skills  │ Provider │     Plugins       │
│  16+     │  Store   │ Multi    │ A2A·SSE·MCP·Hub   │
├──────────┴──────────┴──────────┴───────────────────┤
│              Micro-Kernel (<5KB gzip)               │
│         Agent · Context · Runtime · Types           │
└─────────────────────────────────────────────────────┘
```

### Micro-Kernel Layers

| Layer | Package | What's Inside |
|-------|---------|---------------|
| **Kernel** | `packages/core` | Agent, Context, Runtime, Types — zero deps, <10KB |
| **Plugins** | `packages/plugins` | A2A, SSE, Workspace, defineAction, InMemory |
| **Extensions** | `packages/extensions` | Sessions, Healer, Skill scoring |
| **Full** | `src/` | All tools, channels, providers — everything |

---

## 🔌 Channels: One Agent, Many Entrypoints

```typescript
// CLI
import { CliChannel } from "quark-agent";
new CliChannel({ agent }).start();

// HTTP + SSE streaming
import { HttpChannel } from "quark-agent";
new HttpChannel({ agent, port: 3456 }).start();

// Feishu (Lark) bot
import { FeishuChannel } from "quark-agent";
new FeishuChannel({ agent, appToken, ... }).start();

// GitHub bot
import { GitHubChannel } from "quark-agent";
new GitHubChannel({ agent, webhookSecret }).start();

// Webhook (generic)
// WeChat · Telegram · ...
```

---

## 🧬 Self-Evolving

Quark Agent can improve itself using the **GEPA optimizer**:

```typescript
import { Evolver } from "quark-agent";

const evolver = new Evolver({
  agent,
  evalCases: [...],   // your test cases
  generations: 10,
});

await evolver.evolve();  // optimizes prompts & tool selection
```

---

## 🔗 A2A Protocol

Agents can discover and talk to each other:

```typescript
import { A2ARegistry, getA2ARegistry } from "quark-agent";

// Register your agent
getA2ARegistry().register({
  name: "code-reviewer",
  skills: [{ name: "review", description: "Review code" }],
});

// Call another agent
const result = await agent.run({
  input: "Ask the code-reviewer to check this PR",
});
```

---

## 📦 Demo: ReAct Agent with 16 Tools

The `e2e/` directory contains a full-featured demo:

```bash
npx tsx e2e/demo-server.ts
```

- **SSE streaming**: Real-time thinking process, tool calls, results
- **3-layer LLM routing**: Ark API → Model Proxy → Direct API → Fallback
- **Professional UI**: Zero external dependencies, inline SVG icons
- **ReAct loop**: LLM thinks → picks tool → executes → repeats (max 8 rounds)
- **`.env` config**: No hardcoded secrets

### Configuration

```bash
cp e2e/.env.example e2e/.env
```

```env
# Priority 1: Volcengine Ark (OpenAI-compatible)
ARK_API_KEY=your_key_here
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/coding/v3
ARK_MODEL=doubao-seed-code

# Priority 2: Model Proxy (Anthropic Messages API)
MODEL_PROXY_URL=http://127.0.0.1:43191
MODEL_PROXY_KEY=

# Priority 3: Direct OpenAI-compatible API
OPENAI_API_KEY=

# Workspace
WORKSPACE_ROOT=/workspace
SHELL_TIMEOUT=30000
```

---

## 🧪 Tested & Verified

- ✅ 13/13 API integration tests pass
- ✅ 12/12 browser E2E tests pass (with screenshots)
- ✅ All 16 tools verified with real LLM (doubao-seed-code)
- ✅ Multi-step ReAct reasoning validated (up to 8 tool calls per query)

Run tests yourself:

```bash
# API tests
node e2e/test-tools.mjs

# Browser E2E tests (requires Chrome)
node e2e/e2e-browser-test.mjs
```

---

## 📂 Project Structure

```
quark-agent/
├── src/
│   ├── core/          # Agent, Context, Runtime, Types
│   ├── tools/         # 16+ built-in tools (file, web, code, shell, ...)
│   ├── channel/       # CLI, HTTP, Feishu, WeChat, Telegram, GitHub
│   ├── provider/      # OpenAI, Anthropic, Gemini, Ollama, Multi
│   ├── plugin/        # Plugin registry + built-in plugins
│   ├── skills/        # Skill discovery, scoring, sedimentation
│   ├── evolve/        # GEPA self-evolution optimizer
│   ├── a2a/           # Agent-to-Agent protocol
│   ├── sync/          # EventBus + SSE real-time sync
│   ├── memory/        # SQLite memory + compression
│   ├── sandbox/       # VM sandbox for code execution
│   └── ...
├── packages/
│   ├── core/          # Zero-dep micro-kernel (<10KB)
│   ├── plugins/       # Official plugins
│   └── extensions/    # High-order extensions
├── e2e/               # Demo server + tests + UI
│   ├── demo-server.ts # Full-featured demo
│   ├── webui/         # Professional web UI
│   ├── .env.example   # Configuration template
│   ├── test-tools.mjs # API integration tests
│   └── e2e-browser-test.mjs # Browser E2E tests
└── package.json
```

---

## 🤝 Contributing

Contributions welcome! Whether it's:
- 🛠️ New tools (wrap any npm package with `integratePackage`)
- 📡 New channels (Slack, Discord, ...)
- 🧠 New providers (local LLMs, ...)
- 🎨 UI improvements
- 📚 Docs and examples

---

## 📄 License

MIT

---

<div align="center">

**Quark Agent** — Small core. Infinite combinations.

⭐ Star if you like it!

</div>
