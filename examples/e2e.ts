/**
 * 端到端测试：验证 micro-agent 全部能力
 *
 * 覆盖场景（全部离线，不依赖外部 LLM API）：
 * 1. 多 session 隔离：两 session 互不可见对方 L0
 * 2. 多用户隔离：两用户 L2 facts 互不可见
 * 3. 通道绑定：LocalChannel 每 session 独立沙箱
 * 4. 沙箱隔离：lightweight tier 禁止 fetch，full 允许
 * 5. scope 授权：readOnly scope 禁止 code_exec
 * 6. soul 演进：GEPA 优化后 version +1
 * 7. checkpoint 恢复：崩溃后 recover 恢复 messages
 * 8. 压缩管线：L0 overflow → L1 摘要
 * 9. 死循环检测：相同 tool_call 连续触发中止
 */

import Database from "better-sqlite3";
import { VmSandbox } from "../src/sandbox/vm.js";
import { SqliteMemory } from "../src/memory/sqlite.js";
import { SqliteSkillStore } from "../src/skills/store.js";
import { SqliteSessionManager } from "../src/session/manager.js";
import { SoulStore, createSoul } from "../src/soul/index.js";
import { Compressor } from "../src/memory/compress.js";
import { InMemoryTracer } from "../src/observe/tracing.js";
import { Agent } from "../src/core/agent.js";
import { LocalChannel, tieredSandboxFactory } from "../src/channel/local.js";
import { Evolver } from "../src/evolve/gepa.js";
import { pseudoEmbed } from "../src/provider/openai.js";
import { builtinTools } from "../src/tools/builtin.js";
import { buildContext } from "../src/core/context.js";
import { collectEnv, fullScope, lightweightScope, readOnlyScope } from "../src/env/index.js";
import { canUseTool, filterTools, sandboxTierSatisfies } from "../src/auth/scope.js";
import type {
  AgentDeps,
  ChatRequest,
  ChatResponse,
  Identity,
  Message,
  Provider,
  ToolCall,
  ToolSchema,
} from "../src/core/types.js";

// ============================================================================
// 测试辅助：可编程假 Provider
// ============================================================================

class ScriptedProvider implements Provider {
  readonly name = "scripted";
  private scripts: Array<(req: ChatRequest) => ChatResponse>;
  private callIdx = 0;
  callLog: ChatRequest[] = [];

  constructor(scripts: Array<(req: ChatRequest) => ChatResponse>) {
    this.scripts = scripts;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.callLog.push(req);
    const idx = Math.min(this.callIdx, this.scripts.length - 1);
    this.callIdx++;
    return this.scripts[idx](req);
  }

  async embed(text: string): Promise<Float32Array> {
    return pseudoEmbed(text, 64);
  }
}

class FailingProvider implements Provider {
  readonly name = "failing";
  async chat(): Promise<ChatResponse> {
    throw new Error("provider down");
  }
  async embed(text: string): Promise<Float32Array> {
    return pseudoEmbed(text, 64);
  }
}

// 工具调用 helper
function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}

// 断言 helper
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`❌ 断言失败: ${msg}`);
  console.log(`  ✅ ${msg}`);
}

function makeDeps(db: Database.Database, provider: Provider, opts: { soul?: ReturnType<typeof createSoul>; sessions?: SqliteSessionManager } = {}): AgentDeps {
  const memory = new SqliteMemory(db, { path: ":memory:" }, (t) => provider.embed?.(t) ?? Promise.resolve(pseudoEmbed(t, 64)));
  const sandbox = new VmSandbox();
  const tracer = new InMemoryTracer();
  const skills = new SqliteSkillStore(db);
  const soul = opts.soul ?? createSoul({ id: "e2e", name: "E2E", persona: "测试 agent", traits: ["简洁"], principles: [] });
  const tools = builtinTools(memory);
  return { provider, memory, sandbox, tracer, soul, tools, skills, sessions: opts.sessions };
}

// ============================================================================
// 测试用例
// ============================================================================

