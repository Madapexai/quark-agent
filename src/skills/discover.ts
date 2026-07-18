/**
 * Skill 自动发现 + 模仿人干活
 *
 * 设计（学 Codex 模仿 + Hermes 沉淀）：
 * - observe()：每次成功 run 后抽取模式（system+tool 调用序列）
 * - 录制模式：把人的操作序列录成 Recipe，下次相似输入自动重放
 * - 评分入库：达到阈值的模式沉淀为 Skill
 * - 重放：匹配到 Recipe 时，按录制顺序执行 tool 调用
 *
 * 行预算：~180 行
 */

import type {
  Identity,
  Memory,
  Recipe,
  RecordedAction,
  Skill,
  SkillStore,
  ToolCall,
} from "../core/types.js";
import { scoreSkill, shouldSediment } from "./score.js";

export interface RunObservation {
  identity: Identity;
  userText: string;
  toolCalls: ToolCall[];
  reply: string;
  success: boolean;
  tokensUsed: number;
  baselineTokens: number;
}

export class SkillDiscoverer {
  private feedbackMap = new Map<string, number>();
  /** 内部计数器：在 sediment 前累计 invocations（避免鸡生蛋问题） */
  private invokeCounter = new Map<string, number>();

  constructor(
    private readonly skills: SkillStore,
    private readonly memory?: Memory,
  ) {}

  /** 用户反馈：/good skillId 或 /bad skillId */
  feedback(skillId: string, delta: number): void {
    this.feedbackMap.set(skillId, (this.feedbackMap.get(skillId) ?? 0) + delta);
  }

  /** 观察一次 run，抽取模式并尝试入库 */
  async observe(obs: RunObservation): Promise<Skill | null> {
    if (!obs.success || obs.toolCalls.length === 0) return null;

    // 抽取模式：tool 调用序列的签名
    const pattern = obs.toolCalls.map((t) => t.name).join("→");
    const trigger = obs.userText.slice(0, 100);
    const skillId = `discover.${hashPattern(pattern + trigger)}`;

    // 内部累计 invocations（不依赖 store，store 里 skill 可能还没沉淀）
    const counter = (this.invokeCounter.get(skillId) ?? 0) + 1;
    this.invokeCounter.set(skillId, counter);

    // 检查 store 是否已沉淀
    const existing = await this.skills.list();
    const found = existing.find((s) => s.id === skillId);
    const invocations = Math.max(counter, (found?.invocations ?? 0) + 1);
    const feedback = this.feedbackMap.get(skillId) ?? 0;

    const score = scoreSkill({
      success: obs.success,
      tokensUsed: obs.tokensUsed,
      baselineTokens: obs.baselineTokens,
      feedback,
      invocations,
    });

    if (!shouldSediment(score) && !found) return null;

    // 沉淀为 Skill
    const skill: Skill = {
      id: skillId,
      name: `自动发现: ${pattern}`,
      trigger,
      promptTemplate: `{{base}}\n\n[自动发现技能] 处理"${trigger.slice(0, 40)}"时，按 ${pattern} 顺序调用工具。`,
      score: score.overall,
      invocations,
      lastUsedAt: Date.now(),
      createdAt: found?.createdAt ?? Date.now(),
      meta: { pattern, score: score.overall, source: "discover" },
    };
    await this.skills.add(skill);
    return skill;
  }

  /** 录制人的操作序列为 Recipe（模仿人干活） */
  async recordRecipe(name: string, trigger: string, actions: RecordedAction[]): Promise<Recipe> {
    const recipe: Recipe = {
      id: `recipe.${hashPattern(name + trigger)}`,
      name,
      trigger,
      actions,
      score: 0.5,
      invocations: 0,
      createdAt: Date.now(),
    };
    // 存到 memory 作为 L3 skill 记录
    if (this.memory) {
      await this.memory.add({
        content: JSON.stringify(recipe),
        kind: "skill",
        layer: "L3",
        userId: "shared",
        importance: 0.8,
        meta: { recipeId: recipe.id, name, trigger },
      });
    }
    return recipe;
  }

  /** 匹配 recipe：从 memory L3 检索相似的录制 */
  async matchRecipe(userText: string): Promise<Recipe | null> {
    if (!this.memory) return null;
    const results = await this.memory.search({
      query: userText,
      topK: 3,
      layer: "L3",
      kind: "skill",
      userId: "shared",
    });
    for (const r of results) {
      try {
        const recipe = JSON.parse(r.content) as Recipe;
        // 简单 trigger 关键词匹配
        if (recipe.trigger && userText.toLowerCase().includes(recipe.trigger.toLowerCase().slice(0, 20))) {
          return recipe;
        }
      } catch {
        // 跳过
      }
    }
    return null;
  }

  /** 重放 recipe：返回 tool 调用计划，由 agent 执行 */
  replay(recipe: Recipe): ToolCall[] {
    return recipe.actions
      .filter((a) => a.kind === "tool_call" && a.tool && a.args)
      .map((a, i) => ({
        id: `replay_${recipe.id}_${i}`,
        name: a.tool!,
        arguments: a.args!,
      }));
  }
}

/** 简单 hash：取字符串前 8 位 hex */
function hashPattern(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 8);
}
