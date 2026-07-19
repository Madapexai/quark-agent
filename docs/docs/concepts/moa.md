# Mixture of Agents (MoA)

MoA intelligently routes tasks to the right model tier based on complexity — saving cost on simple tasks while reserving powerful models for hard ones.

## What is MoA

Instead of sending every request to the most expensive model, MoA analyzes the incoming task and assigns it to one of three model tiers:

| Tier | Typical Use | Cost | Latency |
|---|---|---|---|
| **fast** | Formatting, simple lookups, one-liners | $ | ~200ms |
| **medium** | Multi-step reasoning, moderate code generation | $$ | ~1s |
| **powerful** | Complex architecture, long-horizon planning, debugging | $$$ | ~3s |

MoA is **opt-in** — disabled by default. Enable it via config or environment variable.

## Task Complexity Detection

MoA classifies tasks using heuristic rules applied to the user message and context:

| Signal | Simple | Medium | Complex |
|---|---|---|---|
| Message length | < 50 chars | 50–300 chars | > 300 chars |
| Tool calls needed | 0–1 | 2–4 | 5+ |
| Code generation | None | Snippet / function | Multi-file / architecture |
| Context turns | 1 | 2–5 | 6+ |
| Keywords | "what is", "list", "convert" | "refactor", "explain", "write a function" | "design", "debug", "migrate", "architect" |

The final complexity score is a weighted sum. Thresholds are configurable.

## Model Tier Configuration

Define which model backs each tier in `.quark-agent.json`:

```json
{
  "moa": {
    "enabled": true,
    "defaultTier": "medium",
    "tiers": {
      "fast": {
        "provider": "openai",
        "model": "gpt-4o-mini"
      },
      "medium": {
        "provider": "openai",
        "model": "gpt-4o"
      },
      "powerful": {
        "provider": "anthropic",
        "model": "claude-sonnet-4-20250514"
      }
    }
  }
}
```

Or via environment variables:

```env
MOA_ENABLED=true
MOA_DEFAULT_TIER=medium
MOA_FAST_MODEL=gpt-4o-mini
MOA_MEDIUM_MODEL=gpt-4o
MOA_POWERFUL_MODEL=claude-sonnet-4-20250514
```

## Custom Routing Rules

Override the heuristic classifier with explicit rules for specific patterns:

```json
{
  "moa": {
    "enabled": true,
    "rules": [
      {
        "match": "sql",
        "tier": "fast"
      },
      {
        "match": "test",
        "tier": "medium"
      },
      {
        "match": "security",
        "tier": "powerful"
      }
    ]
  }
}
```

Each rule has:

- **`match`** — a substring or regex matched against the user message
- **`tier`** — the model tier to use
- **`priority`** (optional) — higher priority rules win when multiple match (default: 0)

Rules are evaluated **before** the heuristic classifier. First match wins.

## Example Usage

### Programmatic

```ts
import { createAgent } from "quark-agent";

const { agent } = await createAgent({
  profile: "coding",
  moa: {
    enabled: true,
    defaultTier: "medium",
    tiers: {
      fast: { provider: "openai", model: "gpt-4o-mini" },
      medium: { provider: "openai", model: "gpt-4o" },
      powerful: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
    },
    rules: [
      { match: "sql", tier: "fast" },
      { match: "debug", tier: "powerful" },
    ],
  },
});

// Simple query → routed to "fast" tier
await agent.run("What is the current timestamp?");

// Complex task → routed to "powerful" tier
await agent.run("Debug why the payment service returns 502 intermittently");
```

### CLI

```bash
# Enable MoA with default tiers
quark-agent --moa

# Override the powerful tier
quark-agent --moa --powerful-model claude-sonnet-4-20250514
```

### Inspecting routing decisions

Set `LOG_LEVEL=debug` to see which tier was selected and why:

```
[moa] task classified as "complex" (score: 0.82) → routing to "powerful" (claude-sonnet-4-20250514)
[moa] rule match: "debug" → forcing tier "powerful"
```