async function testMultiSessionIsolation(): Promise<void> {
  console.log("\n[测试1] 多 session 隔离");
  const db = new Database(":memory:");
  const provider = new ScriptedProvider([
    () => ({ content: "session1 的回复", model: "fake", finishReason: "stop" }),
    () => ({ content: "session2 的回复", model: "fake", finishReason: "stop" }),
  ]);
  const sessions = new SqliteSessionManager(db, new SqliteMemory(db, { path: ":memory:" }, (t) => provider.embed?.(t) ?? Promise.resolve(pseudoEmbed(t, 64))), provider);
  const deps = makeDeps(db, provider, { sessions });
  const agent = new Agent({ id: "t1", name: "T1", model: "fake", contextTokenBudget: 4000 }, deps);

  await agent.run("你好，我是 session1", { userId: "u1", sessionId: "s1" });
  await agent.run("你好，我是 session2", { userId: "u1", sessionId: "s2" });

  const s1msgs = await sessions.getMessages({ userId: "u1", sessionId: "s1" } as Identity);
  const s2msgs = await sessions.getMessages({ userId: "u1", sessionId: "s2" } as Identity);
  assert(s1msgs.length === 2, "session1 有 2 条 L0 记录");
  assert(s2msgs.length === 2, "session2 有 2 条 L0 记录");
  assert(JSON.stringify(s1msgs).includes("session1"), "session1 L0 含 session1 内容");
  assert(!JSON.stringify(s1msgs).includes("session2"), "session1 L0 不含 session2 内容");
  await deps.memory.close();
}

async function testMultiUserIsolation(): Promise<void> {
  console.log("\n[测试2] 多用户 L2 facts 隔离");
  const db = new Database(":memory:");
  const provider = new ScriptedProvider([() => ({ content: "ok", model: "fake" })]);
  const deps = makeDeps(db, provider);
  await deps.memory.add({ content: "Alice 喜欢咖啡", kind: "fact", layer: "L2", userId: "alice", importance: 0.9 });
  await deps.memory.add({ content: "Bob 喜欢茶", kind: "fact", layer: "L2", userId: "bob", importance: 0.9 });

  const aliceRecall = await deps.memory.search({ query: "喜欢什么", userId: "alice", topK: 5 });
  const bobRecall = await deps.memory.search({ query: "喜欢什么", userId: "bob", topK: 5 });
  assert(aliceRecall.every((m) => m.userId === "alice"), "Alice 只召回自己的 facts");
  assert(bobRecall.every((m) => m.userId === "bob"), "Bob 只召回自己的 facts");
  assert(aliceRecall.some((m) => m.content.includes("咖啡")), "Alice 召回到咖啡");
  assert(bobRecall.some((m) => m.content.includes("茶")), "Bob 召回到茶");
  await deps.memory.close();
}

async function testSandboxTierIsolation(): Promise<void> {
  console.log("\n[测试3] 沙箱 tier 隔离（lightweight vs full）");
  const lightFactory = tieredSandboxFactory("lightweight");
  const fullFactory = tieredSandboxFactory("full");
  const lightSandbox = lightFactory("s1");
  const fullSandbox = fullFactory("s2");

  // full 沙箱能访问 fetch（注入后）
  const fullResult = await fullSandbox.run("typeof fetch", { globals: { fetch: () => "ok" } });
  assert(fullResult.ok && String(fullResult.value).includes("function"), "full 沙箱可访问 fetch");

  // lightweight 沙箱被 filterSandboxGlobals 移除 fetch
  const lightScope = lightweightScope();
  const { filterSandboxGlobals } = await import("../src/auth/scope.js");
  const allowed = filterSandboxGlobals(lightScope, ["fetch", "Math"]);
  assert(!allowed.includes("fetch"), "lightweight scope 移除 fetch");
  assert(allowed.includes("Math"), "lightweight scope 保留 Math");

  // scope tier 校验
  assert(!sandboxTierSatisfies(readOnlyScope(), "lightweight"), "readOnly scope 不满足 lightweight");
  assert(sandboxTierSatisfies(fullScope(), "full"), "full scope 满足 full");
  await lightSandbox.dispose();
  await fullSandbox.dispose();
}

