/**
 * DynamicWorkflow unit tests —— Codex-aligned /goal + plan/act + team
 *
 * Run:  npx tsx e2e/test-workflows.mjs
 *
 * Coverage:
 *   1. /goal happy path: model emits GOAL_COMPLETE → completion audit → achieved
 *   2. /goal blocked threshold: 3 consecutive GOAL_BLOCKED → status=blocked
 *   3. /goal budget_limit: token budget exhausted → graceful shutdown, NO complete
 *   4. /goal completion audit rejects proxy signals
 *   5. /goal 5-section spec parsing (Scope/Constraints/Done when/Stop if/budget)
 *   6. /goal pause/resume/clear external control
 *   7. Plan/Act mode: happy path + replan on failure
 *   8. Team mode: dispatch + summarize
 *   9. Directive parsing: /goal /loop /team
 */

import assert from "node:assert/strict";

// ---------- mock provider ----------
function makeProvider(responses) {
  return {
    name: "mock",
    responses: [...responses],
    async chat(_req) {
      const r = this.responses.shift();
      if (!r) throw new Error("mock provider exhausted");
      return { content: r };
    },
  };
}

// ---------- mock agent ----------
// `replies` is a queue — each call shifts one. If exhausted, returns default.
function makeAgent(replies = [], defaultReply = "working...") {
  const queue = [...replies];
  return {
    callCount: () => queue.length,
    async run(_prompt) {
      const r = queue.shift() ?? defaultReply;
      if (r instanceof Error) throw r;
      return { reply: r, rounds: 1, toolCalls: 0 };
    },
  };
}

const { DynamicWorkflow, DEFAULT_TEAM } = await import("../src/core/workflows.ts");

const RESULTS = [];
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { RESULTS.push({ name, ok: true }); console.log(`  ✓ ${name}`); },
    (e) => { RESULTS.push({ name, ok: false, err: e.message }); console.log(`  ✗ ${name}\n    ${e.message}`); },
  );
}

// ============================================================================
// Test 1: /goal happy path — model emits GOAL_COMPLETE, audit passes
// ============================================================================
await test("/goal: GOAL_COMPLETE + audit pass → status=complete", async () => {
  // Provider: completion audit returns passed=true
  const provider = makeProvider(['{"passed": true, "reason": "all criteria evidenced"}']);
  // Agent: first turn emits GOAL_COMPLETE with evidence
  const agent = makeAgent([
    "I read package.json and confirmed the project name is quark-agent.\nGOAL_COMPLETE\nEvidence: package.json line 2 contains \"name\": \"quark-agent\"",
  ]);
  const wf = new DynamicWorkflow({
    agent, provider, model: "mock", maxIterations: 5,
    estimateTokens: () => 100,
  });

  const events = [];
  const state = await wf.run(
    "/goal Find the project name\nDone when:\n- project name from package.json is reported",
    (e) => events.push(e),
  );

  assert.equal(state.status, "done");
  assert.equal(state.stopReason, "achieved");
  assert.ok(state.goalContext, "goalContext should be set");
  assert.equal(state.goalContext.status, "complete");
  assert.ok(events.some((e) => e.type === "goal_achieved"), "should emit goal_achieved");
  assert.ok(events.some((e) => e.type === "completion_audit"), "should run completion audit");
  assert.ok(state.goalContext.turnsCompleted >= 1);
});

// ============================================================================
// Test 2: /goal blocked threshold — 3 consecutive blocks → blocked
// ============================================================================
await test("/goal: 3 consecutive GOAL_BLOCKED → status=blocked", async () => {
  const provider = makeProvider([]);
  const agent = makeAgent([
    "GOAL_BLOCKED: missing API key",
    "GOAL_BLOCKED: missing API key",
    "GOAL_BLOCKED: missing API key",
  ]);
  const wf = new DynamicWorkflow({
    agent, provider, model: "mock", maxIterations: 10,
    estimateTokens: () => 50,
  });

  const events = [];
  const state = await wf.run("/goal Do something that requires missing API key", (e) => events.push(e));

  assert.equal(state.status, "done");
  assert.equal(state.stopReason, "blocked");
  assert.equal(state.goalContext.status, "blocked");
  assert.equal(state.goalContext.consecutiveBlocks, 3);
  assert.ok(events.some((e) => e.type === "block_detected"), "should emit block_detected");
  assert.ok(events.some((e) => e.type === "workflow_failed"), "should emit workflow_failed on threshold");
});

