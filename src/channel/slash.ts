/**
 * Slash 命令系统：/clear /compact /skill /model /agent /plugin /record /replay
 *
 * 设计（学 Claude Code / Codex 的 slash 命令）：
 * - 用户在 IM 输入 /xxx 触发元操作，不进 LLM
 * - 返回文本直接回显
 * - 命令可访问 agent 内部状态（memory/skills/plugins/imitator）
 *
 * 行预算：~90 行
 */

import type { Agent } from "../core/agent.js";
import type { Memory, SkillStore } from "../core/types.js";
import type { PluginRegistry } from "../plugin/registry.js";
import type { Compressor } from "../memory/compress.js";
import type { Imitator } from "../core/imitate.js";

export interface SlashContext {
  agent: Agent;
  memory?: Memory;
  skills?: SkillStore;
  plugins?: PluginRegistry;
  compressor?: Compressor;
  imitator?: Imitator;
  /** 当前用户/session */
  userId: string;
  sessionId: string;
}

export type SlashHandler = (args: string[], ctx: SlashContext) => Promise<string>;

const commands = new Map<string, { desc: string; handler: SlashHandler }>();

export function registerSlash(name: string, desc: string, handler: SlashHandler): void {
  commands.set(name, { desc, handler });
}

export function listSlash(): Array<{ name: string; desc: string }> {
  return [...commands.entries()].map(([name, v]) => ({ name, desc: v.desc }));
}

/** 处理 /command arg1 arg2，返回回复文本；非 / 开头返回 null */
export async function handleSlash(input: string, ctx: SlashContext): Promise<string | null> {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const parts = trimmed.slice(1).split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);
  const entry = commands.get(cmd);
  if (!entry) return `[未知命令] /${cmd}。输入 /help 查看可用命令。`;
  try {
    return await entry.handler(args, ctx);
  } catch (e) {
    return `[error] /${cmd}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ============================================================================
// 内置命令
// ============================================================================

registerSlash("help", "列出所有命令", async () => {
  const list = listSlash();
  return "可用命令：\n" + list.map((c) => `/${c.name} — ${c.desc}`).join("\n");
});

registerSlash("clear", "清空当前 session 的 L0 working memory", async (_a, ctx) => {
  if (!ctx.memory) return "[skip] memory 未启用";
  const l0 = await ctx.memory.list({ userId: ctx.userId, sessionId: ctx.sessionId, layer: "L0" });
  for (const m of l0) await ctx.memory.delete(m.id);
  return `已清空 ${l0.length} 条 L0 记忆`;
});

registerSlash("compact", "手动触发 L0→L1 压缩", async (_a, ctx) => {
  if (!ctx.compressor) return "[skip] compressor 未启用";
  const r = await ctx.compressor.compressSession({ userId: ctx.userId, sessionId: ctx.sessionId });
  return `压缩完成：L0 压缩 ${r.l0Compressed} 条，L1 合并 ${r.l1Merged} 条`;
});

registerSlash("skill", "列出已沉淀技能", async (_a, ctx) => {
  if (!ctx.skills) return "[skip] skills 未启用";
  const list = await ctx.skills.list();
  if (list.length === 0) return "无技能";
  return list.slice(0, 20).map((s) => `${s.id} (score=${s.score.toFixed(2)} inv=${s.invocations})`).join("\n");
});

registerSlash("model", "查看/切换当前模型", async (args, ctx) => {
  if (args.length === 0) return `当前模型：${ctx.agent["config" as keyof Agent] && (ctx.agent as unknown as { config: { model: string } }).config.model}`;
  // 切换模型（运行时改 config）
  (ctx.agent as unknown as { config: { model: string } }).config.model = args[0];
  return `模型已切换为 ${args[0]}`;
});

registerSlash("plugin", "列出/装卸插件", async (args, ctx) => {
  if (!ctx.plugins) return "[skip] plugins 未启用";
  if (args.length === 0) {
    const list = ctx.plugins.list();
    return list.length === 0 ? "无插件" : `已装载：${list.join(", ")}`;
  }
  return `[tip] 插件装卸请通过代码 ctx.plugins.install/uninstall(name)`;
});

registerSlash("record", "开始/停止录制（模仿人干活）", async (args, ctx) => {
  if (!ctx.imitator) return "[skip] imitator 未启用";
  if (ctx.imitator.isRecording) {
    const recipe = await ctx.imitator.stopRecord();
    return recipe ? `已录制 recipe: ${recipe.name}，${recipe.actions.length} 步` : "录制为空";
  }
  const name = args[0] ?? `record-${Date.now().toString(36)}`;
  const trigger = args.slice(1).join(" ") || name;
  ctx.imitator.startRecord(name, trigger);
  return `开始录制：${name}（trigger: ${trigger}）`;
});

registerSlash("replay", "查找并重放已录制 recipe", async (args, ctx) => {
  if (!ctx.imitator) return "[skip] imitator 未启用";
  const text = args.join(" ");
  const recipe = ctx.imitator.matchRecipe(text);
  if (!recipe) return "未找到匹配的 recipe";
  return `匹配到 recipe: ${recipe.name}，含 ${recipe.actions.length} 步，将在下轮 run 中重放`;
});
