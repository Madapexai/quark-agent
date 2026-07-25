# Quark Agent

> A zero-dependency agentic framework with **22 LLM providers**, **17 channels**, and **multi-agent orchestration**.

[![v1.0.0](https://img.shields.io/badge/release-v1.0.0-blue?style=flat-square)](https://github.com/Madapexai/quark-agent/releases/tag/v1.0.0)
[![Benchmark](https://img.shields.io/badge/Benchmark-89.0%25-brightgreen?style=flat-square)](./benchmark/index.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](https://github.com/Madapexai/quark-agent/blob/master/LICENSE)

Like quarks compose into protons, compose the agent you need from the smallest possible kernel.

---

## Why Quark Agent

**Not another all-in-one framework.** The kernel is `<5KB gzipped`, zero npm runtime dependencies, and everything - tools, channels, models, extensions - is plug-and-play.

| | Quark Agent | AstrBot | Claude Code | Codex CLI |
|---|:---:|:---:|:---:|:---:|
| Runtime dependencies | **0** | 20+ | - | - |
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
| A2A Protocol | ✅ | ❌ | - | - |
| Kernel size | **<5KB** | - | - | - |

---

## Quick Numbers

| Metric | Value |
|--------|------:|
| LLM Providers | 22 |
| Models | 49 |
| IM Channels | 17 |
| Built-in Tools | 20+ |
| Benchmark Pass Rate | 89.0% |
| Runtime Dependencies | 0 |
| Kernel Size | <5KB |

---

## Benchmark

Evaluated on **AgentBench (THUDM)** and **GAIA (Meta/HF)** - 200 tasks, real LLM, real tool calls. See [Benchmark](./benchmark/index.md).

| Benchmark | Pass Rate |
|-----------|----------:|
| GAIA (Meta/HF) | **93.0%** |
| AgentBench (THUDM) | **85.0%** |
| Overall | **89.0%** |

---

## 30-Second Quick Start

```bash
# Zero install - run directly from GitHub
npx github:Madapexai/quark-agent setup   # Interactive setup wizard
npx github:Madapexai/quark-agent chat    # Start chatting!

# Or clone and run locally
git clone https://github.com/Madapexai/quark-agent.git
cd quark-agent && npm install
npx tsx bin/cli.ts setup                 # Setup wizard
npx tsx bin/cli.ts dashboard             # WebUI dashboard
```

See [Quick Start](./quickstart.md) for detailed instructions.

---

## What's New in v1.0.0

The v1.0.0 release brings **AstrBot feature parity** with 23 new capabilities across P1/P2/P3 priorities.

### P1 - Critical

- **[MCP Protocol](./features/mcp.md)** - Model Context Protocol server (stdio/SSE) + client registry
- **[OpenAI Compatible API](./features/openai-api.md)** - `/v1/chat/completions` with SSE streaming
- **[Multimodal Input](./features/multimodal.md)** - Image/file upload, drag & drop, vision format
- **[Computer Use](./features/computer-use.md)** - Screenshot, click, type, CDP browser control
- **[Function Calling](./features/function-calling.md)** - Standardized OpenAI function calling
- **CDP Native WebSocket** - Replaced curl with persistent WebSocket
- **Streaming Output** - Token-by-token display, tool progress bar
- **Security Hardening** - PBKDF2+salt, JWT, CORS, rate limiting, security headers

### P2 - Medium

- **[RAG / Knowledge Base](./features/rag.md)** - Document chunking, TF-IDF, cosine search
- **[Voice STT/TTS](./features/voice.md)** - OpenAI Whisper + edge-tts
- **[Cron Scheduler](./features/scheduler.md)** - 5-field cron, task CRUD
- **[Workflow DAG Engine](./features/workflow.md)** - 7 node types, conditional branching
- **[Plugin Hot Reload](./features/hot-reload.md)** - fs.watch with debounce

### P3 - Low

- **Electron Desktop** - main.cjs + preload.cjs
- **Capacitor Mobile** - iOS/Android config
- **Rust Roadmap** - 6-phase plan for 10-50x performance

See [What's New](./changelog.md) for the full changelog.

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

## Next Steps

- [Quick Start](./quickstart.md) - Get running in 30 seconds
- [What's New](./changelog.md) - Full v1.0.0 changelog
- [Features](./features/mcp.md) - Explore each capability
- [22 Providers](./reference/providers.md) - All LLM providers
- [17 Channels](./reference/channels.md) - All IM channels
- [API Endpoints](./reference/api-endpoints.md) - Full REST API reference
- [Benchmark](./benchmark/index.md) - 89% pass rate on 200 tasks
