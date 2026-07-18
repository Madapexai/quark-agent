# GAIA Results

GAIA (General AI Assistants) is a benchmark from Meta / Hugging Face with 3 difficulty levels, designed to test real-world assistant capabilities.

## Headline

- **Tasks**: 100 (40 L1 + 35 L2 + 25 L3)
- **Pass**: 93
- **Pass Rate**: 93.0%
- **Avg Latency**: 9.5s

## By Level

| Level | Total | Pass | Fail | Error | Pass Rate |
|-------|------:|----:|----:|------:|----------:|
| Level 1 | 40 | 39 | 1 | 0 | 97.5% |
| Level 2 | 35 | 33 | 2 | 0 | 94.3% |
| Level 3 | 25 | 21 | 4 | 0 | 84.0% |

## What GAIA Tests

- **L1** — single-step tasks: read a file and extract a fact, count items in a CSV, etc.
- **L2** — multi-step tasks: combine data from 2-3 sources, do light computation.
- **L3** — long-horizon tasks: cross-reference many files, multi-hop reasoning.

## Common Failure Modes

1. **Numeric precision** — agent rounds intermediate results and loses precision (L3)
2. **File path ambiguity** — agent picks the wrong file when multiple exist (L2)
3. **Tool underuse** — agent answers from memory when it should call `web_search` (L3)

## Sample Trace

```
Task G-L1-001:
  Input: Read the file 'paper-abstract.txt' and tell me the year this paper was published.
  Tool call: read_file({path: "..."})
  Tool result: "Title: Attention Is All You Need\nYear: 2017\n..."
  Output: The paper "Attention Is All You Need" was published in the year 2017.
  Expected: 2017
  Match: substring ✅
```

See the [interactive HTML report](https://madapexai.github.io/quark-agent/benchmark/full-eval-report.html) for all 100 task traces.
