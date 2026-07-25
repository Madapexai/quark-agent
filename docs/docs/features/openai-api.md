# OpenAI Compatible API

Drop-in replacement for OpenAI's chat completions API.

## Overview

Quark Agent exposes an OpenAI-compatible endpoint at `/v1/chat/completions`. This means any tool, SDK, or library that expects the OpenAI API can connect to quark-agent instead.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/models` | List available models |
| POST | `/v1/chat/completions` | Chat completion (streaming supported) |
| POST | `/v1/embeddings` | Embeddings (placeholder) |

## Usage

### cURL

```bash
# List models
curl http://localhost:8788/v1/models

# Chat completion (non-streaming)
curl -X POST http://localhost:8788/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "quark-agent",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Chat completion (SSE streaming)
curl -X POST http://localhost:8788/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "quark-agent",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8788/v1",
    api_key="any"  # auth via dashboard JWT
)

response = client.chat.completions.create(
    model="quark-agent",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

### JavaScript (OpenAI SDK)

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:8788/v1",
  apiKey: "any",
});

const response = await client.chat.completions.create({
  model: "quark-agent",
  messages: [{ role: "user", content: "Hello!" }],
});
```

### LangChain

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    base_url="http://localhost:8788/v1",
    api_key="any",
    model="quark-agent"
)
```

## Response Format

Non-streaming response follows the standard OpenAI format:

```json
{
  "id": "chatcmpl-123",
  "object": "chat.completion",
  "created": 1718800000,
  "model": "quark-agent",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "Hello!" },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15 }
}
```

Streaming uses SSE with `data:` lines and terminates with `data: [DONE]`.