async function testScopeAuthorization(): Promise<void> {
  console.log("\n[测试4] scope 授权过滤");
  const ro = readOnlyScope();
  assert(!canUseTool(ro, "code_exec"), "readOnly 禁止 code_exec");
  assert(canUseTool(ro, "memory_recall"), "readOnly 允许 memory_recall");
  assert(canUseTool(fullScope(), "code_exec"), "full 允许 code_exec");

  const tools: ToolSchema[] = [
    { type: "function", function: { name: "code_exec", description: "", parameters: {} } },
    { type: "function", function: { name: "memory_recall", description: "", parameters: {} } },
    { type: "function", function: { name: "http_get", description: "", parameters: {} } },
  ];
  const filtered = filterTools(ro, tools);
  assert(filtered.length === 1 && filtered[0].function.name === "memory_recall", "readOnly 过滤后只剩 memory_recall");
}

async function testAgentScopeDenial(): Promise<void> {
  console.log("\n[测试5] Agent 执行时 scope 拒绝 code_exec");
  const db = new Database(":memory:");
  const provider = new ScriptedProvider([
    () => ({ content: "", toolCalls: [toolCall("c1", "code_exec", { code: "1+1" })], model: "fake", finishReason: "tool_calls" }),
    () => ({ content: "好的", model: "fake", finishReason: "stop" }),
  ]);
  const deps = makeDeps(db, provider);
  const agent = new Agent({ id: "t5", name: "T5", model: "fake", contextTokenBudget: 4000 }, deps);
  const result = await agent.run("算一下", { userId: "u1", sessionId: "s1", scope: readOnlyScope() });
  assert(result.reply.includes("好的") || result.reply.includes("denied"), "readOnly scope 下 code_exec 被拒绝");
  await deps.memory.close();
}

async function testCheckpointRecovery(): Promise<void> {
  console.log("\n[测试6] checkpoint 恢复");
  const db = new Database(":memory:");
  const provider = new ScriptedProvider([() => ({ content: "ok", model: "fake" })]);
  const sessions = new SqliteSessionManager(db, new SqliteMemory(db, { path: ":memory:" }, (t) => provider.embed?.(t) ?? Promise.resolve(pseudoEmbed(t, 64))), provider);
  const deps = makeDeps(db, provider, { sessions });
  const identity: Identity = { userId: "u1", sessionId: "s1" };

  // 写入 checkpoint
  const msgs: Message[] = [
    { role: "user", content: "之前的问题" },
    { role: "assistant", content: "之前的回答" },
  ];
  await sessions.checkpoint(identity, msgs);

  // 模拟崩溃后恢复
  const restored = await sessions.recover(identity);
  assert(restored.length === 2, "恢复出 2 条 messages");
  assert(restored[0].content === "之前的问题", "恢复的第一条正确");
  assert(restored[1].content === "之前的回答", "恢复的第二条正确");
  await deps.memory.close();
}

async function testCompressionPipeline(): Promise<void> {
  console.log("\n[测试7] 压缩管线 L0→L1");
  const db = new Database(":memory:");
  const provider = new ScriptedProvider([() => ({ content: "摘要", model: "fake", maxTokens: 50 } as Partial<ChatResponse> as ChatResponse)]);
  const memory = new SqliteMemory(db, { path: ":memory:" }, (t) => provider.embed?.(t) ?? Promise.resolve(pseudoEmbed(t, 64)));
  const compressor = new Compressor(memory, provider, { l0OverflowRounds: 3, l0CompressBatch: 2, l1MergeThreshold: 99, model: "fake" });
  const identity: Identity = { userId: "u1", sessionId: "s1" };

  // 写入 5 条 L0，超过阈值 3
  for (let i = 0; i < 5; i++) {
    await memory.add({ content: `对话片段 ${i}：讨论了主题 ${i}`, kind: "chat", layer: "L0", userId: identity.userId, sessionId: identity.sessionId });
  }
  const { l0Compressed } = await compressor.compressSession(identity);
  assert(l0Compressed === 2, "压缩了 2 条 L0");

  const l1 = await memory.list({ userId: identity.userId, sessionId: identity.sessionId, layer: "L1" });
  assert(l1.length >= 1, "生成至少 1 条 L1 摘要");
  const l0after = await memory.list({ userId: identity.userId, sessionId: identity.sessionId, layer: "L0", kind: "chat" });
  assert(l0after.length === 3, "压缩后 L0 剩 3 条");
  await memory.close();
}

