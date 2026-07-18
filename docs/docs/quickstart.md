# Quick Start

Get a running agent in 30 seconds.

## 1. Install

```bash
git clone https://github.com/Madapexai/quark-agent.git
cd quark-agent
npm install
```

Requirements: Node.js ≥ 20, an OpenAI-compatible API key.

## 2. Configure

```bash
cp e2e/.env.example e2e/.env
```

Edit `e2e/.env` and fill in your API key. Three provider priorities are supported:

```env
# Priority 1: Volcengine Ark (OpenAI-compatible)
ARK_API_KEY=
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/coding/v3
ARK_MODEL=doubao-seed-code

# Priority 2: Model Proxy (Anthropic format)
MODEL_PROXY_URL=http://127.0.0.1:43191
MODEL_PROXY_KEY=

# Priority 3: direct OpenAI-compatible API
OPENAI_API_KEY=
```

## 3. Run the demo

```bash
npx tsx e2e/demo-server.ts
# → http://localhost:3456
```

Open the URL in your browser. You should see the chat UI with streaming output, tool calls, and thinking steps.

## 4. Use it in code

```ts
import { createAgent } from "quark-agent";

const { agent } = await createAgent({
  apiKey: process.env.ARK_API_KEY!,
  profile: "coding",          // coding-only tools
  extraCategories: ["web"],   // plus the Web category
});

const result = await agent.run("Read package.json and tell me the version");
console.log(result.text);
```

## Troubleshooting

!!! tip "Port already in use"
    Override with `PORT=4000 npx tsx e2e/demo-server.ts`.

!!! warning "No API key"
    All three provider env vars are empty? The server will start but every chat will fail with a provider error.

!!! info "Want a different LLM?"
    Set `OPENAI_API_KEY` and `OPENAI_BASE_URL` to point at any OpenAI-compatible endpoint (Ollama, vLLM, Together, Groq, …).
