/**
 * Cross-Harness Relay unit tests
 *
 * Run: npx tsx e2e/test-cross-harness-relay.mjs
 *
 * Coverage:
 *   1. ClaudeCodeAdapter: exportContext reads CLAUDE.md
 *   2. ClaudeCodeAdapter: importContext appends to CLAUDE.md
 *   3. CodexAdapter: exportContext reads AGENTS.md
 *   4. CodexAdapter: importContext appends to AGENTS.md
 *   5. HermesAdapter: exportContext reads SOUL.md + MEMORY.md
 *   6. QuarkAgentAdapter: exportContext reads from Memory
 *   7. relayCrossHarness: Claude Code → Codex
 *   8. relayCrossHarness: Codex → Quark Agent
 *   9. createHarnessAdapter: factory creates correct type
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const { SqliteMemory } = await import("../src/memory/sqlite.ts");
const { RelayService } = await import("../src/relay/index.ts");
const {
  ClaudeCodeAdapter,
  CodexAdapter,
  HermesAdapter,
  QuarkAgentAdapter,
  createHarnessAdapter,
} = await import("../src/relay/harness-adapter.ts");

const RESULTS = [];
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { RESULTS.push({ name, ok: true }); console.log(`  ✓ ${name}`); },
    (e) => { RESULTS.push({ name, ok: false, err: e.message }); console.log(`  ✗ ${name}\n    ${e.message}`); },
  );
}

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), "quark-xh-"));
}

// ============================================================================
// Tests
// ============================================================================

await test("ClaudeCodeAdapter: exportContext reads CLAUDE.md", async () => {
  const dir = makeTmpDir();
  writeFileSync(join(dir, "CLAUDE.md"), `# Project Rules

- Use TypeScript
- Always add tests
- Don't commit secrets
`);
  const adapter = new ClaudeCodeAdapter(dir, "session-1");
  const blocks = await adapter.exportContext();
  assert.ok(blocks.length > 0, "should export blocks");
  const allContent = blocks.map((b) => b.content).join(" ");
  assert.ok(allContent.includes("TypeScript"), "should include TypeScript rule");
  assert.equal(blocks[0].sourceHarness, "claude-code", "sourceHarness should be claude-code");
  rmSync(dir, { recursive: true, force: true });
});

await test("ClaudeCodeAdapter: importContext appends to CLAUDE.md", async () => {
  const dir = makeTmpDir();
  writeFileSync(join(dir, "CLAUDE.md"), `# Existing Rules\n\n- Original rule`);
  const adapter = new ClaudeCodeAdapter(dir, "session-1");
  await adapter.importContext([
    { role: "user", content: "Codex says: use Rust for performance", sourceHarness: "codex", timestamp: Date.now() },
  ], { mode: "append" });
  const content = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
  assert.ok(content.includes("Original rule"), "should keep original content");
  assert.ok(content.includes("Codex says"), "should include relayed content");
  assert.ok(content.includes("Relayed Context"), "should have relay header");
  rmSync(dir, { recursive: true, force: true });
});

await test("CodexAdapter: exportContext reads AGENTS.md", async () => {
  const dir = makeTmpDir();
  writeFileSync(join(dir, "AGENTS.md"), `# Agent Config

- Run tests before commit
- Use conventional commits
`);
  const adapter = new CodexAdapter(dir, "codex-session");
  const blocks = await adapter.exportContext();
  assert.ok(blocks.length > 0, "should export blocks");
  assert.ok(blocks[0].sourceHarness === "codex", "sourceHarness should be codex");
  const allContent = blocks.map((b) => b.content).join(" ");
  assert.ok(allContent.includes("conventional commits"), "should include commit rule");
  rmSync(dir, { recursive: true, force: true });
});

await test("CodexAdapter: importContext appends to AGENTS.md", async () => {
  const dir = makeTmpDir();
  writeFileSync(join(dir, "AGENTS.md"), `# Original\n\n- Original rule`);
  const adapter = new CodexAdapter(dir, "codex-session");
  await adapter.importContext([
    { role: "assistant", content: "Claude Code found a bug in auth module", sourceHarness: "claude-code", timestamp: Date.now() },
  ], { mode: "append" });
  const content = readFileSync(join(dir, "AGENTS.md"), "utf-8");
  assert.ok(content.includes("Original rule"), "should keep original");
  assert.ok(content.includes("Claude Code found a bug"), "should include relayed content");
  rmSync(dir, { recursive: true, force: true });
});

await test("HermesAdapter: exportContext reads SOUL.md + MEMORY.md", async () => {
  const dir = makeTmpDir();
  writeFileSync(join(dir, "SOUL.md"), `# Hermes\n\nYou are a helpful agent.`);
  writeFileSync(join(dir, "MEMORY.md"), `# Memory\n\n- User prefers concise answers`);
  const adapter = new HermesAdapter(dir, "hermes-session");
  const blocks = await adapter.exportContext();
  assert.ok(blocks.length >= 2, "should export at least 2 blocks (soul + memory)");
  const allContent = blocks.map((b) => b.content).join(" ");
  assert.ok(allContent.includes("helpful agent"), "should include soul content");
  assert.ok(allContent.includes("concise answers"), "should include memory content");
  rmSync(dir, { recursive: true, force: true });
});

await test("QuarkAgentAdapter: exportContext reads from Memory", async () => {
  const dir = makeTmpDir();
  const db = new Database(join(dir, "t.db"));
  const mem = new SqliteMemory(db, { path: join(dir, "t.db") });
  await mem.add({
    userId: "u1",
    sessionId: "s1",
    kind: "chat",
    layer: "L0",
    content: "hello from quark",
    importance: 0.5,
  });
  const adapter = new QuarkAgentAdapter(dir, "s1", mem);
  const blocks = await adapter.exportContext({ lastN: 10 });
  assert.ok(blocks.length > 0, "should export blocks");
  assert.ok(blocks[0].sourceHarness === "quark-agent", "sourceHarness should be quark-agent");
  assert.ok(blocks[0].content.includes("hello from quark"), "should include message content");
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

await test("relayCrossHarness: Claude Code → Codex", async () => {
  const ccDir = makeTmpDir();
  const codexDir = makeTmpDir();
  // Set up Claude Code context
  writeFileSync(join(ccDir, "CLAUDE.md"), `# Project\n\n- Use TypeScript\n- Add tests\n- Handle errors`);
  // Set up Codex context
  writeFileSync(join(codexDir, "AGENTS.md"), `# Codex Config\n\n- Use conventional commits`);

  const source = new ClaudeCodeAdapter(ccDir, "cc-session");
  const target = new CodexAdapter(codexDir, "codex-session");
  const relay = new RelayService();

  const result = await relay.relayCrossHarness(source, target, { lastN: 10 }, { maxTokens: 2000 });

  assert.ok(result.relayedCount > 0, "should relay some blocks");
  assert.ok(result.sourceSessionId.includes("claude-code"), "source should be claude-code");
  assert.ok(result.targetSessionId.includes("codex"), "target should be codex");

  // Verify Codex AGENTS.md now has Claude Code context
  const codexContent = readFileSync(join(codexDir, "AGENTS.md"), "utf-8");
  assert.ok(codexContent.includes("TypeScript"), "Codex AGENTS.md should include TypeScript from Claude Code");
  assert.ok(codexContent.includes("Relayed Context"), "should have relay header");

  rmSync(ccDir, { recursive: true, force: true });
  rmSync(codexDir, { recursive: true, force: true });
});

await test("relayCrossHarness: Codex → Quark Agent Memory", async () => {
  const codexDir = makeTmpDir();
  const quarkDir = makeTmpDir();
  // Set up Codex context
  writeFileSync(join(codexDir, "AGENTS.md"), `# Codex\n\n- Use Rust for perf\n- Add benchmarks`);
  // Set up Quark Agent Memory
  const db = new Database(join(quarkDir, "t.db"));
  const mem = new SqliteMemory(db, { path: join(quarkDir, "t.db") });

  const source = new CodexAdapter(codexDir, "codex-session");
  const target = new QuarkAgentAdapter(quarkDir, "quark-session", mem);
  const relay = new RelayService(mem);

  const result = await relay.relayCrossHarness(source, target, { lastN: 10 }, { maxTokens: 2000 });

  assert.ok(result.relayedCount > 0, "should relay blocks");
  assert.ok(result.sourceSessionId.includes("codex"), "source should be codex");
  assert.ok(result.targetSessionId.includes("quark"), "target should be quark-agent");

  // Verify Quark Agent Memory now has Codex relayed context
  const relayedCtx = await relay.getRelayedContext("quark-session", 2000);
  assert.ok(relayedCtx.includes("Rust") || relayedCtx.includes("benchmarks"), "should include Codex content");

  db.close();
  rmSync(codexDir, { recursive: true, force: true });
  rmSync(quarkDir, { recursive: true, force: true });
});

await test("createHarnessAdapter: factory creates correct types", async () => {
  const dir = makeTmpDir();

  const ccAdapter = createHarnessAdapter("claude-code", dir, "s1");
  assert.ok(ccAdapter instanceof ClaudeCodeAdapter, "should create ClaudeCodeAdapter");
  assert.equal(ccAdapter.harnessId, "claude-code");

  const codexAdapter = createHarnessAdapter("codex", dir, "s2");
  assert.ok(codexAdapter instanceof CodexAdapter, "should create CodexAdapter");
  assert.equal(codexAdapter.harnessId, "codex");

  const hermesAdapter = createHarnessAdapter("hermes", dir, "s3");
  assert.ok(hermesAdapter instanceof HermesAdapter, "should create HermesAdapter");
  assert.equal(hermesAdapter.harnessId, "hermes");

  rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// Summary
// ============================================================================
console.log("\n" + "=".repeat(60));
const passed = RESULTS.filter((r) => r.ok).length;
const failed = RESULTS.length - passed;
console.log(`Cross-Harness Relay tests: ${passed}/${RESULTS.length} passed${failed ? `, ${failed} failed` : ""}`);
if (failed > 0) {
  console.log("\nFailures:");
  RESULTS.filter((r) => !r.ok).forEach((r) => console.log(`  - ${r.name}: ${r.err}`));
  process.exit(1);
}
process.exit(0);