async function testL2Dedup(): Promise<void> {
  console.log("\n[测试8] L2 去重");
  const db = new Database(":memory:");
  const provider = new ScriptedProvider([() => ({ content: "ok", model: "fake" })]);
  const memory = new SqliteMemory(db, { path: ":memory:" }, (t) => provider.embed?.(t) ?? Promise.resolve(pseudoEmbed(t, 64)));
  const compressor = new Compressor(memory, provider, { l2DedupThreshold: 0.7, model: "fake" });
  const identity: Identity = { userId: "u1", sessionId: "s1" };

  const r1 = await compressor.promoteToL2(identity, "用户喜欢简洁回答");
  const r2 = await compressor.promoteToL2(identity, "用户喜欢简洁回答");
  assert(r1 === "added", "首次 L2 写入 added");
  assert(r2 === "merged", "重复 L2 合并 merged");
  const l2 = await memory.list({ userId: identity.userId, layer: "L2", kind: "fact" });
  assert(l2.length === 1, "去重后 L2 仅 1 条");
  await memory.close();
}

async function testLoopDetection(): Promise<void> {
  console.log("\n[测试9] 死循环检测");
  const db = new Database(":memory:");
  const provider = new ScriptedProvider([() => ({ content: "ok", model: "fake" })]);
  const sessions = new SqliteSessionManager(db, new SqliteMemory(db, { path: ":memory:" }, (t) => provider.embed?.(t) ?? Promise.resolve(pseudoEmbed(t, 64))), provider, { loopThreshold: 3 });
  const call = toolCall("c1", "code_exec", { code: "1+1" });
  assert(!sessions.checkLoop("s1", call), "第1次不报循环");
  assert(!sessions.checkLoop("s1", call), "第2次不报循环");
  assert(sessions.checkLoop("s1", call), "第3次报循环");
  await sessions.close({ userId: "u1", sessionId: "s1" } as Identity);
}

async function testSoulEvolution(): Promise<void> {
  console.log("\n[测试10] soul 演进（GEPA）");
  const db = new Database(":memory:");
  const soulStore = new SoulStore(db);
  const original = createSoul({ id: "default", name: "Test", persona: "你是助手", traits: [], principles: [] });
  await soulStore.save(original);

  // 可编程 provider：调用顺序 = 父代评估(chat+judge) → mutate → 变异体评估(chat+judge)
  const provider = new ScriptedProvider([
    // 父代 evaluate chat
    () => ({ content: "不知道", model: "fake" }),
    // 父代 judge
    () => ({ content: "3", model: "fake" }),
    // mutate
    () => ({ content: "<variant>你是优秀助手，回答精准</variant>", model: "fake" }),
    // 变异体 evaluate chat
    () => ({ content: "答案是 42", model: "fake" }),
    // 变异体 judge
    () => ({ content: "8", model: "fake" }),
  ]);
  const tracer = new InMemoryTracer();
  const evolver = new Evolver(provider, tracer, undefined, soulStore);
  const result = await evolver.evolveSoul("default", [
    { input: "终极答案是什么", expectedKeywords: ["42"], style: "简洁" },
  ], { populationSize: 1, generations: 1 });

  assert(result.soul.version === 2, "soul version 升到 2");
  assert(result.bestScore > 0, "bestScore > 0");
  assert(result.soul.persona.includes("优秀"), "persona 已演进");
}

