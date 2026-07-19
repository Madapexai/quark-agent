<div align="center">

# Quark Agent

**A 5KB agent kernel that composes everything you need.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178c6?style=flat-square?logo=typescript)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](./LICENSE)
[![npm](https://img.shields.io/badge/npm-quark--agent-cb3837?style=flat-square?logo=npm)](https://www.npmjs.com/)
[![Pass Rate](https://img.shields.io/badge/Benchmark-89.0%25-brightgreen?style=flat-square)](./e2e/FULL-EVAL-REPORT.md)
[![GitHub stars](https://img.shields.io/github/stars/Madapexai/quark-agent?style=flat-square)](https://github.com/Madapexai/quark-agent/stargazers)
[![GitHub Discussions](https://img.shields.io/badge/Discussions-Join-blue?style=flat-square?logo=github)](https://github.com/Madapexai/quark-agent/discussions)

**Like quarks compose into protons, compose the agent you need from the smallest possible kernel.**

[English](./README.md) · [简体中文](./README.zh-CN.md)

</div>

---

> Not another all-in-one framework. The kernel is **<5KB gzipped**, and tools, channels, models — **everything is a plug-and-play Skill**.

## Table of Contents

- [Why Quark Agent](#why-quark-agent)
- [Benchmark](#benchmark)
- [30-Second Quick Start](#30-second-quick-start)
- [16 Tools, 7 Categories](#16-tools-7-categories)
- [One Agent, Seven Entrypoints](#one-agent-seven-entrypoints)
- [Self-Evolution (GEPA)](#self-evolution-gepa)
- [A2A: Agents Talking to Agents](#a2a-agents-talking-to-agents)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Testing](#testing)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Community](#community)
- [License](#license)

---

## Why Quark Agent

**Others** give you a fixed toolset, take it or leave it.

**Quark Agent**: 16 tools across 7 categories, 6 profile presets, mix-and-match however you like. Define a new Skill with one `defineAction`.

| | Quark Agent | Claude Code | Codex CLI |
|---|:---:|:---:|:---:|
| Kernel size | **<5KB** | — | — |
| Composable tools | ✅ | ❌ fixed | ❌ fixed |
| Self-evolution (GEPA) | ✅ | ❌ | ❌ |
| Channel entries | 7 | CLI | CLI |
| A2A protocol | built-in | — | — |
| Profile presets | 6 | — | — |
| MoA routing | ✅ | ❌ | ❌ |
| Sandbox policy | ✅ | ❌ | ❌ |
| Setup wizard | ✅ | ❌ | ❌ |

---

## Benchmark

Evaluated on the industry-standard **AgentBench (THUDM)** and **GAIA (Meta/HF)** — 200 tasks total, real LLM, real tool calls. Full trace-level report: [`e2e/FULL-EVAL-REPORT.md`](./e2e/FULL-EVAL-REPORT.md) / interactive HTML: [`e2e/FULL-EVAL-REPORT.html`](./e2e/FULL-EVAL-REPORT.html).

| Benchmark | Total | Pass | Fail | Error | Pass Rate |
|-----------|------:|----:|----:|------:|----------:|
| GAIA (Meta/HF) | 100 | 93 | 7 | 0 | **93.0%** |
| AgentBench (THUDM) | 100 | 85 | 9 | 6 | **85.0%** |
| **Overall** | **200** | **178** | **16** | **6** | **89.0%** |

**GAIA by difficulty** — L1: 97.5% · L2: 94.3% · L3: 84.0%
**AgentBench by category** — DB-Bench: 76.0% · OS-Interaction: 93.3% · Knowledge-Graph: 95.0%

> Reproduce: `PORT=3465 node e2e/full-eval.mjs --bench all` — ~75 minutes, ~200 real LLM calls.

---

## 30-Second Quick Start

```bash
# Zero install — run directly from GitHub
npx github:Madapexai/quark-agent setup   # Interactive setup wizard
npx github:Madapexai/quark-agent chat    # Start chatting!

# Or clone and run locally
git clone https://github.com/Madapexai/quark-agent.git
cd quark-agent && npm install
npx tsx bin/cli.ts setup                 # Setup wizard
npx tsx bin/cli.ts chat                  # Start chatting!
```

> **New in v0.3.0**: `quark-agent setup` walks you through choosing a provider, model, channels, and sandbox policy. No more manual `.env` editing!

> **⚠️ You need to bring your own LLM API key.** Quark Agent is model-agnostic (speaks the OpenAI-compatible API) but does **not** ship with a built-in model. Grab a free key in 2 minutes — see [Get a Free API Key](#-get-a-free-api-key) below.

### 🔑 Get a Free API Key

Quark Agent probes each provider at startup and picks the first healthy one, with automatic fallback. You only need to fill in **one** of these in `e2e/.env`:

| Provider | Model | Cost | Where to get a key |
|---|---|---|---|
| **GLM / ZhipuAI** | `glm-4-flash` | 🆓 Free | https://open.bigmodel.cn/ — register, grab API key |
| **Agnes AI** | `agnes-2.0-flash` | 🆓 Free ($0/1M tokens) | https://wiki.agnes-ai.com/ |
| **Volcengine Ark** | `doubao-seed-code` | 💰 Paid (cheap) | https://www.volcengine.com/product/ark |

**Or use any OpenAI-compatible endpoint:**

| Provider | Env vars to set |
|---|---|
| OpenAI | `OPENAI_API_KEY=sk-...` |
| Ollama (local, no key) | `OPENAI_API_KEY=ollama` · `OPENAI_BASE_URL=http://localhost:11434/v1` · `OPENAI_MODEL=llama3.2` |
| DeepSeek | `DEEPSEEK_API_KEY=...` |
| Together / Groq / OpenRouter / vLLM | `OPENAI_API_KEY=...` · `OPENAI_BASE_URL=...` · `OPENAI_MODEL=...` |

**Easiest path (free, 2 minutes):**

```bash
# 1. Go to https://open.bigmodel.cn/ → register → get API key
# 2. Put it in e2e/.env:
GLM_API_KEY=your_key_here
GLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
GLM_MODEL=glm-4-flash
# 3. Run
npx tsx e2e/demo-server.ts
```

Spin up an agent in three lines of code:

```ts
import { createAgent } from "quark-agent";

const { agent } = await createAgent({
  apiKey: process.env.GLM_API_KEY!,
  profile: "coding",          // coding-only tools
  extraCategories: ["web"],   // plus the Web category
});
```

<details>
<summary><b>Other installation options</b></summary>

```bash
# Run the ReAct demo directly (no UI)
npx tsx examples/basic.ts

# Headless E2E test against the running server
node e2e/test-tools.mjs

# Browser E2E test (requires Chrome)
node e2e/e2e-browser-test.mjs
```

</details>

<details>
<summary><b>Full configuration reference</b></summary>

```bash
cp e2e/.env.example e2e/.env
```

```env
# Priority 1: Volcengine Ark (OpenAI-compatible)
ARK_API_KEY=
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/coding/v3
ARK_MODEL=doubao-seed-code

# Priority 2: Agnes AI (free, OpenAI-compatible)
AGNES_API_KEY=
AGNES_BASE_URL=https://apihub.agnes-ai.com/v1
AGNES_MODEL=agnes-2.0-flash

# Priority 3: GLM / ZhipuAI (free, OpenAI-compatible)
GLM_API_KEY=
GLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
GLM_MODEL=glm-4-flash

# Priority 4: Model Proxy (Anthropic format, local)
MODEL_PROXY_URL=http://127.0.0.1:43191
MODEL_PROXY_KEY=
MODEL_PROXY_MODEL=GLM-4.5-Air

# Priority 5: Direct OpenAI-compatible API
OPENAI_API_KEY=
DEEPSEEK_API_KEY=
```

At startup each provider is probed; the first healthy one becomes primary. If the primary fails at runtime, requests automatically fall back to the next provider in the chain.

</details>

---

## 16 Tools, 7 Categories

You don't need to load them all. The `profile` parameter decides what loads:

| Category | Tools | minimal | coding | research | full |
|---|---|:---:|:---:|:---:|:---:|
| File | `read_file` `write_file` `edit_file` `list_dir` | | ✅ | | ✅ |
| Search | `search_files` `find_files` | | ✅ | | ✅ |
| Shell | `shell` | | ✅ | | ✅ |
| Web | `web_search` `web_fetch` | | | ✅ | ✅ |
| Code | `run_code` | ✅ | ✅ | | ✅ |
| Image | `generate_image` | | | | ✅ |
| Task | `todo_write` `task_list` | | | ✅ | ✅ |
| Memory | `memory_save` `memory_search` | | | ✅ | ✅ |

Define a Skill with one `defineAction` — it auto-exposes to Agent / HTTP / CLI / MCP / A2A:

```ts
import { defineAction } from "quark-agent";

export const sendEmail = defineAction({
  name: "send_email",
  description: "Send an email to someone",
  parameters: {
    to: { type: "string" },
    subject: { type: "string" },
    body: { type: "string" },
  },
  handler: async ({ to, subject, body }) => {
    // your logic
    return { sent: true };
  },
});
```

---

## One Agent, Seven Entrypoints

Same agent instance — just swap the channel:

```ts
// Terminal
import { CliChannel } from "quark-agent";
new CliChannel({ agent }).start();

// HTTP + SSE streaming
import { HttpChannel } from "quark-agent";
new HttpChannel({ agent, port: 3456 }).start();

// Feishu / WeCom / Telegram / GitHub / Webhook
// all supported, same integration contract
```

---

## Self-Evolution (GEPA)

Hand the agent a set of test cases and let it tune its own prompts and tool-selection policy:

```ts
import { Evolver } from "quark-agent";

const evolver = new Evolver({ agent, evalCases: [...], generations: 10 });
await evolver.evolve();
```

---

## A2A: Agents Talking to Agents

```ts
import { getA2ARegistry } from "quark-agent";

getA2ARegistry().register({
  name: "code-reviewer",
  skills: [{ name: "review", description: "Review pull requests" }],
});

// other agents can now invoke it directly
```

---

## Architecture

```
┌──────────────────────────────────────────┐
│              Channels (7)                │
│  CLI · HTTP · Feishu · WeCom · Tg · GH · Hook
├──────────────────────────────────────────┤
│            Agent Runtime                 │
│  ReAct · Planner · Sub-Agent · Healer   │
├───────┬───────┬───────┬─────────────────┤
│ Tools │ Skills│Provider│    Plugins      │
│  16   │ Store │ Multi  │ A2A·SSE·MCP·Hub │
├───────┴───────┴───────┴─────────────────┤
│          Kernel (<5KB gzip)              │
│      Agent · Context · Runtime · Types   │
└──────────────────────────────────────────┘
```

Pay for what you use: kernel only → add plugins → add extensions → full stack. Your call.

| Layer | Package | Contents |
|---|---|---|
| Kernel | `packages/core` | Agent, Context, Runtime, Types — zero deps |
| Plugins | `packages/plugins` | A2A, SSE, Workspace, defineAction |
| Extensions | `packages/extensions` | Sessions, Healer, Skill scoring |
| Full | `src/` | all tools, channels, providers |

---

## Project Structure

```
quark-agent/
├── src/
│   ├── core/          kernel: Agent, Context, Runtime
│   ├── tools/         16+ built-in tools
│   ├── channel/       7 channels
│   ├── provider/      OpenAI / Anthropic / Gemini / Ollama
│   ├── plugin/        plugin registry + built-in plugins
│   ├── skills/        skill discovery, scoring, persistence
│   ├── evolve/        GEPA self-evolution
│   ├── a2a/           agent-to-agent protocol
│   ├── sync/          EventBus + SSE
│   ├── memory/        SQLite storage + compression
│   └── sandbox/       VM sandbox
├── packages/
│   ├── core/          zero-dep kernel
│   ├── plugins/       official plugins
│   └── extensions/    high-order extensions
└── e2e/               demo + tests + benchmark + UI
```

---

## Testing

```bash
# API integration tests
node e2e/test-tools.mjs

# browser E2E tests (requires Chrome)
node e2e/e2e-browser-test.mjs

# full benchmark suite (200 tasks, ~75 min)
PORT=3465 node e2e/full-eval.mjs --bench all
```

- 13/13 API tests pass
- 12/12 browser E2E tests pass
- 178/200 benchmark tasks pass (**89.0%**)
- All 16 tools verified against a real LLM

---

## What's New in v0.3.0

- **Setup Wizard** — `quark-agent setup` walks you through provider, model, channels, and sandbox policy
- **MoA Intelligent Routing** — task complexity detection (simple/medium/complex) → auto-routes to fast/medium/powerful models
- **Sandbox Security Policy** — shell allowlist/denylist, network/filesystem control, preset policies (strict/balanced/permissive)
- **Tool Authorization** — configurable auto-approve: `all` / `safe` (read-only auto-approved) / `none`
- **Unified Config** — `.quark-agent.json` config file + env vars + CLI flags with priority chain
- **Checkpoint & Long-Running Programming** — state persistence, auto-save, crash recovery, resume from checkpoint
- **Multi-Provider** — OpenAI, Anthropic, Gemini, Ollama, OpenRouter all built-in, zero SDK dependencies

## Roadmap

- [x] 5KB kernel + 16 composable tools
- [x] 7 channels (CLI / HTTP / Feishu / WeCom / Tg / GH / Hook)
- [x] A2A protocol + GEPA self-evolution
- [x] 200-task benchmark suite (AgentBench + GAIA)
- [x] Standalone docs site (GitHub Pages, MkDocs Material)
- [x] `npx quark-agent` one-line installer + setup wizard
- [x] Plugin marketplace (`quark-agent add`)
- [x] MoA intelligent routing + sandbox policy + tool authorization
- [x] Checkpoint & long-running programming support
- [ ] Computer-use tool (screenshot + click + type)
- [ ] Browser-use agent (Puppeteer-driven)
- [ ] npm publish for `npx quark-agent`

---

## Contributing

PRs welcome. Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) first — defining a `defineAction` is one Skill, no heavy ceremony.

See the [open issues](https://github.com/Madapexai/quark-agent/issues) for things to work on, and [discussions](https://github.com/Madapexai/quark-agent/discussions) for ideas and Q&A.

[![Contributors](https://contrib.rocks/image?repo=Madapexai/quark-agent&max=2000)](https://github.com/Madapexai/quark-agent/graphs/contributors)

---

## Community

- 💬 [GitHub Discussions](https://github.com/Madapexai/quark-agent/discussions) — ask questions, share use cases
- 🐛 [Issue Tracker](https://github.com/Madapexai/quark-agent/issues) — bugs and feature requests
- 📚 [Benchmark Report](./e2e/FULL-EVAL-REPORT.md) — full trace-level evaluation
- 🐦 Twitter: [@quark_agent](https://twitter.com/) (coming soon)

If Quark Agent helps you, please consider giving it a ⭐ — it helps others discover the project.

---

## License

[MIT](./LICENSE)

---

<div align="center">

**Small kernel, big composition.**

</div>
