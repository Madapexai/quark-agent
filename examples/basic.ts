/**
 * 基础示例：用 createAgent 一行装配，跑一次问答 + 工具调用
 *
 * 运行：
 *   MICRO_API_KEY=sk-... npx tsx examples/basic.ts
 */

import { createAgent } from "../src/index.js";

async function main(): Promise<void> {
  const apiKey = process.env.MICRO_API_KEY;
  if (!apiKey) {
    console.error("请设置 MICRO_API_KEY");
    process.exit(1);
  }

  const { agent, close } = await createAgent({
    config: {
      id: "demo-agent",
      name: "Demo",
      model: process.env.MICRO_MODEL ?? "gpt-4o-mini",
      temperature: 0.5,
      maxToolRounds: 4,
      contextTokenBudget: 8000,
    },
    apiKey,
    baseURL: process.env.MICRO_BASE_URL ?? "https://api.openai.com/v1",
    dbPath: "./.data/demo.sqlite",
    enableSkills: true,
    enableSessions: true,
    soulSpec: {
      id: "default",
      name: "Demo",
      persona: "你是一个轻量 agent。需要计算时调用 code_exec 工具。回答简洁。",
      traits: ["简洁", "主动"],
      principles: ["需要计算时调用 code_exec"],
    },
  });

  const questions = [
    "用沙箱算一下斐波那契数列前 10 项，并解释结果。",
    "我刚才问你什么了？", // 测试记忆召回
  ];

  for (const q of questions) {
    console.log(`\n>>> ${q}`);
    const r = await agent.run(q, { userId: "demo-user", sessionId: "demo", channel: "cli" });
    console.log(`<<< ${r.reply}`);
    console.log(`    [rounds=${r.rounds} toolCalls=${r.toolCalls} recovered=${r.recovered}]`);
  }

  await close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
