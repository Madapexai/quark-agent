/**
 * 压缩管线：L0 → L1 → L2
 *
 * 触发时机：
 * - L0 overflow：working memory 轮数超阈值 → 旧 K 轮压缩成 L1 摘要
 * - L1 merge：同一 session L1 摘要超 N 条 → 两两合并
 * - L2 dedup：新 fact 与已有 L2 余弦 > 0.85 → 合并而非新增
 *
 * 摘要由 Provider 生成；离线/无 provider 时退化为截断式摘要。
 */

import type { Identity, Memory, Provider } from "../core/types.js";
import { cosine } from "./sqlite.js";

export interface CompressorOptions {
  /** L0 触发压缩的轮数阈值 */
  l0OverflowRounds?: number;
  /** 每次压缩的旧轮数 */
  l0CompressBatch?: number;
  /** L1 合并阈值条数 */
  l1MergeThreshold?: number;
  /** L2 去重余弦阈值 */
  l2DedupThreshold?: number;
  /** 摘要用模型 */
  model?: string;
}

const DEFAULTS: Required<CompressorOptions> = {
  l0OverflowRounds: 12,
  l0CompressBatch: 6,
  l1MergeThreshold: 5,
  l2DedupThreshold: 0.85,
  model: "",
};

export class Compressor {
  private readonly opts: Required<CompressorOptions>;
  constructor(
    private readonly memory: Memory,
    private readonly provider?: Provider,
    opts: CompressorOptions = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts, ...({} as Required<CompressorOptions>) };
    // 保留显式传入
    this.opts.l0OverflowRounds = opts.l0OverflowRounds ?? DEFAULTS.l0OverflowRounds;
    this.opts.l0CompressBatch = opts.l0CompressBatch ?? DEFAULTS.l0CompressBatch;
    this.opts.l1MergeThreshold = opts.l1MergeThreshold ?? DEFAULTS.l1MergeThreshold;
    this.opts.l2DedupThreshold = opts.l2DedupThreshold ?? DEFAULTS.l2DedupThreshold;
    this.opts.model = opts.model ?? DEFAULTS.model;
  }

  /**
   * 对某 session 跑一轮压缩。返回处理的阶段。
   * 由 SessionManager 在 L0 溢出或 session 关闭时调用。
   */
  async compressSession(identity: Identity): Promise<{
    l0Compressed: number;
    l1Merged: number;
  }> {
    const l0Compressed = await this.compressL0(identity);
    const l1Merged = await this.mergeL1(identity);
    return { l0Compressed, l1Merged };
  }

  /** L0 overflow：旧轮压缩成 L1，原文删除 */
  private async compressL0(identity: Identity): Promise<number> {
    const l0 = await this.memory.list({
      userId: identity.userId,
      sessionId: identity.sessionId,
      layer: "L0",
      kind: "chat",
    });
    if (l0.length < this.opts.l0OverflowRounds) return 0;

    // 取最旧的 batch 压缩
    const batch = l0.slice(0, this.opts.l0CompressBatch);
    const text = batch.map((m) => m.content).join("\n---\n");
    const summary = await this.summarize(text, "对话片段");

    await this.memory.add({
      content: `[session 摘要] ${summary}`,
      kind: "reflection",
      layer: "L1",
      userId: identity.userId,
      sessionId: identity.sessionId,
      importance: 0.7,
    });
    for (const m of batch) await this.memory.delete(m.id);
    return batch.length;
  }

  /** L1 merge：同 session L1 超阈值 → 两两合并 */
  private async mergeL1(identity: Identity): Promise<number> {
    const l1 = await this.memory.list({
      userId: identity.userId,
      sessionId: identity.sessionId,
      layer: "L1",
    });
    if (l1.length < this.opts.l1MergeThreshold) return 0;

    let merged = 0;
    for (let i = 0; i + 1 < l1.length; i += 2) {
      const a = l1[i];
      const b = l1[i + 1];
      const combined = await this.summarize(`${a.content}\n---\n${b.content}`, "合并摘要");
      await this.memory.add({
        content: `[session 摘要] ${combined}`,
        kind: "reflection",
        layer: "L1",
        userId: identity.userId,
        sessionId: identity.sessionId,
        importance: 0.75,
      });
      await this.memory.delete(a.id);
      await this.memory.delete(b.id);
      merged += 2;
    }
    return merged;
  }

  /** L2 dedup：把 L1 提炼为 L2 long-term fact，与已有 L2 去重 */
  async promoteToL2(identity: Identity, fact: string, importance = 0.8): Promise<"added" | "merged"> {
    // 与该用户已有 L2 fact 比对
    const existing = await this.memory.list({
      userId: identity.userId,
      layer: "L2",
      kind: "fact",
    });
    const factVec = await this.embed(fact);
    for (const e of existing) {
      if (!e.embedding) continue;
      const sim = cosine(factVec, e.embedding);
      if (sim > this.opts.l2DedupThreshold) {
        // 合并：更新内容（这里简单取较长者 + 标注合并）
        const merged = e.content.length >= fact.length ? e.content : fact;
        await this.memory.delete(e.id);
        await this.memory.add({
          content: merged,
          kind: "fact",
          layer: "L2",
          userId: identity.userId,
          importance: Math.max(e.importance ?? importance, importance),
        });
        return "merged";
      }
    }
    await this.memory.add({
      content: fact,
      kind: "fact",
      layer: "L2",
      userId: identity.userId,
      importance,
    });
    return "added";
  }

  private async summarize(text: string, label: string): Promise<string> {
    if (this.provider) {
      try {
        const resp = await this.provider.chat({
          messages: [
            {
              role: "user",
              content: `把以下${label}压缩成不超过 200 字的摘要，保留关键事实、决策、未决问题：\n\n${text.slice(0, 4000)}`,
            },
          ],
          model: this.opts.model,
          temperature: 0.3,
          maxTokens: 300,
        });
        return resp.content.slice(0, 500);
      } catch {
        // 降级
      }
    }
    // 降级：截断式摘要
    return text.slice(0, 200);
  }

  private async embed(text: string): Promise<Float32Array> {
    if (this.provider?.embed) {
      try {
        return await this.provider.embed(text);
      } catch {
        // 降级
      }
    }
    // 退化：用 pseudoEmbed
    const { pseudoEmbed } = await import("../provider/openai.js");
    return pseudoEmbed(text, 64);
  }
}

/** 粗略 token 估算：中英混合按 4 字符/token */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
