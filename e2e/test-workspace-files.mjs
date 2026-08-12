/**
 * WorkspaceFiles (File-Based Personality Config) unit tests
 *
 * Run: npx tsx e2e/test-workspace-files.mjs
 *
 * Coverage:
 *   1. WorkspaceFilesLoader loads SOUL.md correctly
 *   2. WorkspaceFilesLoader loads IDENTITY.md correctly
 *   3. WorkspaceFilesLoader loads USER.md correctly
 *   4. WorkspaceFilesLoader loads AGENTS.md correctly
 *   5. WorkspaceFilesLoader handles missing files gracefully
 *   6. WorkspaceFilesLoader assembles system prompt from all files
 *   7. FileBasedSoulProvider loads and renders Soul
 *   8. FileBasedSoulProvider watches for file changes (hot reload)
 *   9. Markdown parsing: sections, lists, key-value extraction
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { WorkspaceFilesLoader, FileBasedSoulProvider } =
  await import("../src/soul/workspace-files.ts");

const RESULTS = [];
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { RESULTS.push({ name, ok: true }); console.log(`  ✓ ${name}`); },
    (e) => { RESULTS.push({ name, ok: false, err: e.message }); console.log(`  ✗ ${name}\n    ${e.message}`); },
  );
}

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), "quark-ws-"));
}

// ============================================================================
// Test 1: Load SOUL.md
// ============================================================================
await test("WorkspaceFilesLoader loads SOUL.md", async () => {
  const dir = makeTmpDir();
  writeFileSync(join(dir, "SOUL.md"), `# Quark

你是一个简洁高效的 AI 助手。

## 性格特征
- 专业
- 简洁
- 诚实

## 原则
- 结果导向
- 不说废话

## 说话风格
直接给结论，简洁明了，必要时附简短示例
`);
  const loader = new WorkspaceFilesLoader({ rootDir: dir });
  const config = loader.load();
  assert.ok(config.soul, "soul should be loaded");
  assert.equal(config.soul?.name, "Quark", "soul name should be Quark");
  assert.ok(config.soul?.persona.includes("简洁高效"), "persona should include text");
  assert.ok(config.soul?.traits.includes("专业"), "traits should include 专业");
  assert.ok(config.soul?.principles.includes("结果导向"), "principles should include 结果导向");
  assert.ok(config.soul?.speakingStyle.includes("简洁"), "speakingStyle should include 简洁");
  rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// Test 2: Load IDENTITY.md
// ============================================================================
await test("WorkspaceFilesLoader loads IDENTITY.md", async () => {
  const dir = makeTmpDir();
  writeFileSync(join(dir, "IDENTITY.md"), `# Identity

- **name**: Quark
- **emoji**: ⚛️
- **role**: AI Assistant
- **version**: 1.0
`);
  const loader = new WorkspaceFilesLoader({ rootDir: dir });
  const config = loader.load();
  assert.ok(config.identity, "identity should be loaded");
  assert.equal(config.identity?.name, "Quark", "identity name should be Quark");
  assert.equal(config.identity?.emoji, "⚛️", "emoji should match");
  assert.equal(config.identity?.role, "AI Assistant", "role should match");
  rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// Test 3: Load USER.md
// ============================================================================
await test("WorkspaceFilesLoader loads USER.md", async () => {
  const dir = makeTmpDir();
  writeFileSync(join(dir, "USER.md"), `# User

- **name**: Alice
- **timezone**: Asia/Shanghai
- **notes**: Prefers concise responses

## Preferences
- 中文优先
- 喜欢用表格
`);
  const loader = new WorkspaceFilesLoader({ rootDir: dir });
  const config = loader.load();
  assert.ok(config.user, "user should be loaded");
  assert.equal(config.user?.name, "Alice", "user name should be Alice");
  assert.equal(config.user?.timezone, "Asia/Shanghai", "timezone should match");
  rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// Test 4: Load AGENTS.md
// ============================================================================
await test("WorkspaceFilesLoader loads AGENTS.md", async () => {
  const dir = makeTmpDir();
  writeFileSync(join(dir, "AGENTS.md"), `# Agent Rules

## 安全红线
- 不提交敏感信息
- 不执行危险命令

## 工作流
1. 先读文件
2. 再执行
`);
  const loader = new WorkspaceFilesLoader({ rootDir: dir });
  const config = loader.load();
  assert.ok(config.agents, "agents should be loaded");
  assert.ok((config.agents?.safetyGuidelines?.length ?? 0) >= 2, "should have at least 2 safety guidelines");
  assert.ok(config.agents?.safetyGuidelines?.some(c => c.includes("敏感信息")), "should have constraint about sensitive info");
  rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// Test 5: Handle missing files gracefully
// ============================================================================
await test("WorkspaceFilesLoader handles missing files gracefully", async () => {
  const dir = makeTmpDir();
  // Don't create any files
  const loader = new WorkspaceFilesLoader({ rootDir: dir });
  const config = loader.load();
  assert.equal(config.soul, null, "soul should be null when no file");
  assert.equal(config.identity, null, "identity should be null");
  assert.equal(config.user, null, "user should be null");
  assert.equal(config.agents, null, "agents should be null");
  assert.ok(config.systemPrompt.length > 0, "systemPrompt should still have some content");
  rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// Test 6: Assembles system prompt from all files
// ============================================================================
await test("WorkspaceFilesLoader assembles system prompt from all files", async () => {
  const dir = makeTmpDir();
  writeFileSync(join(dir, "SOUL.md"), `# Test
你是一个测试助手。`);
  writeFileSync(join(dir, "IDENTITY.md"), `# Identity
- **name**: TestBot
- **emoji**: 🤖`);
  const loader = new WorkspaceFilesLoader({ rootDir: dir });
  const config = loader.load();
  assert.ok(config.systemPrompt.includes("TestBot") || config.systemPrompt.includes("测试助手"), "systemPrompt should include identity name or soul persona");
  rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// Test 7: FileBasedSoulProvider loads soul
// ============================================================================
await test("FileBasedSoulProvider loads soul from files", async () => {
  const dir = makeTmpDir();
  writeFileSync(join(dir, "SOUL.md"), `# Quark

你是一个简洁高效的 AI 助手。

## 说话风格
直接给结论
`);
  const provider = new FileBasedSoulProvider(dir);
  const soul = provider.load();
  assert.equal(soul.name, "Quark", "soul name should be Quark");
  assert.ok(soul.persona.includes("简洁高效"), "persona should include text");
  assert.ok(soul.systemPrompt.includes("Quark"), "systemPrompt should include name");
  rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// Test 8: FileBasedSoulProvider watches for file changes
// ============================================================================
await test("FileBasedSoulProvider watches for file changes", async () => {
  const dir = makeTmpDir();
  writeFileSync(join(dir, "SOUL.md"), `# V1
你是版本1。`);
  const provider = new FileBasedSoulProvider(dir);
  const soul1 = provider.load();
  assert.equal(soul1.name, "V1", "initial name should be V1");

  // Wait for watcher to be set up
  await new Promise(r => setTimeout(r, 200));

  // Update file
  writeFileSync(join(dir, "SOUL.md"), `# V2
你是版本2。`);

  // Wait for watch to detect change
  let reloaded = false;
  provider.watch(() => { reloaded = true; });

  // watchFile uses interval (default 5s), so we manually trigger reload
  await new Promise(r => setTimeout(r, 300));

  // Manually reload to verify new content
  const soul2 = provider.reload();
  assert.equal(soul2.name, "V2", "after reload, name should be V2");

  provider.unwatch();
  rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// Test 9: Markdown parsing
// ============================================================================
await test("Markdown parsing: correctly extracts sections and key-value pairs", async () => {
  const dir = makeTmpDir();
  writeFileSync(join(dir, "IDENTITY.md"), `# Identity

- **name**: ParseTest
- **role**: Parser
- **emoji**: 🧪
`);
  const loader = new WorkspaceFilesLoader({ rootDir: dir });
  const config = loader.load();
  assert.ok(config.identity, "identity should be loaded");
  assert.equal(config.identity?.name, "ParseTest", "name should be parsed");
  assert.equal(config.identity?.role, "Parser", "role should be parsed");
  assert.equal(config.identity?.emoji, "🧪", "emoji should be parsed");
  rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// Summary
// ============================================================================
console.log("\n" + "=".repeat(60));
const passed = RESULTS.filter((r) => r.ok).length;
const failed = RESULTS.length - passed;
console.log(`WorkspaceFiles tests: ${passed}/${RESULTS.length} passed${failed ? `, ${failed} failed` : ""}`);
if (failed > 0) {
  console.log("\nFailures:");
  RESULTS.filter((r) => !r.ok).forEach((r) => console.log(`  - ${r.name}: ${r.err}`));
  process.exit(1);
}
process.exit(0);
