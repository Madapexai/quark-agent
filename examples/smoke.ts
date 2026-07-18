/**
 * 离线 smoke test：不依赖外部 LLM API，验证核心链路
 * - 沙箱执行
 * - 记忆写入 + 混合召回
 * - 技能注册 + 匹配
 * - tracer 记录 span
 */

import Database from "better-sqlite3";
import { VmSandbox } from "../src/sandbox/vm.js";
import { SqliteMemory } from "../src/memory/sqlite.js";
import { SqliteSkillStore } from "../src/skills/store.js";
import { InMemoryTracer, printSpanTree } from "../src/observe/tracing.js";
import { Agent } from "../src/core/agent.js";
import { pseudoEmbed } from "../src/provider/openai.js";
import { createSoul } from "../src/soul/index.js";
import { builtinTools } from "../src/tools/builtin.js";
import type { AgentDeps, Provider, ChatRequest, ChatResponse } from "../src/core/types.js";

// 假 provider：不联网，根据输入返回固定/工具调用回复
class FakeProvider implements Provider {
  readonly name = "fake";
  callCount = 0;
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.callCount++;
    // 第一次：要求调 code_exec 计算
    if (this.callCount === 1 && req.tools?.length) {
      return {
        content: "",
        toolCalls: [
          {
            id: "call_1",
            name: "code_exec",
            arguments: JSON.stringify({ code: "const fib=(n)=>n<2?n:fib(n-1)+fib(n-2); Array.from({length:10},(_,i)=>fib(i))" }),
          },
        ],
        model: "fake",
        finishReason: "tool_calls",
      };
    }
    // 第二次：返回包含计算结果的回答
    const toolMsg = [...req.messages].reverse().find((m) => m.role === "tool")?.content ?? "";
    return {
      content: `计算完成。${toolMsg.slice(0, 120)}\n斐波那契前10项是关键结果。`,
      model: "fake",
      finishReason: "stop",
    };
  }
  async embed(text: string): Promise<Float32Array> {
    return pseudoEmbed(text, 64);
  }
}

async function main(): Promise<void> {
  const db = new Database(":memory:");
  const sandbox = new VmSandbox();
  const memory = new SqliteMemory(db, { path: ":memory:" });
  const skills = new SqliteSkillStore(db);
  const tracer = new InMemoryTracer();
  const provider: Provider = new FakeProvider();
  const tools = builtinTools(memory);
  const soul = createSoul({
    id: "smoke",
    name: "Smoke",
    persona: "你是测试 agent。",
    traits: ["简洁"],
    principles: ["先调用工具验证"],
  });
  const deps: AgentDeps = { provider, memory, sandbox, tracer, soul, tools, skills };

  // 1. 记忆写入 + 召回
  await memory.add({ content: "用户喜欢简洁的代码示例", kind: "fact", layer: "L2", userId: "u1", importance: 0.8 });
  await memory.add({ content: "上次讨论了斐波那契数列的实现", kind: "chat", layer: "L0", userId: "u1", sessionId: "smoke", importance: 0.6 });
  const recalled = await memory.search({ query: "斐波那契", topK: 3, userId: "u1" });
  console.log("[memory] 召回", recalled.length, "条");
  console.log("  →", recalled[0]?.content.slice(0, 40));

  // 2. 技能注册 + 匹配
  await skills.add({
    id: "fib.explainer",
    name: "斐波那契讲解",
    trigger: "斐波那契, fibonacci, 数列",
    promptTemplate: "{{base}}\n\n[技能增强] 涉及斐波那契时优先用 code_exec 计算。",
    score: 0.9,
    invocations: 0,
    lastUsedAt: 0,
    createdAt: Date.now(),
  });
  const matched = await skills.match("帮我算斐波那契数列");
  console.log("[skills] 匹配", matched.length, "条 →", matched[0]?.id);

  // 3. Agent 跑一轮 tool-calling
  const agent = new Agent(
    { id: "smoke", name: "Smoke", model: "fake", maxToolRounds: 4, contextTokenBudget: 4000 },
    deps,
  );
  const result = await agent.run("帮我算斐波那契前10项", { userId: "u1", sessionId: "smoke", channel: "test" });
  console.log("[agent] reply:", result.reply.slice(0, 80));
  console.log("[agent] rounds=", result.rounds, "toolCalls=", result.toolCalls);

  // 4. 记忆中应有本次对话沉淀
  const after = await memory.search({ query: "斐波那契", topK: 5 });
  console.log("[memory] 对话后共", after.length, "条相关记忆");

  // 5. tracer
  const stats = tracer.stats();
  console.log("[tracer] span stats:", JSON.stringify(stats));
  console.log("[tracer] span tree:\n" + printSpanTree(tracer.export()));

  await memory.close();
  await sandbox.dispose();
  console.log("\n✅ smoke test 通过");
}

main().catch((e) => {
  console.error("❌ smoke test 失败:", e);
  process.exit(1);
});