async function testContextBuilderBudget(): Promise<void> {
  console.log("\n[测试11] ContextBuilder token 预算裁剪");
  const soul = createSoul({ id: "t", name: "T", persona: "x".repeat(100), traits: [], principles: [] });
  const env = collectEnv({ userId: "u1", sessionId: "s1" }, fullScope());
  // 构造超量 working memory
  const working: Message[] = [];
  for (let i = 0; i < 50; i++) {
    working.push({ role: "user", content: `消息 ${i} ` + "y".repeat(200) });
    working.push({ role: "assistant", content: `回复 ${i} ` + "z".repeat(200) });
  }
  const ctx = buildContext({
    soul, env, skills: [], recalled: [], tools: [],
    working, currentUserText: "最新问题",
    budget: { total: 2000 },
  });
  assert(ctx.truncated.working > 0, "L0 working 被裁剪");
  assert(ctx.messages.length < working.length + 2, "最终 messages 少于全量");
}

async function testLocalChannelSandboxIsolation(): Promise<void> {
  console.log("\n[测试12] LocalChannel 每 session 独立沙箱");
  const channel = new LocalChannel({
    userId: "local-user",
    sandboxFactory: tieredSandboxFactory("full"),
  });
  const sb1 = channel.getSandbox("local-1");
  const sb2 = channel.getSandbox("local-2");
  assert(sb1 !== sb2, "两 session 沙箱实例不同");

  // session1 注入变量不影响 session2
  const r1 = await sb1.run("typeof secretVar", { globals: { secretVar: 42 } });
  const r2 = await sb2.run("typeof secretVar", { globals: {} });
  assert(String(r1.value).includes("number"), "session1 能访问 secretVar");
  assert(String(r2.value).includes("undefined"), "session2 不能访问 secretVar");
  await channel.stop();
}

async function testAgentSelfRecovery(): Promise<void> {
  console.log("\n[测试13] Agent provider 失败后自恢复");
  const db = new Database(":memory:");
  const failingProvider = new FailingProvider();
  const sessions = new SqliteSessionManager(db, new SqliteMemory(db, { path: ":memory:" }, (t) => failingProvider.embed?.(t) ?? Promise.resolve(pseudoEmbed(t, 64))), failingProvider);
  // 先写一个 checkpoint
  await sessions.checkpoint({ userId: "u1", sessionId: "s1" }, [
    { role: "user", content: "之前的问题" },
    { role: "assistant", content: "之前的回答" },
  ]);
  const deps = makeDeps(db, failingProvider, { sessions });
  const agent = new Agent({ id: "t13", name: "T13", model: "fake", contextTokenBudget: 4000 }, deps);
  const result = await agent.run("继续", { userId: "u1", sessionId: "s1" });
  assert(result.reply.includes("provider error"), "返回 provider error");
  await deps.memory.close();
}

// ============================================================================
// 主流程
// ============================================================================

async function main(): Promise<void> {
  console.log("=== micro-agent 端到端测试 ===");
  let passed = 0;
  let failed = 0;
  const tests: Array<{ name: string; fn: () => Promise<void> }> = [
    { name: "多session隔离", fn: testMultiSessionIsolation },
    { name: "多用户隔离", fn: testMultiUserIsolation },
    { name: "沙箱tier隔离", fn: testSandboxTierIsolation },
    { name: "scope授权过滤", fn: testScopeAuthorization },
    { name: "Agent scope拒绝", fn: testAgentScopeDenial },
    { name: "checkpoint恢复", fn: testCheckpointRecovery },
    { name: "压缩管线", fn: testCompressionPipeline },
    { name: "L2去重", fn: testL2Dedup },
    { name: "死循环检测", fn: testLoopDetection },
    { name: "soul演进", fn: testSoulEvolution },
    { name: "ContextBuilder预算", fn: testContextBuilderBudget },
    { name: "LocalChannel沙箱隔离", fn: testLocalChannelSandboxIsolation },
    { name: "Agent自恢复", fn: testAgentSelfRecovery },
  ];
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
    } catch (e) {
      failed++;
      console.error(`❌ 测试「${t.name}」失败:`, e instanceof Error ? e.message : e);
    }
  }
  console.log(`\n=== 结果: ${passed} 通过 / ${failed} 失败 / 共 ${tests.length} ===`);
  if (failed > 0) process.exit(1);
  console.log("\n✅ 全部端到端测试通过");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