// ============================================================================
// Test 3: /goal budget_limit — token budget exhausted → graceful shutdown, NO complete
// ============================================================================
await test("/goal: token budget exhausted → budget_limited, NO goal_achieved", async () => {
  const provider = makeProvider([]);
  // Agent: keeps making progress but never completes (consumes budget)
  const agent = makeAgent([
    "working on step 1...",
    "working on step 2...",
    "working on step 3...",
    "GOAL_COMPLETE", // would normally complete, but budget hits first
  ]);
  // Tiny budget so it triggers fast; estimateTokens returns 1000/turn
  const wf = new DynamicWorkflow({
    agent, provider, model: "mock", maxIterations: 20,
    estimateTokens: () => 1000,
  });

  const events = [];
  const state = await wf.run(
    "/goal Long task\nUse a token budget of 2500 tokens",
    (e) => events.push(e),
  );

  assert.equal(state.status, "done");
  assert.equal(state.stopReason, "budget_limited");
  assert.equal(state.goalContext.status, "budget_limited");
  assert.ok(state.goalContext.tokensUsed >= 2500, "tokensUsed should exceed budget");
  assert.ok(events.some((e) => e.type === "budget_limit"), "should emit budget_limit");
  assert.ok(!events.some((e) => e.type === "goal_achieved"), "must NOT emit goal_achieved when budget_limited");
});

// ============================================================================
// Test 4: /goal completion audit rejects proxy signals
// ============================================================================
await test("/goal: completion audit fails on proxy signal → continues, not achieved", async () => {
  // Provider: audit returns passed=false (proxy signal)
  const provider = makeProvider(['{"passed": false, "reason": "no concrete evidence, only plausibility"}']);
  // Agent: turn 1 claims complete without evidence, turn 2 also claims, etc.
  const agent = makeAgent([
    "I think the task is done.\nGOAL_COMPLETE", // audit will reject this
    "GOAL_BLOCKED: cannot proceed",             // then blocked to terminate
    "GOAL_BLOCKED: cannot proceed",
    "GOAL_BLOCKED: cannot proceed",
  ]);
  const wf = new DynamicWorkflow({
    agent, provider, model: "mock", maxIterations: 10,
    estimateTokens: () => 50,
  });

  const events = [];
  const state = await wf.run(
    "/goal Build feature X\nDone when:\n- file src/x.ts exists",
    (e) => events.push(e),
  );

  // Audit failed on turn 1, so not achieved; then blocked to terminate
  assert.notEqual(state.stopReason, "achieved", "must not achieve when audit fails");
  assert.ok(events.some((e) => e.type === "completion_audit"), "should run audit");
  const auditEvents = events.filter((e) => e.type === "completion_audit");
  assert.ok(auditEvents.some((e) => e.content.includes("FAILED") || e.content.includes("failed")), "should have failed audit event");
});

// ============================================================================
// Test 5: 5-section goal spec parsing
// ============================================================================
await test("parseDirective: 5-section goal template parsed correctly", async () => {
  // Use a goal that completes immediately to test parsing
  const provider = makeProvider(['{"passed": true, "reason": "ok"}']);
  const agent = makeAgent(["GOAL_COMPLETE\nEvidence: tests pass"]);
  const wf = new DynamicWorkflow({ agent, provider, model: "mock", maxIterations: 3 });

  const state = await wf.run(
    "/goal Migrate auth module to JWT\n" +
    "Scope: src/auth/*\n" +
    "Constraints:\n- do not change public API\n- keep tests passing\n" +
    "Done when:\n- JWT issued in login flow\n- old session code removed\n" +
    "Stop if:\n- 3 consecutive test failures\n" +
    "Use a token budget of 50000 tokens",
  );

  const ctx = state.goalContext;
  assert.ok(ctx, "goalContext should exist");
  assert.equal(ctx.spec.objective, "Migrate auth module to JWT");
  assert.equal(ctx.spec.scope, "src/auth/*");
  assert.deepEqual(ctx.spec.constraints, ["do not change public API", "keep tests passing"]);
  assert.deepEqual(ctx.spec.doneWhen, ["JWT issued in login flow", "old session code removed"]);
  assert.deepEqual(ctx.spec.stopIf, ["3 consecutive test failures"]);
  assert.equal(ctx.spec.tokenBudget, 50000);
});

// ============================================================================
// Test 6: pause / resume / clear external control
// ============================================================================
await test("/goal: pause/resume/clear external control works", async () => {
  const provider = makeProvider(['{"passed": true, "reason": "ok"}']);
  // Agent never completes — only stops via external control
  const agent = makeAgent(["working...", "working...", "working...", "working..."]);
  const wf = new DynamicWorkflow({
    agent, provider, model: "mock", maxIterations: 100,
    estimateTokens: () => 10,
  });

  // Run /goal — it will loop. We can't easily test pause mid-loop without
  // async hooks, so test the public API directly:
  // Start the workflow in background
  const runPromise = wf.run("/goal Never ending task", () => {});

  // Give it a turn
  await new Promise((r) => setTimeout(r, 50));

  // Pause should work
  const paused = wf.pauseGoal();
  assert.equal(paused, true, "pause should succeed when active");
  assert.equal(wf.getGoalContext()?.status, "paused");

  // Resume should work
  const resumed = wf.resumeGoal();
  assert.equal(resumed, true, "resume should succeed when paused");
  assert.equal(wf.getGoalContext()?.status, "active");

  // Clear should work
  const cleared = wf.clearGoal();
  assert.equal(cleared, true, "clear should succeed");

  await runPromise;
});

