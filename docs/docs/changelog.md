# What's New in v1.0.0

> From 0.3.0 to 1.0.0 - 23 new capabilities, AstrBot feature parity achieved.

Released: 2025-07-19 · [Full Release Notes](https://github.com/Madapexai/quark-agent/releases/tag/v1.0.0)

---

## P0 - Critical Security (8 items)

| # | Fix | Description |
|---|-----|-------------|
| 1 | `npm start` fix | `run-cli.js` -> `run-cli.cjs` |
| 2 | Session title undefined | `s.title` -> `s.name` |
| 3 | Rename session API | Frontend sends `{ name }` |
| 4 | Markdown XSS | `esc()` escaping + href whitelist |
| 5 | Hardcoded admin/admin | Random password + change-password API |
| 6 | SHA-256 without salt | PBKDF2 + 16-byte random salt |
| 7 | JWT secret lost on restart | Config file persistence |
| 8 | `/api/config` no auth | Added to `isProtectedPath` |

## P1 - High Priority (11 items)

### Security Hardening

| # | Fix | Description |
|---|-----|-------------|
| H1 | Timer leak fix | `clearInterval` + `destroy()` in `stop()` |
| H2 | Global exception handler | LogViewer convenience methods + global handler |
| H3 | SSE disconnect handling | `req.on("close")` + cancelled flag |
| H4 | Agent race condition | Promise lock pattern |
| H5 | CORS restriction | Limited to localhost / 127.0.0.1 |
| H6 | Login rate limiting | IP-level 10 attempts/minute |

### New Features

#### MCP Protocol

Full Model Context Protocol support - both as server and client.

- **Server**: Expose tools via JSON-RPC 2.0 over stdio or SSE
- **Client**: Connect to external MCP servers, aggregate tools
- **API**: `GET /api/mcp/tools` · `POST /api/mcp/connect`

See [MCP Protocol](./features/mcp.md) for details.

#### CDP Native WebSocket

Replaced curl subprocess with native WebSocket for Chrome DevTools Protocol:

- Persistent connection caching
- Fixed `browserScreenshot()` returning 0x0 dimensions
- 10x faster CDP commands

#### Multimodal Input

Image and file upload with automatic LLM vision format conversion:

- Multipart form-data and base64 JSON upload
- Drag & drop, paste, and click upload
- OpenAI vision format (`image_url`)
- Anthropic format (`source.base64`)

See [Multimodal Input](./features/multimodal.md) for details.

#### Streaming Output Optimization

Fixed SSE parsing and enhanced the chat UI:

- Fixed buffer truncation bug in SSE parsing
- Token-by-token incremental display
- Tool execution progress bar
- Typing indicator animation
- Smooth scroll with `requestAnimationFrame`

#### OpenAI Compatible API

Drop-in replacement for OpenAI's chat completions:

- `GET /v1/models` - List models
- `POST /v1/chat/completions` - Chat (SSE streaming supported)
- `POST /v1/embeddings` - Embeddings (placeholder)

Works with any OpenAI SDK - just change `baseURL`.

See [OpenAI Compatible API](./features/openai-api.md) for details.

#### Function Calling Standardization

Standardized OpenAI function calling format:

- `toolsToOpenAIFormat(tools)` - Convert to OpenAI tool format
- `executeToolCalls(calls, tools)` - Execute and collect results
- `formatToolResults(results)` - Format as OpenAI tool messages

See [Function Calling](./features/function-calling.md) for details.

## P2 - Medium Priority (9 items)

### Security & Infrastructure

| # | Fix | Description |
|---|-----|-------------|
| M1 | CORS preflight | Added PUT method |
| M2 | Request body limit | 10MB max |
| M3 | Config field whitelist | Validate allowed fields only |
| M4 | Flush on stop | `sessionStore.flush()` in `stop()` |
| M5 | Chat length limit | 32,000 character max |
| M6 | Logger replacement | All `console` -> `logger` |
| M7 | Security headers | X-Content-Type-Options, X-Frame-Options, X-XSS-Protection |
| M8 | .gitignore | Added sensitive files |
| M9 | Token blacklist + cache clear | TeamFactory `resetAgent()` |

### New Features

#### Knowledge Base / RAG

Document upload, chunking, vectorization, and retrieval-augmented generation:

- Text chunking with overlap (500 chars, 50 overlap)
- TF-IDF hash-based embedding (256-dim, L2 normalized)
- Cosine similarity search
- LLM context injection (`getContext()`)

See [RAG / Knowledge Base](./features/rag.md) for details.

#### Voice STT/TTS

Speech-to-text and text-to-speech:

- **STT**: OpenAI Whisper API, local whisper CLI, browser fallback
- **TTS**: OpenAI TTS-1, edge-tts, browser fallback
- 10 preset voices (English + Chinese + Japanese)

See [Voice STT/TTS](./features/voice.md) for details.

#### Cron Scheduler

Schedule recurring tasks with standard cron expressions:

- 5-field cron parser (minute hour day month weekday)
- Task CRUD + enable/disable
- Run history (last 100 runs)
- Auto-start with agent runner injection

See [Cron Scheduler](./features/scheduler.md) for details.

#### Workflow DAG Engine

Visual workflow orchestration:

- 7 node types: `input` · `llm` · `tool` · `condition` · `code` · `delay` · `output`
- Conditional branching (`trueBranch` / `falseBranch`)
- Cycle detection (visited set)
- LLM and tool runner injection

See [Workflow DAG Engine](./features/workflow.md) for details.

#### Plugin Hot Reload

Automatic plugin reloading without restart:

- `fs.watch` with recursive monitoring
- 500ms debounce to avoid duplicate events
- `added` / `changed` / `removed` event types

See [Plugin Hot Reload](./features/hot-reload.md) for details.

## P3 - Low Priority (5 items)

### Frontend Fixes

| # | Fix | Description |
|---|-----|-------------|
| L1 | Empty catch blocks | Added `console.error` to 57 catch blocks |
| L2 | showLogin reset | Clear form on show + checkAuth dedup |
| L3 | i18n + CSS | Hardcoded English + missing CSS classes |

### Desktop & Mobile

#### Electron Desktop

- `desktop/main.cjs` - Electron main process
- `desktop/preload.cjs` - Context bridge
- Auto-starts dashboard server, loads WebUI in BrowserWindow

#### Capacitor Mobile

- `mobile/capacitor.config.json` - iOS/Android config
- Points to local dashboard server

### Rust Roadmap

6-phase performance upgrade plan targeting 10-50x improvements:

| Phase | Week | Focus | Expected Gain |
|-------|------|-------|---------------|
| R1 | 1 | NAPI-RS infrastructure | - |
| R2 | 2 | Crypto (PBKDF2/JWT/AES) | 50x hashing |
| R3 | 3 | RAG vectorization | 50x search |
| R4 | 4 | Channel protocols (IMAP/WS) | - |
| R5 | 5 | Computer Use (CDP/OCR) | 4x screenshot |
| R6 | 6 | Workflow + JSON parsing | 10x JSON |

See [Rust Roadmap](./community/rust-roadmap.md) for details.

---

## Comparison with AstrBot

| Feature | AstrBot | Quark Agent v1.0.0 |
|---------|---------|-------------------|
| Language | Python | TypeScript |
| LLM Providers | ~6 | **22** |
| IM Channels | ~6 | **17** |
| Multi-agent | No | **Yes** (MoA/Sequential/Orchestrator) |
| Computer Use | No | **Yes** |
| Self-evolution | No | **Yes** |
| OpenAI API | No | **Yes** |
| Workflow DAG | No | **Yes** |
| MCP Protocol | Yes | Yes |
| RAG | Yes | Yes |
| Voice | Yes | Yes |
| Scheduler | Yes | Yes |
| Multimodal | Yes | Yes |
| Hot reload | Yes | Yes |
| Desktop | No | **Yes** (Electron) |
| npm dependencies | 20+ | **0** |

---

## Full Changelog

- `c5da54e` feat: AstrBot parity - MCP, RAG, OpenAI API, multimodal, voice, scheduler, workflow, CDP native WS
- `590b62d` chore: bump version to 1.0.0
- `07bf2ee` docs: update README for v1.0.0

[Compare v0.3.0...v1.0.0](https://github.com/Madapexai/quark-agent/compare/v0.3.0...v1.0.0)
