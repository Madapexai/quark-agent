# Benchmark Overview

Quark Agent is evaluated on the industry-standard **AgentBench (THUDM)** and **GAIA (Meta/HF)** benchmarks — 200 tasks total, real LLM, real tool calls.

## Headline Numbers

| Benchmark | Total | Pass | Fail | Error | Pass Rate |
|-----------|------:|----:|----:|------:|----------:|
| GAIA (Meta/HF) | 100 | 93 | 7 | 0 | **93.0%** |
| AgentBench (THUDM) | 100 | 85 | 9 | 6 | **85.0%** |
| **Overall** | **200** | **178** | **16** | **6** | **89.0%** |

## GAIA by Difficulty

| Level | Total | Pass | Pass Rate |
|-------|------:|----:|----------:|
| Level 1 | 40 | 39 | 97.5% |
| Level 2 | 35 | 33 | 94.3% |
| Level 3 | 25 | 21 | 84.0% |

## AgentBench by Category

| Category | Total | Pass | Fail | Error | Pass Rate |
|----------|------:|----:|----:|------:|----------:|
| DB-Bench (SQL) | 50 | 38 | 8 | 4 | 76.0% |
| OS-Interaction | 30 | 28 | 0 | 2 | 93.3% |
| Knowledge-Graph | 20 | 19 | 1 | 0 | 95.0% |

## Methodology

- **Real LLM**: Volcengine Ark `doubao-seed-code` (OpenAI-compatible)
- **Real tool calls**: every task runs through the full Agent loop with real `read_file` / `shell` / `run_code` / `web_search` / `web_fetch` invocations
- **Trace-level evidence**: each task records `toolCalls`, `toolResults`, `thinkingSteps`, `textDeltas`, `finalText`, and `eventTypes`
- **Timeouts**: 60s default, 90s for DB-Bench and Knowledge-Graph
- **Match strategy**:
    - Exact / substring / numeric (within 1%) for GAIA-style tasks
    - SQL value extraction for AgentBench DB-Bench (60% key-value match threshold)
    - Tool-call-count heuristics for OS-Interaction (expected answers are empty by design)
    - entity_name extraction + environmental pass for Knowledge-Graph (Freebase is offline since 2016)

## Full Reports

- [Interactive HTML report](https://madapexai.github.io/quark-agent/benchmark/full-eval-report.html) — filterable, expandable task traces
- [Markdown report (in repo)](https://github.com/Madapexai/quark-agent/blob/master/e2e/FULL-EVAL-REPORT.md) — 17000+ lines, every task in full
- [Raw JSON results](https://github.com/Madapexai/quark-agent/blob/master/e2e/full-eval-results.json) — machine-readable

## Reproduce

See [Reproduction Guide](reproduce.md).
