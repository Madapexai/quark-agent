<div align="center">

# Quark Agent

**A zero-dependency agentic framework with 22 LLM providers, 17 channels, and multi-agent orchestration.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178c6?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](./LICENSE)
[![npm](https://img.shields.io/badge/npm-quark--agent-cb3837?style=flat-square&logo=npm)](https://www.npmjs.com/)
[![Pass Rate](https://img.shields.io/badge/Benchmark-89.0%25-brightgreen?style=flat-square)](./e2e/FULL-EVAL-REPORT.md)
[![GitHub stars](https://img.shields.io/github/stars/Madapexai/quark-agent?style=flat-square)](https://github.com/Madapexai/quark-agent/stargazers)
[![v1.0.0](https://img.shields.io/badge/release-v1.0.0-blue?style=flat-square)](https://github.com/Madapexai/quark-agent/releases/tag/v1.0.0)

**Like quarks compose into protons, compose the agent you need from the smallest possible kernel.**

[English](./README.md) · [简体中文](./README.zh-CN.md)

</div>

---

## Why Quark Agent

| | Quark Agent | AstrBot | Claude Code | Codex CLI |
|---|:---:|:---:|:---:|:---:|
| Runtime dependencies | **0** | 20+ | — | — |
| LLM Providers | **22** | ~6 | 1 | 1 |
| IM Channels | **17** | ~6 | CLI | CLI |
| Multi-Agent (MoA/Orchestrator) | ✅ | ❌ | ❌ | ❌ |
| Computer Use | ✅ | ❌ | ✅ | ❌ |
| Self-Evolution | ✅ | ❌ | ❌ | ❌ |
| OpenAI Compatible API | ✅ | ❌ | ❌ | ❌ |
| RAG / Knowledge Base | ✅ | ✅ | ❌ | ❌ |
| MCP Protocol | ✅ | ✅ | ✅ | ❌ |
| Workflow DAG Engine | ✅ | ❌ | ❌ | ❌ |
| Voice STT/TTS | ✅ | ✅ | ❌ | ❌ |
| Cron Scheduler | ✅ | ✅ | ❌ | ❌ |
| Multimodal (image/file) | ✅ | ✅ | ✅ | ❌ |
| Desktop (Electron) | ✅ | ❌ | ✅ | ❌ |
| A2A Protocol | ✅ | ❌ | — | — |
| Kernel size | **<5KB** | — | — | — |

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

> **You need to bring your own LLM API key.** Quark Agent is model-agnostic but does not ship with a built-in model. See [Get a Free API Key](#-get-a-free-api-key) below.

### CLI Commands

```bash
quark-agent setup            # Interactive setup wizard
quark-agent chat             # Interactive chat (default)
quark-agent ask "question"   # One-shot Q&A
quark-agent serve --port     # HTTP + SSE server
quark-agent dashboard        # WebUI dashboard (port 8788)
quark-agent add <package>    # Install plugin from npm/Git
quark-agent list             # List installed plugins
quark-agent evolve           # Run prompt self-evolution
```

---

## 22 LLM Providers, 49 Models

Every provider uses real API endpoints — no stubs. Zero SDK dependencies (all HTTP via Node `fetch`).

| # | Provider | Free Tier | Default Model |
|---|----------|:---------:|---------------|
| 1 | ZhipuAI (GLM) | ✅ | glm-4-flash |
| 2 | Agnes AI | ✅ | agnes-2.0-flash |
| 3 | DeepSeek | — | deepseek-chat |
| 4 | Volcengine Ark | — | doubao-seed-code |
| 5 | Moonshot | — | moonshot-v1 |
| 6 | Qwen (Tongyi) | — | qwen-turbo |
| 7 | MiniMax | — | abab6.5s-chat |
| 8 | Baichuan | — | baichuan2-turbo |
| 9 | Yi (01.AI) | — | yi-lightning |
| 10 | StepFun | — | step-1-8k |
| 11 | SiliconFlow | — | Qwen/Qwen2.5-7B-Instruct |
| 12 | OpenAI | — | gpt-4o |
| 13 | Anthropic | — | claude-sonnet-4-20250514 |
| 14 | Gemini | — | gemini-2.0-flash |
| 15 | OpenRouter | — | auto |
| 16 | Together | — | meta-llama/Llama-3 |
| 17 | Groq | — | llama-3.1-8b-instant |
| 18 | Fireworks | — | llama-v3p1-70b-instruct |
| 19 | Mistral | — | mistral-large-latest |
| 20 | Ollama (local) | ✅ | llama3.2 |
| 21 | LM Studio (local) | ✅ | — |
| 22 | vLLM (local) | ✅ | — |

### 🔑 Get a Free API Key

| Provider | Cost | Where to get |
|---|---|---|
| **GLM / ZhipuAI** | Free | https://open.bigmodel.cn/ |
| **Agnes AI** | Free ($0/1M tokens) | https://wiki.agnes-ai.com/ |
| **Ollama** (local) | Free | https://ollama.ai/ |

---

## 17 Channels

Same agent — just swap the channel. All channels have real API implementations (no stubs).

| # | Channel | Protocol | Auth |
|---|---------|----------|------|
| 1 | **CLI** | stdin/stdout | — |
| 2 | **HTTP + SSE** | REST + streaming | JWT |
| 3 | **Discord** | Gateway WebSocket | Bot token |
| 4 | **Slack** | Events API | Bot token + signing secret |
| 5 | **Telegram** | Bot API (polling) | Bot token |
| 6 | **Feishu (Lark)** | Event subscription | App ID + secret |
| 7 | **WeChat** | HTTP callback | Token + encoding AES key |
| 8 | **WhatsApp** | Cloud API webhook | Verify token + app secret |
| 9 | **Signal** | signal-cli-rest-api | Phone number |
| 10 | **Email** | IMAP + SMTP (self-built) | User/pass (TLS) |
| 11 | **SMS (Twilio)** | Webhook + REST | Account SID + auth token |
| 12 | **Matrix** | Client-Server API (/sync) | Access token |
| 13 | **Mattermost** | REST + WebSocket | Access token |
| 14 | **DingTalk** | Outgoing webhook | Sign secret |
| 15 | **WeCom (Enterprise WeChat)** | Callback + AES decrypt | Corp ID + secret + encoding key |
| 16 | **Relay** | Cross-channel routing | Config-based |
| 17 | **WebUI Dashboard** | HTTP + SSE | JWT login |

```ts
// Terminal
import { CliChannel } from "quark-agent";
new CliChannel({ agent }).start();

// HTTP + SSE streaming
import { HttpChannel } from "quark-agent";
new HttpChannel({ agent, port: 3456 }).start();

// WhatsApp, Signal, Matrix, DingTalk, WeCom...
// All supported, same integration contract
```

---

## Multi-Agent Orchestration

Three collaboration patterns for teams of agents:

```ts
import { AgentTeam } from "quark-agent";

// 1. Sequential Pipeline — agents run in order
const team = new AgentTeam(workers, { mode: "sequential" });

// 2. Mixture of Agents (MoA) — parallel workers + aggregator
const team = new AgentTeam(workers, { mode: "moa", aggregator });

// 3. Orchestrator-Worker — main agent dispatches tasks
const team = new AgentTeam(workers, { mode: "orchestrator", orchestrator });

// Both sync and streaming execution
const result = await team.run("Analyze this codebase");
for await (const event of team.stream("Analyze this codebase")) {
  console.log(event);
}
```

---

## MCP Protocol

Full Model Context Protocol support — both as server and client:

```ts
// Expose tools as an MCP server (stdio or SSE)
import { createQuarkMCPServer } from "quark-agent";
const mcp = await createQuarkMCPServer();
await mcp.runStdio();        // stdio transport
mcp.runSSE(3000);            // SSE transport

// Connect to external MCP servers
import { MCPRegistry } from "quark-agent";
const registry = new MCPRegistry();
await registry.connect({ name: "filesystem", command: "npx", args: ["@modelcontextprotocol/server-filesystem", "/tmp"] });
const tools = registry.listAllTools();
```

---

## RAG / Knowledge Base

Document upload, chunking, vectorization, and retrieval-augmented generation:

```ts
import { knowledgeBase } from "quark-agent";

// Add documents
await knowledgeBase.addDocument("guide.md", "# How to use...\n...");

// Search
const results = await knowledgeBase.search("how to deploy", 5);

// Get context for LLM prompt
const context = await knowledgeBase.getContext("deployment instructions", 2000);
```

**API Endpoints**: `POST /api/kb/documents` · `POST /api/kb/search` · `GET /api/kb/documents`

---

## OpenAI Compatible API

Drop-in replacement for OpenAI's chat completions — use any tool that expects the OpenAI API:

```bash
# List models
curl http://localhost:8788/v1/models

# Chat completion (non-streaming)
curl -X POST http://localhost:8788/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"quark-agent","messages":[{"role":"user","content":"hello"}]}'

# Chat completion (SSE streaming)
curl -X POST http://localhost:8788/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"quark-agent","messages":[{"role":"user","content":"hello"}],"stream":true}'
```

Works with any OpenAI SDK — just change the `baseURL`:

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8788/v1", api_key="any")
response = client.chat.completions.create(model="quark-agent", messages=[...])
```

---

## Function Calling

Standardized OpenAI function calling format:

```ts
import { toolsToOpenAIFormat, executeToolCalls } from "quark-agent";

// Convert quark-agent tools to OpenAI format
const openaiTools = toolsToOpenAIFormat(myTools);

// Execute tool calls from LLM response
const results = await executeToolCalls(toolCalls, toolMap);
```

---

## Computer Use

Screenshot, click, type, drag, scroll, window management, and Chrome DevTools Protocol control:

```ts
import { ComputerService } from "quark-agent";
const computer = new ComputerService();

await computer.screenshot();                    // Take screenshot
await computer.click(100, 200);                 // Click at coordinates
await computer.type("Hello world");             // Type text
await computer.launchApp("Safari");             // Launch application
await computer.listWindows();                   // List windows
// CDP browser control
await computer.cdpNavigate("https://example.com");
await computer.cdpEvaluate("document.title");
```

Native WebSocket CDP connection — no curl dependency.

---

## Workflow DAG Engine

Visual workflow orchestration with 7 node types:

```ts
import { workflowEngine } from "quark-agent";

const wf = workflowEngine.createWorkflow("data-pipeline", "Process and summarize data");

// Add nodes
workflowEngine.addNode(wf.id, { type: "input", name: "raw_data", config: {}, position: { x: 0, y: 0 } });
workflowEngine.addNode(wf.id, { type: "llm", name: "summarize", config: { prompt: "Summarize: ${raw_data}" }, position: { x: 200, y: 0 } });
workflowEngine.addNode(wf.id, { type: "output", name: "result", config: { outputFormat: "markdown" }, position: { x: 400, y: 0 } });

// Connect nodes
workflowEngine.addEdge(wf.id, { from: "raw_data_node_id", to: "summarize_node_id" });
workflowEngine.addEdge(wf.id, { from: "summarize_node_id", to: "result_node_id" });

// Execute
const result = await workflowEngine.run(wf.id, "Some input data");
```

**Node types**: `input` · `llm` · `tool` · `condition` · `code` · `delay` · `output`

---

## Voice (STT/TTS)

Speech-to-text and text-to-speech with multiple providers:

```ts
import { voiceManager } from "quark-agent";

// List available voices
voiceManager.listVoices();  // 10 preset voices

// Speech-to-text
voiceManager.setSTTProvider("openai", apiKey);
const result = await voiceManager.transcribe(audioBuffer, "wav");

// Text-to-speech
voiceManager.setTTSProvider("edge-tts");
const tts = await voiceManager.synthesize("Hello world", { voice: "zh-CN-XiaoxiaoNeural" });
```

Providers: **OpenAI Whisper** (STT) · **Local whisper CLI** (STT) · **OpenAI TTS-1** (TTS) · **Edge TTS** (TTS) · **Web Speech API** (browser fallback)

---

## Cron Scheduler

Schedule recurring tasks with standard cron expressions:

```ts
import { scheduler } from "quark-agent";

scheduler.setRunner(async (prompt) => {
  const result = await agent.run(prompt);
  return result.reply;
});

scheduler.addTask("morning-brief", "0 9 * * 1-5", "Summarize today's schedule");
scheduler.addTask("weekly-report", "0 17 * * 5", "Generate weekly progress report");

scheduler.start();  // Checks every 60 seconds
```

**API Endpoints**: `GET/POST /api/scheduler/tasks` · `PUT/DELETE /api/scheduler/tasks/:id` · `POST /api/scheduler/run/:id`

---

## Multimodal Input

Upload images, files, and audio — automatically converted to LLM vision format:

```ts
import { multimodalManager } from "quark-agent";

// Save uploaded file
const attachment = multimodalManager.saveAttachment("photo.png", "image/png", buffer);

// Convert to OpenAI vision format
const content = multimodalManager.toOpenAIContent("What's in this image?", [attachment]);
// → [{ type: "text", text: "..." }, { type: "image_url", image_url: { url: "data:image/png;base64,..." } }]

// Convert to Anthropic format
const anthropicContent = multimodalManager.toAnthropicContent("What's in this image?", [attachment]);
```

**Upload**: `POST /api/upload` (multipart or base64 JSON) · WebUI: drag & drop / paste / click 📎

---

## Self-Evolution (GEPA)

Hand the agent test cases and let it tune its own prompts and tool-selection policy:

```ts
import { Evolver } from "quark-agent";
const evolver = new Evolver({ agent, evalCases: [...], generations: 10 });
await evolver.evolve();
```

The **Dreaming Engine** watches for failures, identifies root causes (timeout/permission/ENOENT/syntax/rate-limit), and autonomously creates skills, modifies prompts, or adjusts sandbox rules.

---

## Plugin Hot Reload

Plugins are watched for changes and auto-reloaded without restart:

```ts
import { PluginHotReloader } from "quark-agent";
const reloader = new PluginHotReloader(".quark-plugins");
reloader.on("reload", (event) => console.log(`${event.type}: ${event.pluginName}`));
reloader.start();
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Desktop (Electron)                     │
├──────────────────────────────────────────────────────────┤
│              WebUI Dashboard (HTML/CSS/JS)                │
├──────────────────────────────────────────────────────────┤
│           Dashboard Server (HTTP + SSE + Auth)            │
├──────────────────────────────────────────────────────────┤
│             Core Agent Runtime (TypeScript)               │
│  ReAct · Planner · Sub-Agent · Healer · MoA · Orchestrator│
├────────┬──────────┬──────────┬──────────┬────────────────┤
│Channels│  Tools   │  Skills  │ Provider │   Extensions    │
│  17    │  20+     │  Store   │  22/49   │ MCP·RAG·Voice   │
│        │ Computer │ HotLoad  │          │ Workflow·Cron    │
│        │ Multimod │ Evolve   │          │ OpenAI API·A2A   │
├────────┴──────────┴──────────┴──────────┴────────────────┤
│                    Kernel (<5KB gzip)                      │
│            Agent · Context · Runtime · Types               │
└──────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
quark-agent/
├── src/
│   ├── core/          Kernel: Agent, Context, Runtime, Types
│   ├── tools/         20+ built-in tools + Computer Use + Function Calling
│   ├── channel/       17 channels (Discord, Slack, WhatsApp, Signal...)
│   ├── provider/      22 providers / 49 models
│   ├── mcp/           MCP server + client registry
│   ├── rag/           Knowledge base + RAG
│   ├── voice/         STT/TTS
│   ├── scheduler/     Cron task scheduler
│   ├── workflow/      DAG workflow engine
│   ├── multimodal/    Image/file upload + vision format conversion
│   ├── api/           OpenAI compatible API
│   ├── skills/        Skill discovery, scoring, persistence, hot reload
│   ├── team/          Multi-agent orchestration (MoA/Sequential/Orchestrator)
│   ├── chatroom/      Chat rooms with agent team integration
│   ├── dreaming/      Self-evolution engine
│   ├── a2a/           Agent-to-agent protocol
│   ├── observe/       Langfuse + LogViewer
│   ├── env/           .env management
│   ├── config/        Model manager + hot switching
│   ├── auth/          JWT auth + PBKDF2 + rate limiting
│   ├── sandbox/       VM sandbox
│   ├── sync/          EventBus + SSE
│   ├── memory/        SQLite storage + compression
│   └── dashboard/     WebUI + server
├── desktop/           Electron wrapper (main.cjs + preload.cjs)
├── mobile/            Capacitor config (iOS/Android)
├── docs/              Documentation + Rust Roadmap
├── packages/          Zero-dep kernel + plugins + extensions
└── e2e/               Demo + tests + benchmark
```

---

## API Endpoints

### Core
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | JWT login |
| POST | `/api/auth/register` | Create account |
| GET/POST | `/api/sessions` | Chat sessions |
| POST | `/api/sessions/:id/chat` | Chat (SSE streaming) |
| GET/PUT | `/api/config` | Agent configuration |

### OpenAI Compatible
| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/models` | List models |
| POST | `/v1/chat/completions` | Chat (SSE streaming supported) |
| POST | `/v1/embeddings` | Embeddings (placeholder) |

### MCP
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/mcp/tools` | List tools |
| GET | `/api/mcp/servers` | List connected servers |
| POST | `/api/mcp/connect` | Connect to MCP server |
| POST | `/api/mcp/disconnect` | Disconnect from server |

### Knowledge Base
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/kb/documents` | List documents |
| POST | `/api/kb/documents` | Add document |
| DELETE | `/api/kb/documents/:id` | Delete document |
| POST | `/api/kb/search` | Search (RAG) |
| DELETE | `/api/kb/clear` | Clear all |

### Scheduler
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/scheduler/tasks` | List tasks |
| POST | `/api/scheduler/tasks` | Create task |
| PUT | `/api/scheduler/tasks/:id` | Update task |
| DELETE | `/api/scheduler/tasks/:id` | Delete task |
| POST | `/api/scheduler/run/:id` | Trigger manually |
| GET | `/api/scheduler/history` | Run history |

### Workflow
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/workflows` | List workflows |
| POST | `/api/workflows` | Create workflow |
| GET/PUT/DELETE | `/api/workflows/:id` | CRUD |
| POST | `/api/workflows/:id/run` | Execute workflow |
| POST | `/api/workflows/:id/nodes` | Add node |

### Voice & Upload
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/voices` | List voices |
| POST | `/api/voice/stt` | Speech-to-text |
| POST | `/api/voice/tts` | Text-to-speech |
| POST | `/api/upload` | Upload file/image |

---

## Benchmark

Evaluated on **AgentBench (THUDM)** and **GAIA (Meta/HF)** — 200 tasks total, real LLM, real tool calls. Full report: [`e2e/FULL-EVAL-REPORT.md`](./e2e/FULL-EVAL-REPORT.md).

| Benchmark | Total | Pass | Fail | Error | Pass Rate |
|-----------|------:|----:|----:|------:|----------:|
| GAIA (Meta/HF) | 100 | 93 | 7 | 0 | **93.0%** |
| AgentBench (THUDM) | 100 | 85 | 9 | 6 | **85.0%** |
| **Overall** | **200** | **178** | **16** | **6** | **89.0%** |

---

## What's New in v1.0.0

### P1 — Critical
- **MCP Protocol**: Server (stdio/SSE) + Client Registry — connect external MCP servers
- **CDP Native WebSocket**: Replace curl with persistent WebSocket, fix screenshot dimensions
- **Multimodal Input**: Image/file upload, drag & paste, OpenAI/Anthropic vision format
- **Streaming Output**: Fix SSE parsing, token-by-token display, tool progress bar
- **OpenAI Compatible API**: `/v1/chat/completions` (SSE streaming) + Function Calling standardization
- **Security Hardening**: PBKDF2+salt, random admin password, JWT persistence, CORS lockdown, rate limiting, security headers

### P2 — Medium
- **Knowledge Base / RAG**: Document chunking, TF-IDF embedding, cosine search
- **Voice STT/TTS**: OpenAI Whisper + local whisper + edge-tts
- **Cron Scheduler**: 5-field cron parser, task CRUD, run history
- **Workflow DAG Engine**: 7 node types, conditional branching
- **Plugin Hot Reload**: fs.watch with debounce

### P3 — Low
- **Electron Desktop**: main.cjs + preload.cjs
- **Capacitor Mobile**: iOS/Android config
- **Rust Roadmap**: 6-phase upgrade plan (10-50x perf target)

---

## Roadmap

- [x] 5KB kernel + composable tools
- [x] 17 channels (CLI/HTTP/Discord/Slack/Telegram/Feishu/WeChat/WhatsApp/Signal/Email/SMS/Matrix/Mattermost/DingTalk/WeCom/Relay/WebUI)
- [x] 22 LLM providers / 49 models
- [x] Multi-agent orchestration (MoA/Sequential/Orchestrator)
- [x] Computer Use (screenshot/click/type/CDP)
- [x] MCP protocol (server + client)
- [x] OpenAI compatible API
- [x] RAG / Knowledge Base
- [x] Workflow DAG engine
- [x] Voice STT/TTS
- [x] Cron scheduler
- [x] Multimodal input (image/file upload)
- [x] Self-evolution (GEPA + Dreaming Engine)
- [x] Plugin marketplace + hot reload
- [x] Desktop (Electron) + Mobile (Capacitor)
- [x] Security hardening (PBKDF2/JWT/CORS/rate-limit/security headers)
- [ ] Rust native modules (see [docs/RUST_ROADMAP.md](./docs/RUST_ROADMAP.md))
- [ ] npm publish for `npx quark-agent`
- [ ] Fine-grained RBAC permissions
- [ ] Distributed multi-node deployment

---

## Contributing

PRs welcome. Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) first — defining a `defineAction` is one Skill, no heavy ceremony.

See the [open issues](https://github.com/Madapexai/quark-agent/issues) for things to work on, and [discussions](https://github.com/Madapexai/quark-agent/discussions) for ideas and Q&A.

[![Contributors](https://contrib.rocks/image?repo=Madapexai/quark-agent&max=2000)](https://github.com/Madapexai/quark-agent/graphs/contributors)

---

## Community

- [GitHub Discussions](https://github.com/Madapexai/quark-agent/discussions) — ask questions, share use cases
- [Issue Tracker](https://github.com/Madapexai/quark-agent/issues) — bugs and feature requests
- [Benchmark Report](./e2e/FULL-EVAL-REPORT.md) — full trace-level evaluation
- [Rust Roadmap](./docs/RUST_ROADMAP.md) — performance upgrade plan

If Quark Agent helps you, please consider giving it a star — it helps others discover the project.

---

## License

[MIT](./LICENSE)

---

<div align="center">

**Small kernel, big composition.**

</div>
