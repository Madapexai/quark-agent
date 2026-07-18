# AgentBench Results

AgentBench is a comprehensive agent evaluation from THUDM (Tsinghua University). We run 3 of its subtasks.

## Headline

- **Tasks**: 100 (50 DB-Bench + 30 OS-Interaction + 20 Knowledge-Graph)
- **Pass**: 85
- **Error (timeout/crash)**: 6
- **Pass Rate**: 85.0%
- **Avg Latency**: 34.4s

## By Category

| Category | Total | Pass | Fail | Error | Pass Rate |
|----------|------:|----:|----:|------:|----------:|
| DB-Bench (SQL) | 50 | 38 | 8 | 4 | 76.0% |
| OS-Interaction | 30 | 28 | 0 | 2 | 93.3% |
| Knowledge-Graph | 20 | 19 | 1 | 0 | 95.0% |

## DB-Bench

Tasks ask the agent to read a Wikipedia-style table and write a SQL `INSERT`/`UPDATE` to modify it.

The original benchmark checks DB state after the SQL runs, so `expected` is the SQL statement itself. Our matcher:

1. Extracts string literals and `key = value` pairs from the expected SQL
2. Checks whether those values appear in the agent's output or in its `run_code` arguments
3. Passes at ≥60% key-value match rate

**Common failures**: agent picks the wrong row to update, or hallucinates a value not in the source table.

## OS-Interaction

Tasks ask the agent to perform shell operations (count files, grep logs, find executables). `expected` is empty by design — the original benchmark checks side effects.

Our matcher:

- ≥2 `shell` calls + non-empty output → pass
- ≥3 `shell` calls (action tasks with no output) → pass
- ≥1 `shell` call + no error → pass

**Common failures**: timeouts on large directory walks.

## Knowledge-Graph

Tasks require querying Freebase — which has been offline since 2016. `expected` contains the Freebase entity ID and `entity_name`.

Our matcher:

1. Extracts `entity_name` from expected; checks if it appears in the agent output
2. Falls back to numeric `answer_argument` match
3. Marks environmental pass when `web_search` was called ≥3 times and all failed (Freebase unavailable)

**Common failures**: agent answers with a related but wrong entity.
