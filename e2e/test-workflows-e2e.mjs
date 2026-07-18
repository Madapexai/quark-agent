/**
 * E2E test: verify /goal /loop /team workflow endpoints via SSE.
 *
 * Prereq: demo-server running on PORT (default 3457).
 *   PORT=3457 npx tsx e2e/demo-server.ts &
 *   node e2e/test-workflows-e2e.mjs
 *
 * Each test sends a workflow directive, streams SSE events, and asserts:
 *   - the workflow-specific event types appear (plan_created, step_*, etc.)
 *   - the workflow eventually completes (status: done)
 */

const PORT = process.env.PORT || "3457";
const BASE = `http://localhost:${PORT}`;

const RESULTS = [];
async function test(name, fn) {
  try { await fn(); RESULTS.push({ name, ok: true }); console.log(`  ✓ ${name}`); }
  catch (e) { RESULTS.push({ name, ok: false, err: e.message }); console.log(`  ✗ ${name}\n    ${e.message}`); }
}

/** Stream a chat message and collect SSE steps. Returns parsed step array. */
async function streamChat(message, { timeoutMs = 60000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const steps = [];
  try {
    const res = await fetch(`${BASE}/api/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history: [] }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith("data:")) {
          try { steps.push(JSON.parse(line.slice(5).trim())); } catch {}
        }
      }
    }
  } finally { clearTimeout(timer); }
  return steps;
}

// ============================================================================
// Test 1: /goal (Plan/Act) — uses LLM to decompose and execute
// ============================================================================
await test("/goal workflow streams plan_created + step events + done", async () => {
  const steps = await streamChat("/goal Read package.json and tell me the project name");

  const types = steps.map((s) => s.type);
  const workflowEvents = steps
    .map((s) => s.meta?.workflowEvent)
    .filter(Boolean);
  const firstContent = steps[0]?.content ?? "";

  // Workflow path must actually be entered (not the fallback banner)
  if (/Workflow mode requires LLM/i.test(firstContent)) {
    throw new Error("workflow did not enter: hit LLM-required fallback");
  }
  // Must see at least one workflow-specific event (plan_created / step_start / continuation / etc.)
  const wfEventSet = new Set(workflowEvents);
  if (wfEventSet.size === 0) {
    throw new Error(`no workflowEvent meta in SSE stream; types were: ${JSON.stringify([...new Set(types)])}`);
  }
  // Workflow should emit a terminal event
  const hasTerminal = types.some((t) => t === "done" || t === "text" || t === "error");
  if (!hasTerminal) throw new Error("no terminal event");
  console.log(`    received ${steps.length} SSE events, workflowEvents: ${[...wfEventSet].join(", ")}`);
});

// ============================================================================
// Test 2: /goal + /loop — Goal/Loop dynamic workflow
// ============================================================================
await test("/goal + /loop streams loop_iteration + evaluation events", async () => {
  const steps = await streamChat("/goal List files in workspace and report count /loop", { timeoutMs: 90000 });

  const types = steps.map((s) => s.type);
  const firstContent = steps[0]?.content ?? "";
  if (/Workflow mode requires LLM/i.test(firstContent)) {
    throw new Error("workflow did not enter: hit LLM-required fallback");
  }
  if (steps.length < 3) throw new Error(`too few events (${steps.length}); workflow may not be running`);

  const workflowEvents = steps.map((s) => s.meta?.workflowEvent).filter(Boolean);
  if (workflowEvents.length === 0) {
    throw new Error(`no workflowEvent meta; types: ${JSON.stringify([...new Set(types)])}`);
  }

  const hasError = types.includes("error");
  const hasTerminal = types.includes("done") || types.includes("text");
  if (!hasTerminal && !hasError) {
    throw new Error(`expected done/text/error event, got: ${JSON.stringify(types.slice(-5))}`);
  }
  console.log(`    received ${steps.length} SSE events, workflowEvents: ${[...new Set(workflowEvents)].join(", ")}`);
});

// ============================================================================
// Test 3: /team — Agent Team mode
// ============================================================================
await test("/team workflow streams team_dispatch events", async () => {
  const steps = await streamChat("/team Read package.json and summarize", { timeoutMs: 90000 });

  const types = steps.map((s) => s.type);
  const firstContent = steps[0]?.content ?? "";
  if (/Workflow mode requires LLM/i.test(firstContent)) {
    throw new Error("workflow did not enter: hit LLM-required fallback");
  }
  if (steps.length < 3) throw new Error(`too few events (${steps.length})`);

  const workflowEvents = steps.map((s) => s.meta?.workflowEvent).filter(Boolean);
  if (workflowEvents.length === 0) {
    throw new Error(`no workflowEvent meta; types: ${JSON.stringify([...new Set(types)])}`);
  }

  const hasError = types.includes("error");
  const hasTerminal = types.includes("done") || types.includes("text");
  if (!hasTerminal && !hasError) {
    throw new Error(`expected done/text/error event, got: ${JSON.stringify(types.slice(-5))}`);
  }
  console.log(`    received ${steps.length} SSE events, workflowEvents: ${[...new Set(workflowEvents)].join(", ")}`);
});

// ============================================================================
// Test 4: Web UI serves the new workflow suggestion cards
// ============================================================================
await test("Web UI includes /goal /loop /team suggestion cards", async () => {
  const res = await fetch(`${BASE}/`);
  const html = await res.text();
  if (!html.includes("/goal")) throw new Error("UI missing /goal");
  if (!html.includes("/loop")) throw new Error("UI missing /loop");
  if (!html.includes("/team")) throw new Error("UI missing /team");
  if (!html.includes("Dynamic Workflows")) throw new Error("UI missing 'Dynamic Workflows' section");
});

// ============================================================================
// Summary
// ============================================================================
console.log("\n" + "=".repeat(60));
const passed = RESULTS.filter((r) => r.ok).length;
const failed = RESULTS.length - passed;
console.log(`E2E workflow tests: ${passed}/${RESULTS.length} passed${failed ? `, ${failed} failed` : ""}`);
if (failed > 0) {
  console.log("\nFailures:");
  RESULTS.filter((r) => !r.ok).forEach((r) => console.log(`  - ${r.name}: ${r.err}`));
  process.exit(1);
}
process.exit(0);
