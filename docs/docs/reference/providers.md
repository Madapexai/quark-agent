# 22 LLM Providers, 49 Models

Every provider uses real API endpoints - no stubs. Zero SDK dependencies (all HTTP via Node `fetch`).

## Provider List

| # | Provider | Free Tier | Default Model | Context Window |
|---|----------|:---------:|----------------|---------------:|
| 1 | ZhipuAI (GLM) | ✅ | glm-4-flash | 128K |
| 2 | Agnes AI | ✅ | agnes-2.0-flash | 128K |
| 3 | DeepSeek | - | deepseek-chat | 64K |
| 4 | Volcengine Ark | - | doubao-seed-code | 128K |
| 5 | Moonshot | - | moonshot-v1 | 128K |
| 6 | Qwen (Tongyi) | - | qwen-turbo | 128K |
| 7 | MiniMax | - | abab6.5s-chat | 245K |
| 8 | Baichuan | - | baichuan2-turbo | 192K |
| 9 | Yi (01.AI) | - | yi-lightning | 16K |
| 10 | StepFun | - | step-1-8k | 8K |
| 11 | SiliconFlow | - | Qwen/Qwen2.5-7B-Instruct | 32K |
| 12 | OpenAI | - | gpt-4o | 128K |
| 13 | Anthropic | - | claude-sonnet-4-20250514 | 200K |
| 14 | Gemini | - | gemini-2.0-flash | 1M |
| 15 | OpenRouter | - | auto | varies |
| 16 | Together | - | meta-llama/Llama-3 | 8K |
| 17 | Groq | - | llama-3.1-8b-instant | 128K |
| 18 | Fireworks | - | llama-v3p1-70b-instruct | 32K |
| 19 | Mistral | - | mistral-large-latest | 128K |
| 20 | Ollama (local) | ✅ | llama3.2 | 128K |
| 21 | LM Studio (local) | ✅ | - | varies |
| 22 | vLLM (local) | ✅ | - | varies |

## Configuration

Each provider is configured via environment variables or the config file:

```env
# Example: GLM
GLM_API_KEY=your_key
GLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
GLM_MODEL=glm-4-flash

# Example: OpenAI
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o

# Example: Ollama (local, no key)
OPENAI_API_KEY=ollama
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_MODEL=llama3.2
```

## Provider Fallback

At startup, each provider is probed. The first healthy one becomes primary. If it fails at runtime, requests fall back to the next provider in the chain.

## Model Manager

Hot-swap models at runtime:

```ts
import { modelManager } from "quark-agent";

// List configured models
modelManager.list();

// Set active model
modelManager.setActive("deepseek-chat");

// Probe a model
const healthy = await modelManager.probe("glm-4-flash");

// Compare models
const diff = modelManager.compare("glm-4-flash", "deepseek-chat");
```
