/**
 * Evolve 模块：GEPA 风格 prompt / skill 自进化
 *
 * 设计（调研 §四 Hermes GEPA 引擎）：
 * - GEPA = Generative Prompt Adaptation：变异 → 评估 → 选择 → 交叉
 * - 100-500 次评估即可收敛（传统 RL 需上万次）
 * - 用 LLM 自身做评估器（rubric 打分），无需外部标注
 * - 收敛后把高分 prompt 沉淀为 Skill 写入 SkillStore
 *
 * 流程：
 *   1. seed：当前 systemPrompt 作为初始父代
 *   2. mutate：让 LLM 生成 N 个变异 prompt（改写/增强约束/换风格）
 *   3. evaluate：在评测集上跑每个 prompt，用 rubric 打分
 *   4. select：取 top-K 作为下一代父代
 *   5. 循环 G 代，最终把最优 prompt 沉淀为技能
 */

import type { Provider, SkillStore, Soul, Tracer } from "../core/types.js";
import type { SoulStore } from "../soul/index.js";

export interface EvalCase {
  /** 测试输入 */
  input: string;
  /** 期望要点（rubric 关键词/短语，命中得分） */
  expectedKeywords: string[];
  /** 期望风格约束（如 "简洁" / "带代码"），可选 */
  style?: string;
}

export interface EvolveConfig {
  /** 种群大小（每代变异体数） */
  populationSize?: number;
  /** 保留的父代数 */
  topK?: number;
  /** 迭代代数 */
  generations?: number;
  /** 评估用模型 */
  evalModel?: string;
  /** 早停：连续多少代无提升则停 */
  patience?: number;
}

export interface EvolveResult {
  bestPrompt: string;
  bestScore: number;
  history: Array<{ generation: number; best: number; avg: number }>;
  /** 是否已沉淀为技能 */
  sedimented: boolean;
}

const MUTATE_PROMPT = `你是一个 prompt 优化专家。下面是一个 agent 的 system prompt，
请生成 {{n}} 个改进版本，每个版本用 <variant>...</variant> 包裹。
改进方向：更清晰的约束、更少 token、更强的可执行性、更好的边界处理。
保持核心职责不变，不要臆造新能力。

原始 prompt:
"""
{{prompt}}
"""

只输出 {{n}} 个 <variant> 标签，不要其他解释。`;

const JUDGE_PROMPT = `你是一个严格的能力评估器。请对以下 agent 回复打分（0-10 分，保留一位小数）。

任务输入: {{input}}
期望要点: {{keywords}}
期望风格: {{style}}

agent 回复:
"""
{{reply}}
"""

评分维度：要点覆盖(0-4) + 风格符合(0-3) + 简洁度(0-2) + 准确性(0-1)。
只输出一个数字（总分），不要解释。`;

export class Evolver {
  constructor(
    private readonly provider: Provider,
    private readonly tracer: Tracer,
    private readonly skills?: SkillStore,
    private readonly souls?: SoulStore,
  ) {}

  async evolve(
    seedPrompt: string,
    evalSet: EvalCase[],
    config: EvolveConfig = {},
  ): Promise<EvolveResult> {
    const popSize = config.populationSize ?? 4;
    const topK = config.topK ?? 2;
    const generations = config.generations ?? 3;
    const evalModel = config.evalModel ?? "";
    const patience = config.patience ?? 2;

    const history: EvolveResult["history"] = [];
    let parents = [{ prompt: seedPrompt, score: 0 }];
    let bestScore = 0;
    let bestPrompt = seedPrompt;
    let noImprove = 0;

    // 初始评估父代
    parents[0].score = await this.evaluate(seedPrompt, evalSet, evalModel);
    bestScore = parents[0].score;

    for (let gen = 1; gen <= generations; gen++) {
      const span = this.tracer.startSpan(`evolve.gen${gen}`, "evolve", {
        popSize,
        parents: parents.length,
      });

      // 1. 变异
      const mutants = await this.mutate(parents[0].prompt, popSize, evalModel);
      // 2. 评估
      const scored = await Promise.all(
        mutants.map(async (p) => ({
          prompt: p,
          score: await this.evaluate(p, evalSet, evalModel),
        })),
      );
      scored.push(...parents);
      // 3. 选择
      scored.sort((a, b) => b.score - a.score);
      parents = scored.slice(0, topK);

      const genBest = parents[0].score;
      const genAvg = scored.reduce((s, x) => s + x.score, 0) / scored.length;
      history.push({ generation: gen, best: genBest, avg: genAvg });

      if (genBest > bestScore) {
        bestScore = genBest;
        bestPrompt = parents[0].prompt;
        noImprove = 0;
      } else {
        noImprove++;
      }

      this.tracer.endSpan(span, "ok");
      if (noImprove >= patience) break;
    }

    // 沉淀为技能：分数达标（>5.0 / 10）才写入 SkillStore
    let sedimented = false;
    if (this.skills && bestScore > 5.0) {
      const skillId = `evolved.${Date.now().toString(36)}`;
      await this.skills.add({
        id: skillId,
        name: `自进化 prompt ${skillId}`,
        trigger: "默认通用",
        promptTemplate: "{{base}}\n\n[自进化增强]\n" + bestPrompt,
        score: bestScore / 10,
        invocations: 0,
        lastUsedAt: 0,
        createdAt: Date.now(),
      });
      sedimented = true;
    }

    return { bestPrompt, bestScore, history, sedimented };
  }

