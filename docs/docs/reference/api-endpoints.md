# API Endpoints

Full REST API reference for the Quark Agent dashboard server.

## Authentication

All protected endpoints require a JWT token obtained via login:

```bash
# Login
curl -X POST http://localhost:8788/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"your_password"}'
# -> {"token":"eyJ...","user":{...}}

# Use token
curl -H "Authorization: Bearer eyJ..." http://localhost:8788/api/sessions
```

## Core

| Method | Path | Auth | Description |
|--------|------|:----:|-------------|
| POST | `/api/auth/login` | - | JWT login |
| POST | `/api/auth/register` | - | Create account |
| POST | `/api/auth/change-password` | ✅ | Change password |
| GET | `/api/sessions` | ✅ | List chat sessions |
| POST | `/api/sessions` | ✅ | Create session |
| DELETE | `/api/sessions/:id` | ✅ | Delete session |
| POST | `/api/sessions/:id/chat` | ✅ | Chat (SSE streaming) |
| PUT | `/api/sessions/:id/rename` | ✅ | Rename session |
| GET/PUT | `/api/config` | ✅ | Agent configuration |
| GET | `/api/health` | - | Health check |

## OpenAI Compatible

| Method | Path | Auth | Description |
|--------|------|:----:|-------------|
| GET | `/v1/models` | - | List models |
| POST | `/v1/chat/completions` | - | Chat (SSE streaming) |
| POST | `/v1/embeddings` | - | Embeddings |

## MCP

| Method | Path | Auth | Description |
|--------|------|:----:|-------------|
| GET | `/api/mcp/tools` | ✅ | List tools |
| GET | `/api/mcp/servers` | ✅ | List servers |
| POST | `/api/mcp/connect` | ✅ | Connect to server |
| POST | `/api/mcp/disconnect` | ✅ | Disconnect |

## Knowledge Base

| Method | Path | Auth | Description |
|--------|------|:----:|-------------|
| GET | `/api/kb/documents` | ✅ | List documents |
| POST | `/api/kb/documents` | ✅ | Add document |
| DELETE | `/api/kb/documents/:id` | ✅ | Delete document |
| POST | `/api/kb/search` | ✅ | Search (RAG) |
| DELETE | `/api/kb/clear` | ✅ | Clear all |

## Scheduler

| Method | Path | Auth | Description |
|--------|------|:----:|-------------|
| GET | `/api/scheduler/tasks` | ✅ | List tasks |
| POST | `/api/scheduler/tasks` | ✅ | Create task |
| PUT | `/api/scheduler/tasks/:id` | ✅ | Update |
| DELETE | `/api/scheduler/tasks/:id` | ✅ | Delete |
| POST | `/api/scheduler/run/:id` | ✅ | Trigger now |
| GET | `/api/scheduler/history` | ✅ | Run history |

## Workflow

| Method | Path | Auth | Description |
|--------|------|:----:|-------------|
| GET | `/api/workflows` | ✅ | List workflows |
| POST | `/api/workflows` | ✅ | Create workflow |
| GET | `/api/workflows/:id` | ✅ | Get workflow |
| PUT | `/api/workflows/:id` | ✅ | Update |
| DELETE | `/api/workflows/:id` | ✅ | Delete |
| POST | `/api/workflows/:id/run` | ✅ | Execute |
| POST | `/api/workflows/:id/nodes` | ✅ | Add node |

## Voice & Upload

| Method | Path | Auth | Description |
|--------|------|:----:|-------------|
| GET | `/api/voices` | - | List voices |
| POST | `/api/voice/stt` | ✅ | Speech-to-text |
| POST | `/api/voice/tts` | ✅ | Text-to-speech |
| POST | `/api/upload` | ✅ | Upload file |
| GET | `/api/uploads/:id` | ✅ | Get uploaded file |
