/**
 * Imitate —— 模仿人干活：录制 + 重放
 *
 * 设计（学 Codex 的 imitation learning）：
 * - 人干一次：record() 录制 tool 调用序列 + 观察
 * - agent 自动模仿：replay() 匹配相似场景，按录制顺序执行
 * - 与 SkillDiscoverer 协同：录制结果沉淀为 Recipe
 *
 * 行预算：~120 行
 */

import type { RecordedAction, Recipe, ToolCall } from "./types.js";
import type { SkillDiscoverer } from "../skills/discover.js";

export interface ImitateSession {
  /** 录制中的动作序列 */
  actions: RecordedAction[];
  /** 录制名 */
  name: string;
  /** 触发描述 */
  trigger: string;
  /** 开始时间 */
  startedAt: number;
}

export class Imitator {
  private current: ImitateSession | null = null;
  private readonly recipes = new Map<string, Recipe>();

  constructor(private readonly discoverer?: SkillDiscoverer) {}

  /** 开始录制 */
  startRecord(name: string, trigger: string): void {
    this.current = { actions: [], name, trigger, startedAt: Date.now() };
  }

  /** 录制一个动作（tool 调用） */
  recordToolCall(call: ToolCall, result: string): void {
    if (!this.current) return;
    this.current.actions.push({
      index: this.current.actions.length,
      kind: "tool_call",
      tool: call.name,
      args: call.arguments,
      text: result.slice(0, 200),
      ts: Date.now(),
    });
  }

  /** 录制一条观察（中间产物） */
  recordObservation(text: string): void {
    if (!this.current) return;
    this.current.actions.push({
      index: this.current.actions.length,
      kind: "observation",
      text,
      ts: Date.now(),
    });
  }

  /** 结束录制，沉淀为 Recipe */
  async stopRecord(): Promise<Recipe | null> {
    if (!this.current || this.current.actions.length === 0) {
      this.current = null;
      return null;
    }
    const recipe: Recipe = {
      id: `recipe.${Date.now().toString(36)}`,
      name: this.current.name,
      trigger: this.current.trigger,
      actions: this.current.actions,
      score: 0.6,
      invocations: 0,
      createdAt: this.current.startedAt,
    };
    this.recipes.set(recipe.id, recipe);
    // 沉淀到 discoverer（持久化）
    if (this.discoverer) {
      await this.discoverer.recordRecipe(recipe.name, recipe.trigger, recipe.actions).catch(() => undefined);
    }
    this.current = null;
    return recipe;
  }

  /** 是否正在录制 */
  get isRecording(): boolean {
    return this.current !== null;
  }

  /** 按 trigger 匹配已录制的 recipe */
  matchRecipe(userText: string): Recipe | null {
    for (const r of this.recipes.values()) {
      const trigger = r.trigger.toLowerCase();
      if (trigger && (userText.toLowerCase().includes(trigger) || trigger.includes(userText.toLowerCase().slice(0, 20)))) {
        return r;
      }
    }
    return null;
  }

  /** 重放 recipe：返回 tool 调用计划 */
  replay(recipe: Recipe): ToolCall[] {
    recipe.invocations++;
    return recipe.actions
      .filter((a) => a.kind === "tool_call" && a.tool && a.args)
      .map((a, i) => ({
        id: `replay_${recipe.id}_${i}`,
        name: a.tool!,
        arguments: a.args!,
      }));
  }

  /** 列出所有已录制 recipe */
  listRecipes(): Recipe[] {
    return [...this.recipes.values()];
  }
}
