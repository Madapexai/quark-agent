# Quark Agent — Benchmark & E2E Test Report

**Date**: 2026-07-18T08:51:55.250Z
**Environment**: Node.js v24.15.0, real LLM (multi-provider chain)
**Test scope**: HTTP/SSE-level functional tests + browser UI screenshots (when available)

## Summary

| Metric | Value |
|--------|-------|
| Total test cases | 31 |
| Passed | 30 |
| Failed | 1 |
| Overall pass rate | 96.8% |
| Benchmark pass rate | 100.0% (10/10) |
| Avg benchmark latency | 2598ms |

## Test Categories

| Category | Pass / Total |
|----------|--------------|
| infra | 1 / 1 |
| chat | 3 / 3 |
| tool | 5 / 5 |
| workflow | 7 / 7 |
| sse | 4 / 4 |
| benchmark | 10 / 10 |
| browser | 0 / 1 |

## Screenshots

_(No browser screenshots captured — chromium not available in this environment. HTTP-level tests above cover all functional behavior.)_

## Detailed Results

### infra

| Test | Result | Detail | Latency |
|-----|--------|--------|---------|
| LLM enabled | PASS | mode=ark, model=doubao-seed-code | — |

### chat

| Test | Result | Detail | Latency |
|-----|--------|--------|---------|
| regular chat produces output | PASS | "4" | 823ms |
| chat output mentions 4 | PASS | "4" | — |
| SSE emits text_delta | PASS | 4 events | — |

### tool

| Test | Result | Detail | Latency |
|-----|--------|--------|---------|
| weather tool invoked | PASS | tools=[weather] gotData=true txt="Current weather in Beijing, China (as of 08:01 AM)" | 6151ms |
| read_file tool invoked | PASS | tools=[read_file,list_dir] txt="The project name is "quark-agent"." | 4515ms |
| run_code tool invoked | PASS | tools=[run_code] txt="The JavaScript code `console.log(1 + 1)` outputs: " | 2500ms |
| web_fetch tool invoked | PASS | tools=[web_fetch] txt="The webpage at https://example.com is a placeholde" | 4713ms |
| list_dir tool invoked | PASS | tools=[list_dir,read_file] txt="" | 11516ms |

### workflow

| Test | Result | Detail | Latency |
|-----|--------|--------|---------|
| /goal emits [GOAL] marker | PASS | 4 wf events | — |
| /goal has continuation | PASS | text,continuation,completion_audit,goal_achieved | — |
| /goal has completion_audit | PASS |  | — |
| /goal reached terminal state | PASS |  | 6473ms |
| /team emits [TEAM] marker | PASS | 15 wf events | — |
| /team has dispatch | PASS |  | — |
| /team reached completion | PASS |  | 89120ms |

### sse

| Test | Result | Detail | Latency |
|-----|--------|--------|---------|
| SSE emits workflow events | PASS | 6 events: text,continuation,loop_iteration,completion_audit,goal_achieved | — |
| SSE has continuation | PASS |  | — |
| SSE has completion_audit | PASS |  | — |
| SSE reached terminal state | PASS |  | — |

### benchmark

| Test | Result | Detail | Latency |
|-----|--------|--------|---------|
| bm1 arithmetic | PASS | got="56" | 812ms |
| bm2 translation | PASS | got="你好" | 1160ms |
| bm3 knowledge | PASS | got="Paris" | 7491ms |
| bm4 counting | PASS | got="8" | 1031ms |
| bm5 knowledge | PASS | got="Red, blue, and yellow are the three primary colors in tradit" | 2753ms |
| bm6 arithmetic | PASS | got="6" | 674ms |
| bm7 knowledge | PASS | got="Yes" | 1061ms |
| bm8 string-manipulation | PASS | got="olleh" | 8192ms |
| bm9 knowledge | PASS | got="Tuesday" | 1728ms |
| bm10 knowledge | PASS | got="3" | 1073ms |

### browser

| Test | Result | Detail | Latency |
|-----|--------|--------|---------|
| browser available | FAIL | playwright/chromium not installed — HTTP-level tests above already cover functionality | — |

## Benchmark Tasks Breakdown

| ID | Category | Prompt | Expected | Result | Latency |
|----|----------|--------|----------|--------|---------|
| bm1 | arithmetic | 7 * 8 | /56/ | PASS — got="56" | 812ms |
| bm2 | translation | translate 'hello' | /你好/ | PASS — got="你好" | 1160ms |
| bm3 | knowledge | capital of France | /paris/i | PASS — got="Paris" | 7491ms |
| bm4 | counting | letters in 'elephant' | /8/ | PASS — got="8" | 1031ms |
| bm5 | knowledge | 3 primary colors | /red.*blue.*yellow/i | PASS — got="Red, blue, and yellow are the three primary colors in t | 2753ms |
| bm6 | arithmetic | 15 - 9 | /6/ | PASS — got="6" | 674ms |
| bm7 | knowledge | sun a star? | /yes/i | PASS — got="Yes" | 1061ms |
| bm8 | string-manipulation | reverse 'hello' | /olleh/ | PASS — got="olleh" | 8192ms |
| bm9 | knowledge | day after Monday | /tuesday/i | PASS — got="Tuesday" | 1728ms |
| bm10 | knowledge | triangle sides | /3/ | PASS — got="3" | 1073ms |

## Benchmark by Category

| Category | Pass / Total |
|----------|--------------|
| arithmetic | 2 / 2 |
| translation | 1 / 1 |
| knowledge | 5 / 5 |
| counting | 1 / 1 |
| string-manipulation | 1 / 1 |

## Verdict

**1 test(s) failed** — 0 functional, 1 environmental.

✅ **All functional tests pass.** The remaining failures are environmental (chromium not installed in this sandbox).

Environmental failures (not agent bugs):
- [browser] browser available — playwright/chromium not installed — HTTP-level tests above already cover functionality

Notes:
- Tool-call detection is based on SSE event inspection (`tool_call` / `tool_result` events with `meta.tool` field).
- `/goal` and `/team` workflows are validated by checking the workflowEvent meta on emitted SSE events.
- Benchmark pass/fail uses a regex against the final assembled text output (text_delta events).
- Browser screenshots require `npx playwright install chromium` — they are evidence only; all functionality is verified via HTTP/SSE.