// ============================================================================
// Test 7: Plan/Act mode — happy path
// ============================================================================
await test("Plan/Act: executes all planned steps", async () => {
  const provider = makeProvider([
    "Read package.json\nList src files\nSummarize",
  ]);
  const agent = makeAgent(["step 1 done", "step 2 done", "step 3 done"]);
  const wf = new DynamicWorkflow({ agent, provider, model: "mock", maxIterations: 10 });

  const events = [];
  const state = await wf.run("Analyze the project", (e) => events.push(e));

  assert.equal(state.status, "done");
  assert.equal(state.stopReason, "achieved");
  assert.equal(state.plan.length, 3);
  assert.equal(state.results.length, 3);
  assert.ok(events.some((e) => e.type === "workflow_complete"));
});

// ============================================================================
// Test 8: Plan/Act — replan on failure
// ============================================================================
await test("Plan/Act: replans when a step fails", async () => {
  const provider = makeProvider([
    "Do step 1\nDo step 2",
    "Retry step 1 differently\nDo step 2",
  ]);
  // Agent: step 1 throws, then succeeds on retry, then step 2 succeeds
  const agent = makeAgent([new Error("step 1 failed"), "step 1 retry ok", "step 2 ok"]);
  const wf = new DynamicWorkflow({ agent, provider, model: "mock", maxIterations: 10, maxReplans: 3 });

  const events = [];
  const state = await wf.run("Build feature", (e) => events.push(e));

  assert.equal(state.status, "done");
  assert.ok(events.some((e) => e.type === "replan"), "should emit replan");
  assert.ok(events.some((e) => e.type === "step_failed"), "should emit step_failed");
});

// ============================================================================
// Test 9: Team mode — dispatch + summarize
// ============================================================================
await test("Team: dispatches to members and summarizes", async () => {
  const team = DEFAULT_TEAM;
  const provider = makeProvider([
    "Research the topic | web_search | @researcher\nWrite code | write_file | @coder\nReview work | read_file | @reviewer",
    "Team summary: all done",
  ]);
  const agent = makeAgent(["research done", "code written", "review passed"]);
  const wf = new DynamicWorkflow({
    agent, provider, model: "mock", teamMembers: team,
  });

  const events = [];
  const state = await wf.run("/team Build a feature", (e) => events.push(e));

  assert.equal(state.status, "done");
  assert.equal(state.mode, "team");
  assert.equal(state.stopReason, "achieved");
  assert.ok(events.some((e) => e.type === "team_dispatch"));
  assert.ok(events.some((e) => e.type === "team_result"));
  assert.ok(state.plan.every((s) => s.assignee), "every step should have an assignee");
});

// ============================================================================
// Test 10: Directive parsing — /goal /loop /team mode selection
// ============================================================================
await test("Directive parsing: mode selection correct", async () => {
  // /goal + /loop → goal mode (loop is syntax sugar)
  const p1 = makeProvider(['{"passed": true, "reason": "ok"}']);
  const a1 = makeAgent(["GOAL_COMPLETE"]);
  const wf1 = new DynamicWorkflow({ agent: a1, provider: p1, model: "mock" });
  const s1 = await wf1.run("/goal do something /loop");
  assert.equal(s1.mode, "goal", "/goal + /loop → goal mode");
  assert.ok(s1.goalContext, "should have goalContext");

  // /team → team mode
  const p2 = makeProvider(["step one | @coder", "summary"]);
  const a2 = makeAgent(["done"]);
  const wf2 = new DynamicWorkflow({ agent: a2, provider: p2, model: "mock", teamMembers: DEFAULT_TEAM });
  const s2 = await wf2.run("/team do a thing");
  assert.equal(s2.mode, "team", "/team → team mode");
  assert.ok(!s2.goalContext, "team mode should not have goalContext");

  // plain text → plan/act mode
  const p3 = makeProvider(["step one\nstep two"]);
  const a3 = makeAgent(["done", "done"]);
  const wf3 = new DynamicWorkflow({ agent: a3, provider: p3, model: "mock" });
  const s3 = await wf3.run("just do something");
  assert.equal(s3.mode, "plan", "plain text → plan/act mode");
  assert.ok(!s3.goalContext, "plan mode should not have goalContext");
});

// ============================================================================
// Summary
// ============================================================================
console.log("\n" + "=".repeat(60));
const passed = RESULTS.filter((r) => r.ok).length;
const failed = RESULTS.length - passed;
console.log(`DynamicWorkflow tests: ${passed}/${RESULTS.length} passed${failed ? `, ${failed} failed` : ""}`);
if (failed > 0) {
  console.log("\nFailures:");
  RESULTS.filter((r) => !r.ok).forEach((r) => console.log(`  - ${r.name}: ${r.err}`));
  process.exit(1);
}
process.exit(0);
