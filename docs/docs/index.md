# Quark Agent

> A 5KB agent kernel that composes everything you need.

Like quarks compose into protons, compose the agent you need from the smallest possible kernel.

**Not another all-in-one framework.** The kernel is `<5KB gzipped`, and tools, channels, models — everything is a plug-and-play Skill.

---

## Why Quark Agent

| | Quark Agent | Claude Code | Codex CLI |
|---|:---:|:---:|:---:|
| Kernel size | **<5KB** | — | — |
| Composable tools | ✅ | ❌ fixed | ❌ fixed |
| Self-evolution (GEPA) | ✅ | ❌ | ❌ |
| Channel entries | 7 | CLI | CLI |
| A2A protocol | built-in | — | — |
| Profile presets | 6 | — | — |

---

## Benchmark

Evaluated on **AgentBench (THUDM)** + **GAIA (Meta/HF)** — 200 tasks, real LLM, real tool calls.

| Benchmark | Pass Rate |
|-----------|----------:|
| GAIA (Meta/HF) | **93.0%** |
| AgentBench (THUDM) | **85.0%** |
| **Overall** | **89.0%** |

See [Benchmark Overview](benchmark/index.md) for the full breakdown.

---

## Next Steps

- [Quick Start](quickstart.md) — get a running agent in 30 seconds
- [16 Tools](reference/tools.md) — what's in the box
- [7 Channels](reference/channels.md) — CLI, HTTP, Feishu, WeCom, Telegram, GitHub, Webhook
- [Benchmark Reproduction](benchmark/reproduce.md) — run the 200-task suite yourself
- [Contributing](community/contributing.md) — add a Skill in 60 seconds
