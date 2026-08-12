/**
 * RelayService unit tests
 *
 * Run: npx tsx e2e/test-relay.mjs
 *
 * Coverage:
 *   1. relay() — 从 source session 读取消息并注入 target
 *   2. relay() — 空消息时不报错
 *   3. relay() — lastN 截取正确数量
 *   4. relay() — 脱敏正则生效
 *   5. relay() — 关键词过滤
 *   6. getRelayedContext() — 读取注入的 context block
 *   7. getRelayedContext() — token 预算截断
 *   8. createRelayTool() — 工具 schema 正确
 *   9. createRelayTool() — execute 调用 relay
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const { SqliteMemory } = await import("../src/memory/sqlite.ts");
const { RelayService, createRelayTool } = await import("../src/relay/index.ts");

const RESULTS = [];
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { RESULTS.push({ name, ok: true }); console.log(`  ✓ ${name}`); },
    (e) => { RESULTS.push({ name, ok: false, err: e.message }); console.log(`  ✗ ${name}\n    ${e.message}`); },
  );
}

function makeMem() {
  const dir = mkdtempSync(join(tmpdir(), "quark-relay-"));
  const db = new Database(join(dir, "t.db"));
  const mem = new SqliteMemory(db, { path: join(dir, "t.db") });
  return { dir, db, mem };
}

function cleanup(dir, db) {
  try { db?.close(); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ============================================================================
// Tests
// ============================================================================

await test("relay() — 从 source session 读取消息并注入 target", async () => {
  const { dir, db, mem } = makeMem();

  // 写入 source session 的消息
  const sourceSession = "feishu:group:A";
  const targetSession = "feishu:group:B";

  for (let i = 0; i < 5; i++) {
    await mem.add({
      userId: "u1",
      sessionId: sourceSession,
      kind: "chat",
      layer: "L0",
      content: `user: 这是飞书A群的第${i + 1}条消息`,
    });
  }

  const relay = new RelayService(mem);
  const result = await relay.relay({
    source: { sessionId: sourceSession, channel: "feishu", range: { lastN: 5 } },
    target: { sessionId: targetSession, userId: "u1" },
    policy: { includeSenderInfo: true },
  });

  assert.equal(result.relayedCount, 5, "should relay 5 messages");
  assert.ok(result.contextBlock.includes("飞书A群"), "context should include source text");
  assert.ok(result.contextBlock.includes("feishu"), "context should include channel");
  assert.ok(result.tokenCount > 0, "should have token count");

  // 验证 target session 有 relayed context
  const relayed = await relay.getRelayedContext(targetSession);
  assert.ok(relayed.includes("飞书A群"), "target should have relayed context");
  assert.ok(relayed.includes("Relayed Context"), "should have relay header");

  cleanup(dir, db);
});

await test("relay() — 空消息时不报错", async () => {
  const { dir, db, mem } = makeMem();
  const relay = new RelayService(mem);

  const result = await relay.relay({
    source: { sessionId: "nonexistent", range: { lastN: 10 } },
    target: { sessionId: "target" },
  });

  assert.equal(result.relayedCount, 0, "should relay 0 messages");
  assert.equal(result.contextBlock, "", "context should be empty");

  cleanup(dir, db);
});

await test("relay() — lastN 截取正确数量", async () => {
  const { dir, db, mem } = makeMem();

  // 写入 10 条消息
  for (let i = 0; i < 10; i++) {
    await mem.add({
      userId: "u1",
      sessionId: "src",
      kind: "chat",
      layer: "L0",
      content: `user: 消息${i}`,
    });
  }

  const relay = new RelayService(mem);
  const result = await relay.relay({
    source: { sessionId: "src", range: { lastN: 3 } },
    target: { sessionId: "tgt" },
  });

  assert.equal(result.relayedCount, 3, "should relay only 3 messages");
  assert.ok(result.contextBlock.includes("消息7"), "should include message 7");
  assert.ok(result.contextBlock.includes("消息9"), "should include message 9");

  cleanup(dir, db);
});

await test("relay() — 脱敏正则生效", async () => {
  const { dir, db, mem } = makeMem();

  await mem.add({
    userId: "u1",
    sessionId: "src",
    kind: "chat",
    layer: "L0",
    content: "user: 我的手机号是13800138000",
  });

  const relay = new RelayService(mem);
  const result = await relay.relay({
    source: { sessionId: "src", range: { lastN: 1 } },
    target: { sessionId: "tgt" },
    policy: {
      redactPatterns: [{ pattern: "\\d{11}", replacement: "[手机号]" }],
    },
  });

  assert.ok(result.contextBlock.includes("[手机号]"), "should redact phone number");
  assert.ok(!result.contextBlock.includes("13800138000"), "should not include raw phone");

  cleanup(dir, db);
});

await test("relay() — 关键词过滤", async () => {
  const { dir, db, mem } = makeMem();

  await mem.add({
    userId: "u1", sessionId: "src", kind: "chat", layer: "L0",
    content: "user: 聊聊薪资",
  });
  await mem.add({
    userId: "u1", sessionId: "src", kind: "chat", layer: "L0",
    content: "user: 天气不错",
  });

  const relay = new RelayService(mem);
  const result = await relay.relay({
    source: { sessionId: "src", range: { lastN: 10 } },
    target: { sessionId: "tgt" },
    policy: { filterKeywords: ["薪资"] },
  });

  assert.equal(result.relayedCount, 1, "should only relay 1 message with keyword");
  assert.ok(result.contextBlock.includes("薪资"), "should include the filtered message");
  assert.ok(!result.contextBlock.includes("天气"), "should not include non-matching message");

  cleanup(dir, db);
});

await test("getRelayedContext() — 读取注入的 context block", async () => {
  const { dir, db, mem } = makeMem();
  const relay = new RelayService(mem);

  // 手动注入 relayed context
  await mem.add({
    userId: "u1", sessionId: "tgt", kind: "chat", layer: "L1",
    content: "[Relayed Context — 来源: feishu:src — 3条消息]\nuser: 重要讨论",
    domain: "relay",
    importance: 0.8,
    meta: { relayedAt: Date.now(), sourceSessionId: "feishu:src" },
  });

  const context = await relay.getRelayedContext("tgt");
  assert.ok(context.includes("重要讨论"), "should include relayed content");
  assert.ok(context.includes("Relayed Context"), "should have relay header");

  // 不存在的 session
  const empty = await relay.getRelayedContext("nonexistent");
  assert.equal(empty, "", "should return empty for non-existent session");

  cleanup(dir, db);
});

await test("getRelayedContext() — token 预算截断", async () => {
  const { dir, db, mem } = makeMem();
  const relay = new RelayService(mem);

  // 注入大量 relayed context
  const longContent = "这是一段很长的消息。" .repeat(100);
  await mem.add({
    userId: "u1", sessionId: "tgt", kind: "chat", layer: "L1",
    content: longContent, domain: "relay",
    meta: { relayedAt: Date.now() },
  });

  // 用很小的预算
  const context = await relay.getRelayedContext("tgt", 50);
  const tokens = Math.ceil(context.length / 4);
  assert.ok(tokens <= 60, "should respect token budget (with small margin)");

  cleanup(dir, db);
});

await test("createRelayTool() — 工具 schema 正确", async () => {
  const { dir, db, mem } = makeMem();
  const relay = new RelayService(mem);
  const tool = createRelayTool({ relayService: relay });

  assert.equal(tool.name, "sync_context", "tool name should be sync_context");
  assert.ok(tool.schema, "should have schema");
  assert.ok(tool.schema.function?.parameters, "should have parameters");
  assert.ok(tool.execute, "should have execute function");

  cleanup(dir, db);
});

await test("createRelayTool() — execute 调用 relay", async () => {
  const { dir, db, mem } = makeMem();

  // 写入 source 消息
  for (let i = 0; i < 3; i++) {
    await mem.add({
      userId: "u1", sessionId: "feishu:group:A", kind: "chat", layer: "L0",
      content: `user: A群消息${i}`,
    });
  }

  const relay = new RelayService(mem);
  const tool = createRelayTool({ relayService: relay });

  const result = await tool.execute(
    { source_channel: "feishu", source_session_id: "feishu:group:A", last_n: 3 },
    {
      agent: { id: "test", name: "test" },
      deadline: Date.now() + 60000,
      meta: { identity: { sessionId: "feishu:group:B", userId: "u1" } },
    },
  );

  assert.ok(result.includes("[relay]"), "should return relay result");
  assert.ok(result.includes("3 条消息"), "should report 3 messages relayed");

  cleanup(dir, db);
});

// ============================================================================
// Summary
// ============================================================================
console.log("\n" + "=".repeat(60));
const passed = RESULTS.filter((r) => r.ok).length;
const failed = RESULTS.length - passed;
console.log(`Relay tests: ${passed}/${RESULTS.length} passed${failed ? `, ${failed} failed` : ""}`);
if (failed > 0) {
  console.log("\nFailures:");
  RESULTS.filter((r) => !r.ok).forEach((r) => console.log(`  - ${r.name}: ${r.err}`));
  process.exit(1);
}
process.exit(0);
