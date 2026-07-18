# Reproduce the Benchmark

The full 200-task suite takes about 75 minutes and makes ~200 real LLM calls.

## Prerequisites

- Node.js ≥ 20
- An OpenAI-compatible API key (Volcengine Ark, OpenAI, Ollama, vLLM, …)
- ~500 MB disk for the report output

## Steps

### 1. Configure your provider

```bash
cp e2e/.env.example e2e/.env
# edit e2e/.env and fill in ARK_API_KEY (or OPENAI_API_KEY)
```

### 2. Start the demo server

```bash
npx tsx e2e/demo-server.ts
# → http://localhost:3456
```

Leave it running in a separate terminal.

### 3. Run the eval

```bash
PORT=3465 node e2e/full-eval.mjs --bench all
```

The script will:

1. Wait for the server to come up
2. Iterate over `e2e/bench-fixtures/gaia-100.json` (100 tasks) and `e2e/bench-fixtures/agentbench-100.json` (100 tasks)
3. For each task: send the prompt via SSE, capture the full event trace, run the matcher, write the result
4. Save results to `e2e/full-eval-results.json`
5. Generate a markdown report at `e2e/FULL-EVAL-REPORT.md`

### 4. Generate the HTML report

```bash
node e2e/gen-html-report.mjs
# → e2e/FULL-EVAL-REPORT.html (open in a browser)
```

## Flags

| Flag | Effect |
|------|--------|
| `--bench gaia` | Run only GAIA (100 tasks) |
| `--bench agentbench` | Run only AgentBench (100 tasks) |
| `--bench all` | Run both (default) |
| `--limit N` | Run only the first N tasks (for smoke testing) |

## What's in a task trace

Each task in `full-eval-results.json` has:

```json
{
  "index": 1,
  "benchmark": "GAIA",
  "id": "G-L1-001",
  "category": "Level 1",
  "input": "Read the file ...",
  "expected": "2017",
  "output": "The paper ... was published in 2017.",
  "status": "PASS",
  "matchReason": "substring match",
  "latencyMs": 5349,
  "toolCalls": [{ "tool": "read_file", "args": { "path": "..." } }],
  "toolResults": [{ "tool": "read_file", "result": "..." }],
  "thinkingSteps": ["Connecting to AI model ...", "Analyzing ...", "Processing tool results..."],
  "eventTypes": ["thinking", "tool_call", "tool_result", "text_delta", "done"],
  "toolChain": "read_file → extract year"
}
```

## Re-grading without re-running

If you only changed the matcher logic (not the agent), re-grade the existing results:

```bash
node e2e/re-grade.mjs
# reads full-eval-results.json, applies the latest matchers, prints old vs new pass rate
```
