/**
 * ContextBuilder —— 7 层上下文组装 + token 预算裁剪
 *
 * 组装顺序（从稳到动，利于 prefix caching）：
 * 1. soul.systemPrompt   人格 base
 * 2. env                 时间/身份/权限
 * 3. skills              命中注入的 prompt 模板
 * 4. RAG/memory          L2 facts + L1 summary 召回
 * 5. tool schemas        scope 过滤后的工具声明
 * 6. L0 working memory   最近 K 轮对话
 * 7. current input       本轮输入（由 Agent 注入）
 *
 * token 预算分配：soul/env/skills 15% | RAG 25% | tools 10% | L0 40% | 输出 10%
 * 超预算时从最动态的层（L0 → RAG）开始裁剪。
 */

import type {
  EnvInfo,
  MemoryEntry,
  Message,
  Skill,
  Soul,
  ToolSchema,
} from "./types.js";
import { estimateTokens } from "../memory/compress.js";

export interface ContextBudget {
  /** 总预算 token */
  total: number;
  soul: number;
  env: number;
  skills: number;
  rag: number;
  tools: number;
  working: number;
  output: number;
}

export const DEFAULT_BUDGET_RATIO = {
  soul: 0.08,
  env: 0.05,
  skills: 0.07,
  rag: 0.25,
  tools: 0.1,
  working: 0.35,
  output: 0.1,
};

export interface BuildContextInput {
  soul: Soul;
  env: EnvInfo;
  skills: Skill[];
  recalled: MemoryEntry[]; // RAG 召回（L2 facts + L1 summary）
  tools: ToolSchema[]; // 已经过 scope 过滤
  working: Message[]; // L0 working memory
  currentUserText: string;
  budget?: Partial<ContextBudget>;
}

export interface BuiltContext {
  systemPrompt: string;
  messages: Message[];
  /** 各层实际 token 占用 */
  usage: Record<string, number>;
  /** 被裁剪掉的条数 */
  truncated: { working: number; rag: number };
}

export function computeBudget(total: number, overrides?: Partial<ContextBudget>): ContextBudget {
  const r = { ...DEFAULT_BUDGET_RATIO, ...(overrides ?? {}) };
  return {
    total,
    soul: Math.floor(total * r.soul),
    env: Math.floor(total * r.env),
    skills: Math.floor(total * r.skills),
    rag: Math.floor(total * r.rag),
    tools: Math.floor(total * r.tools),
    working: Math.floor(total * r.working),
    output: Math.floor(total * r.output),
  };
}

export function buildContext(input: BuildContextInput): BuiltContext {
  const total = input.budget?.total ?? 8000;
  const budget = computeBudget(total, input.budget);
  const usage: Record<string, number> = {};
  const truncated = { working: 0, rag: 0 };

  // 1. soul
  const soulText = input.soul.systemPrompt;
  usage.soul = estimateTokens(soulText);

  // 2. env
  const envText = renderEnvBlock(input.env);
  usage.env = estimateTokens(envText);

  // 3. skills（注入 prompt 模板，{{base}} 由 soul 替换）
  let skillsText = "";
  for (const s of input.skills) {
    const t = s.promptTemplate.replace("{{base}}", "").trim();
    if (estimateTokens(skillsText + t) <= budget.skills) {
      skillsText += `\n\n[技能:${s.name}]\n${t}`;
    }
  }
  usage.skills = estimateTokens(skillsText);

  // 4. RAG —— 按 budget 裁剪，低分先丢
  const ragSorted = [...input.recalled].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));
  const ragLines: string[] = [];
  let ragTokens = 0;
  for (const m of ragSorted) {
    const line = `[${m.layer}] ${m.content.slice(0, 300)}`;
    const t = estimateTokens(line);
    if (ragTokens + t > budget.rag) {
      truncated.rag++;
      continue;
    }
    ragLines.push(line);
    ragTokens += t;
  }
  usage.rag = ragTokens;
  const ragText = ragLines.length > 0 ? `\n\n[相关记忆]\n${ragLines.join("\n")}` : "";

  // 5. tools —— 由 Agent 透传，这里只统计
  usage.tools = input.tools.reduce((s, t) => s + estimateTokens(JSON.stringify(t)), 0);

  // 6. L0 working —— 从最新往回填，超预算丢最旧的
  const workingReversed = [...input.working].reverse();
  const keptWorking: Message[] = [];
  let workingTokens = 0;
  for (const m of workingReversed) {
    const t = estimateTokens(m.content);
    if (workingTokens + t > budget.working) break;
    keptWorking.unshift(m);
    workingTokens += t;
  }
  truncated.working = input.working.length - keptWorking.length;
  usage.working = workingTokens;

  // 组装 system prompt：soul + env + skills + RAG
  const systemPrompt = [soulText, envText, skillsText, ragText]
    .filter((s) => s.trim().length > 0)
    .join("\n");

  // messages：system + L0 working + current input
  const messages: Message[] = [
    { role: "system", content: systemPrompt },
    ...keptWorking.filter((m) => m.role !== "system"),
    { role: "user", content: input.currentUserText },
  ];

  return { systemPrompt, messages, usage, truncated };
}

function renderEnvBlock(env: EnvInfo): string {
  const lines = [
    `[环境]`,
    `时间: ${env.now} (${env.timezone})`,
    `用户: ${env.userId} | 会话: ${env.sessionId}${env.channel ? ` | 通道: ${env.channel}` : ""}`,
    `权限: tools=${Array.isArray(env.scope.tools) ? env.scope.tools.join(",") : env.scope.tools} sandbox=${env.scope.sandboxTier}`,
  ];
  for (const [k, v] of Object.entries(env.custom)) {
    lines.push(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  return lines.join("\n");
}
