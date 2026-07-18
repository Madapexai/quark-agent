/**
 * Planner —— 决策力：任务规划 + 多步执行 + 反思
 *
 * 设计（学 Claude Code 的 plan mode + Codex 的多步决策）：
 * - plan()：让 LLM 把目标拆成可执行步骤
 * - execute()：按步骤执行，每步可调 tool
 * - reflect()：每步后反思是否需要调整计划
 * - 适配：当某步失败，planner 可重新规划剩余步骤
 *
 * 行预算：~140 行
 */

import type { Provider, Plan, PlanStep, Message, ToolSchema } from "./types.js";

export interface PlannerOptions {
  provider: Provider;
  model?: string;
  /** 可用工具 schema，供 planner 选择 */
  tools?: ToolSchema[];
  /** 最大反思次数 */
  maxReflects?: number;
}

export class Planner {
  private readonly opts: Required<PlannerOptions>;

  constructor(opts: PlannerOptions) {
    this.opts = {
      provider: opts.provider,
      model: opts.model ?? "",
      tools: opts.tools ?? [],
      maxReflects: opts.maxReflects ?? 3,
    };
  }

  /** 规划：把目标拆成步骤 */
  async plan(goal: string): Promise<Plan> {
    const toolDesc = this.opts.tools.length > 0
      ? `\n可用工具：${this.opts.tools.map((t) => t.function.name).join(", ")}`
      : "";
    const messages: Message[] = [
      {
        role: "user",
        content: `把以下目标拆成 ${3}-${8} 个可执行步骤。每步一行，格式：步骤描述 | 工具名(可空)${toolDesc}\n\n目标：${goal}\n\n只输出步骤，每行一个，不要编号。`,
      },
    ];
    const resp = await this.opts.provider.chat({ messages, model: this.opts.model, temperature: 0.3 });
    const steps = this.parseSteps(resp.content);
    return { goal, steps, cursor: 0 };
  }

  /** 执行一步：返回步骤 + 是否需要重新规划 */
  async executeStep(plan: Plan, observation: string): Promise<{ plan: Plan; needReplan: boolean }> {
    if (plan.cursor >= plan.steps.length) return { plan, needReplan: false };
    const step = plan.steps[plan.cursor];
    step.status = "running";

    // 反思：根据 observation 判断是否需要调整
    const needReplan = await this.reflect(plan, step, observation);
    if (needReplan && plan.cursor < this.opts.maxReflects) {
      const revised = await this.replan(plan, observation);
      return { plan: revised, needReplan: true };
    }

    step.status = "done";
    step.result = observation.slice(0, 200);
    plan.cursor++;
    return { plan, needReplan: false };
  }

  /** 反思：观察结果是否偏离目标 */
  private async reflect(plan: Plan, step: PlanStep, observation: string): Promise<boolean> {
    const remaining = plan.steps.slice(plan.cursor + 1).map((s) => s.description).join("; ");
    const messages: Message[] = [
      {
        role: "user",
        content: `当前步骤"${step.description}"的执行结果：\n${observation.slice(0, 500)}\n\n剩余计划：${remaining}\n目标：${plan.goal}\n\n判断：当前结果是否偏离目标？剩余步骤是否仍可行？只回答"是"或"否"。`,
      },
    ];
    try {
      const resp = await this.opts.provider.chat({ messages, model: this.opts.model, temperature: 0 });
      return resp.content.trim().startsWith("是");
    } catch {
      return false;
    }
  }

  /** 重新规划剩余步骤 */
  private async replan(plan: Plan, observation: string): Promise<Plan> {
    const done = plan.steps.slice(0, plan.cursor + 1).map((s) => `${s.description}: ${s.result ?? "done"}`);
    const messages: Message[] = [
      {
        role: "user",
        content: `目标：${plan.goal}\n已完成：${done.join("; ")}\n最新观察：${observation.slice(0, 300)}\n\n请重新规划剩余 ${3}-${5} 个步骤。每行一个，格式：步骤描述 | 工具名(可空)。只输出步骤。`,
      },
    ];
    const resp = await this.opts.provider.chat({ messages, model: this.opts.model, temperature: 0.3 });
    const newSteps = this.parseSteps(resp.content);
    return {
      goal: plan.goal,
      steps: [...plan.steps.slice(0, plan.cursor + 1), ...newSteps],
      cursor: plan.cursor + 1,
    };
  }

  private parseSteps(text: string): PlanStep[] {
    return text
      .split("\n")
      .map((l) => l.replace(/^\d+\.\s*/, "").trim())
      .filter((l) => l.length > 2 && !l.startsWith("步骤"))
      .slice(0, 8)
      .map((l, i) => {
        const [desc, tool] = l.split("|").map((s) => s.trim());
        return {
          id: `step-${i}`,
          description: desc,
          tool: tool || undefined,
          status: "pending" as const,
        };
      });
  }
}

/** Planner 作为 Tool 注册（供 agent 主动调 plan） */
export function createPlannerTool(planner: Planner): { name: string; description: string; plan: (goal: string) => Promise<Plan> } {
  return {
    name: "planner",
    description: "任务规划：把复杂目标拆成可执行步骤",
    plan: (goal: string) => planner.plan(goal),
  };
}