  /**
   * 演进 Soul：基于现有 soul 的 systemPrompt 跑 GEPA，
   * 把最优 prompt 反解为人格 spec，写入 SoulStore（version+1）。
   * 多 session 评估数据：evalSet 可来自真实 session 的 L1 摘要提炼。
   */
  async evolveSoul(
    soulId: string,
    evalSet: EvalCase[],
    config: EvolveConfig = {},
  ): Promise<{ soul: Soul; bestScore: number; history: EvolveResult["history"] }> {
    if (!this.souls) throw new Error("evolveSoul 需要 SoulStore");
    const current = await this.souls.current(soulId);

    // 复用 evolve 优化 systemPrompt
    const result = await this.evolve(current.systemPrompt, evalSet, config);

    // 反解为 spec：保留原 persona，仅把优化后的 prompt 作为新 persona
    const next = await this.souls.evolve(soulId, {
      id: current.id,
      name: current.name,
      persona: result.bestPrompt,
      traits: current.traits,
      principles: current.principles,
      speakingStyle: current.speakingStyle,
    });
    return { soul: next, bestScore: result.bestScore, history: result.history };
  }

  private async mutate(prompt: string, n: number, model: string): Promise<string[]> {
    const instruction = MUTATE_PROMPT.replace("{{prompt}}", prompt).replace(/{{n}}/g, String(n));
    const resp = await this.provider.chat({
      messages: [{ role: "user", content: instruction }],
      model,
      temperature: 0.9,
    });
    const variants: string[] = [];
    const re = /<variant>([\s\S]*?)<\/variant>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(resp.content)) !== null) {
      variants.push(m[1].trim());
    }
    // 兜底：若无标签，按段落切
    if (variants.length === 0) {
      const paras = resp.content.split(/\n\s*\n/).filter((p) => p.trim().length > 20);
      return paras.slice(0, n);
    }
    return variants.slice(0, n);
  }

  /** 评估一个 prompt：在 evalSet 上跑，rubric 打分，返回 0-10 */
  private async evaluate(prompt: string, evalSet: EvalCase[], model: string): Promise<number> {
    if (evalSet.length === 0) return 0;
    let total = 0;
    let count = 0;
    for (const c of evalSet) {
      try {
        const resp = await this.provider.chat({
          messages: [
            { role: "system", content: prompt },
            { role: "user", content: c.input },
          ],
          model,
          temperature: 0.2,
        });
        const reply = resp.content;
        // 关键词命中作为客观分
        const hit = c.expectedKeywords.filter((k) =>
          reply.toLowerCase().includes(k.toLowerCase()),
        ).length;
        const coverage = c.expectedKeywords.length > 0 ? hit / c.expectedKeywords.length : 0.5;

        // LLM rubric 打分
        const judge = await this.judge(c, reply, model);
        // 综合：客观 0.5 + 主观 0.5，归一化到 0-10
        const score = (coverage * 0.5 + (judge / 10) * 0.5) * 10;
        total += score;
        count++;
      } catch {
        // 失败案例记 0 分
        count++;
      }
    }
    return count > 0 ? total / count : 0;
  }

  private async judge(c: EvalCase, reply: string, model: string): Promise<number> {
    const instruction = JUDGE_PROMPT.replace("{{input}}", c.input)
      .replace("{{keywords}}", c.expectedKeywords.join(", "))
      .replace("{{style}}", c.style ?? "无特殊要求")
      .replace("{{reply}}", reply.slice(0, 1000));
    const resp = await this.provider.chat({
      messages: [{ role: "user", content: instruction }],
      model,
      temperature: 0,
      maxTokens: 16,
    });
    const num = parseFloat(resp.content.trim());
    return Number.isFinite(num) ? Math.max(0, Math.min(10, num)) : 5;
  }
}
