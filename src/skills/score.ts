/**
 * Skill 评分：多维打分 + 入库决策
 *
 * 维度（学 Hermes 反馈环 + GEPA 客观分）：
 * - successRate：同模式历史成功率
 * - tokenSaving：vs baseline 的 token 节省比
 * - feedback：用户 +1/-1 累计
 * - frequency：调用频次（log 归一化）
 * - overall：加权综合
 *
 * 行预算：~80 行
 */

import type { SkillScore } from "../core/types.js";

export interface ScoreInput {
  /** 本次是否成功 */
  success: boolean;
  /** 本次消耗 token */
  tokensUsed: number;
  /** baseline token（无技能时估算） */
  baselineTokens: number;
  /** 用户反馈累计 */
  feedback: number;
  /** 历史调用次数 */
  invocations: number;
}

const WEIGHTS = {
  successRate: 0.4,
  tokenSaving: 0.25,
  feedback: 0.15,
  frequency: 0.2,
};

export function scoreSkill(input: ScoreInput): SkillScore {
  // 成功率：用本次 + 历史平滑
  const histRate = input.invocations > 0 ? Math.min(1, input.invocations / 10) : 0.5;
  const successRate = input.success
    ? Math.min(1, histRate * 0.7 + 0.3)
    : Math.max(0, histRate * 0.7 - 0.3);

  // token 节省：>0 才有意义
  const tokenSaving = input.baselineTokens > 0
    ? Math.max(0, Math.min(1, 1 - input.tokensUsed / input.baselineTokens))
    : 0;

  // 反馈：归一化到 0-1（-5~+5 映射到 0~1）
  const feedback = Math.max(0, Math.min(1, (input.feedback + 5) / 10));

  // 频次：log 归一化
  const frequency = Math.min(1, Math.log10(input.invocations + 1) / 2);

  const overall =
    WEIGHTS.successRate * successRate +
    WEIGHTS.tokenSaving * tokenSaving +
    WEIGHTS.feedback * feedback +
    WEIGHTS.frequency * frequency;

  return { successRate, tokenSaving, feedback, frequency, overall };
}

/** 入库阈值：综合分超过此值才沉淀为 skill */
export const SEDIMENT_THRESHOLD = 0.6;

/** 是否值得入库 */
export function shouldSediment(score: SkillScore): boolean {
  return score.overall >= SEDIMENT_THRESHOLD;
}
