# Kernel & Layers

Quark Agent is built as an onion — concentric layers, each one opt-in.

## The 4 Layers

| Layer | Package | What's Inside | Deps |
|---|---|---|---|
| **Kernel** | `packages/core` | `Agent`, `Context`, `Runtime`, `Types` | **zero** |
| **Plugins** | `packages/plugins` | `A2A`, `SSE`, `Workspace`, `defineAction` | kernel |
| **Extensions** | `packages/extensions` | `Sessions`, `Healer`, `Skill scoring` | kernel + plugins |
| **Full** | `src/` | All 16 tools, 7 channels, all providers, evolve, memory, sandbox | everything |

## Pay for What You Use

```ts
// Just the kernel — 5KB, no tools, no channels
import { Agent } from "quark-agent/core";
const agent = new Agent({ ... });

// Add plugins (defineAction, SSE, workspace)
import "quark-agent/plugins";

// Add extensions (sessions, healer)
import "quark-agent/extensions";

// Or just take everything
import { createAgent } from "quark-agent";
```

## Why So Small?

The kernel does exactly four things:

1. **Agent loop** — receive a message, call the LLM, dispatch tool calls, repeat until done
2. **Context** — holds the conversation, tools, and current state
3. **Runtime** — wires providers, channels, and plugins together
4. **Types** — TypeScript types so the rest of the codebase stays honest

Everything else — the 16 tools, 7 channels, GEPA evolver, A2A protocol, SQLite memory — lives outside the kernel and is loaded only if you need it.

## Dependency Policy

- The kernel (`packages/core`) must stay **zero-dependency** and **<5KB gzipped**
- Plugins may depend on the kernel only
- Extensions may depend on kernel + plugins
- The full `src/` layer can depend on anything

This is enforced by a pre-commit hook (`scripts/pre-commit-check.sh`) that checks the kernel size on every commit.
