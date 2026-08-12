/**
 * DailyNotes —— 每日笔记 + 策展记忆
 *
 * 设计（对标 AgentMore 精房日志双层结构）：
 * - DailyNoteStore：按日期写入原始笔记（L3 层，跨 session）
 *   - format: memory entry with kind="reflection", layer="L3", sessionId=null
 *   - meta: { date: "YYYY-MM-DD", type: "daily-note" }
 * - searchDailyNotes：按关键词/日期范围检索
 * - CuratedMemory：从 daily notes 中提炼长期事实写入 L2
 * - MemoryMaintenance：定期触发 daily→L2 的提炼
 *
 * 数据流：
 *   事件发生 → writeDailyNote() → L3 原始日志
 *   定期/空闲 → distillDailyNotes() → L2 策展精华
 *   查询时 → searchDailyNotes() 搜 L3 + Memory.search() 搜 L2
 */

import type { Memory, MemoryEntry, Provider } from "../core/types.js";
import { cosine } from "./sqlite.js";

// ============================================================================
// 类型
// ============================================================================

export interface DailyNote {
  id: string;
  date: string; // YYYY-MM-DD
  content: string;
  tags?: string[];
  createdAt: number;
  meta?: Record<string, unknown>;
}

export interface DailyNoteQuery {
  /** 关键词搜索 */
  query?: string;
  /** 日期范围 */
  fromDate?: string;
  toDate?: string;
  /** 标签过滤 */
  tags?: string[];
  /** 返回条数 */
  topK?: number;
}

export interface DistillOptions {
  /** 每次提炼多少天的笔记 */
  batchSize: number;
  /** 提炼用的模型 */
  model?: string;
  /** 最大提炼条数 */
  maxFacts?: number;
}

// ============================================================================
// DailyNoteStore —— 每日笔记存储
// ============================================================================

export class DailyNoteStore {
  constructor(
    private memory: Memory,
    private userId: string,
  ) {}

  /** 写一条日常笔记 */
  async write(content: string, opts: { date?: string; tags?: string[]; meta?: Record<string, unknown> } = {}): Promise<string> {
    const date = opts.date ?? todayStr();
    return this.memory.add({
      content,
      kind: "reflection",
      layer: "L3",
      userId: this.userId,
      sessionId: undefined, // 跨 session
      domain: "daily-notes",
      importance: 0.5,
      meta: { date, type: "daily-note", tags: opts.tags ?? [], ...opts.meta },
    });
  }

  /** 按日期/关键词搜索日常笔记 */
  async search(query: DailyNoteQuery = {}): Promise<DailyNote[]> {
    const entries = await this.memory.list({
      userId: this.userId,
      layer: "L3",
    });

    let filtered = entries.filter((e) => e.domain === "daily-notes" || e.meta?.type === "daily-note");

    // 日期范围过滤
    if (query.fromDate) {
      filtered = filtered.filter((e) => {
        const date = (e.meta?.date as string) ?? "";
        return date >= query.fromDate!;
      });
    }
    if (query.toDate) {
      filtered = filtered.filter((e) => {
        const date = (e.meta?.date as string) ?? "";
        return date <= query.toDate!;
      });
    }

    // 标签过滤
    if (query.tags && query.tags.length > 0) {
      filtered = filtered.filter((e) => {
        const tags = (e.meta?.tags as string[]) ?? [];
        return query.tags!.some((t) => tags.includes(t));
      });
    }

    // 关键词搜索
    if (query.query) {
      const q = query.query.toLowerCase();
      filtered = filtered.filter((e) => e.content.toLowerCase().includes(q));
    }

    // 按时间倒序
    filtered.sort((a, b) => b.createdAt - a.createdAt);

    const topK = query.topK ?? 50;
    return filtered.slice(0, topK).map((e) => this.toNote(e));
  }

  /** 获取指定日期的所有笔记 */
  async getByDate(date: string): Promise<DailyNote[]> {
    const entries = await this.memory.list({ userId: this.userId, layer: "L3" });
    return entries
      .filter((e) => (e.meta?.date as string) === date && (e.meta?.type === "daily-note" || e.domain === "daily-notes"))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((e) => this.toNote(e));
  }

  /** 获取最近 N 天的笔记 */
  async getRecent(days: number = 7): Promise<DailyNote[]> {
    const now = new Date();
    const dates: string[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }
    const result: DailyNote[] = [];
    for (const date of dates) {
      const notes = await this.getByDate(date);
      result.push(...notes);
    }
    return result;
  }

  /** 删除一条笔记 */
  async delete(id: string): Promise<void> {
    await this.memory.delete(id);
  }

  /** 按日期读取笔记（read 别名） */
  async read(date: string): Promise<DailyNote[]> {
    return this.getByDate(date);
  }

  /** 按日期范围读取笔记 */
  async getRange(startDate: string, endDate: string): Promise<DailyNote[]> {
    const entries = await this.memory.list({
      userId: this.userId,
      layer: "L3",
      kind: "reflection",
    });
    return entries
      .filter((e) => e.meta?.type === "daily-note")
      .map((e) => this.toNote(e))
      .filter((n) => n.date >= startDate && n.date <= endDate)
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  private toNote(e: MemoryEntry): DailyNote {
    return {
      id: e.id,
      date: (e.meta?.date as string) ?? todayStr(),
      content: e.content,
      tags: (e.meta?.tags as string[]) ?? [],
      createdAt: e.createdAt,
      meta: e.meta,
    };
  }
}

// ============================================================================
// CuratedMemory —— 策展记忆（从 daily notes 提炼到 L2）
// ============================================================================

export class CuratedMemory {
  constructor(
    private memory: Memory,
    private userId: string,
  ) {}

  /** 从 daily notes 提炼长期事实写入 L2 */
  async distillFromDailyNotes(
    notes: DailyNote[],
    provider?: Provider,
    model?: string,
  ): Promise<number> {
    if (notes.length === 0) return 0;

    // 用 LLM 提炼关键事实
    const factsText = notes.map((n) => n.content).join("\n---\n");
    let facts: string[] = [];

    if (provider && model) {
      try {
        const resp = await provider.chat({
          messages: [
            {
              role: "system",
              content: "你是一个记忆策展器。从以下日常笔记中提取值得长期记住的关键事实、决策、偏好。每条一行，简洁。不要提取临时信息。",
            },
            { role: "user", content: factsText.slice(0, 8000) },
          ],
          model,
          temperature: 0.3,
          maxTokens: 500,
        });
        facts = resp.content
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && !l.startsWith("---"));
      } catch {
        // 降级：直接截取关键句
        facts = notes.map((n) => n.content.slice(0, 100));
      }
    } else {
      // 无 LLM：取每条笔记的前 100 字符作为事实
      facts = notes.map((n) => n.content.slice(0, 100));
    }

    // 写入 L2
    let count = 0;
    for (const fact of facts.slice(0, 20)) {
      // 去重检查：与已有 L2 fact 余弦相似度 > 0.85 则跳过
      const existing = await this.memory.search({
        query: fact,
        userId: this.userId,
        layer: "L2",
        topK: 3,
      });
      const isDup = existing.some((e) => {
        if (!e.embedding || !e.content) return false;
        const sim = cosine(
          e.embedding,
          // 简化：用内容长度作为伪嵌入
          pseudoEmbed(fact, e.embedding.length),
        );
        return sim > 0.85;
      });

      if (!isDup) {
        await this.memory.add({
          content: fact,
          kind: "fact",
          layer: "L2",
          userId: this.userId,
          sessionId: undefined,
          domain: "curated",
          importance: 0.8,
        });
        count++;
      }
    }
    return count;
  }

  /** 搜索策展记忆 */
  async search(query: string, topK: number = 5): Promise<MemoryEntry[]> {
    return this.memory.search({
      query,
      userId: this.userId,
      layer: "L2",
      topK,
    });
  }

  /** 手动添加一条策展事实 */
  async addFact(content: string, importance: number = 0.8): Promise<string> {
    return this.memory.add({
      content,
      kind: "fact",
      layer: "L2",
      userId: this.userId,
      sessionId: undefined,
      domain: "curated",
      importance,
    });
  }

  /** 删除一条策展事实 */
  async deleteFact(id: string): Promise<void> {
    await this.memory.delete(id);
  }

  /** searchFacts 别名 */
  async searchFacts(query: string, topK: number = 5): Promise<MemoryEntry[]> {
    return this.search(query, topK);
  }
}

// ============================================================================
// MemoryMaintenance —— 定期维护：daily notes → L2 提炼
// ============================================================================

export class MemoryMaintenance {
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private dailyNotes: DailyNoteStore,
    private curated: CuratedMemory,
    private provider?: Provider,
    private model?: string,
  ) {}

  /** 启动定期维护（默认每 6 小时跑一次） */
  start(intervalMs: number = 6 * 60 * 60 * 1000): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.run().catch(() => {}), intervalMs);
  }

  /** 手动触发一次提炼 */
  async run(): Promise<{ distilled: number; fromNotes: number }> {
    const recent = await this.dailyNotes.getRecent(7);
    if (recent.length === 0) return { distilled: 0, fromNotes: 0 };
    const count = await this.curated.distillFromDailyNotes(recent, this.provider, this.model);
    return { distilled: count, fromNotes: recent.length };
  }

  /** runOnce 别名 */
  async runOnce(): Promise<{ distilled: number; fromNotes: number }> {
    return this.run();
  }

  /** 停止定期维护 */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

// ============================================================================
// 工具函数
// ============================================================================

/** 获取今天的日期字符串 YYYY-MM-DD */
export function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 简单伪嵌入（当无 embedding 模型时用于去重） */
function pseudoEmbed(text: string, dims: number): Float32Array {
  const arr = new Float32Array(dims);
  for (let i = 0; i < text.length; i++) {
    arr[i % dims] += text.charCodeAt(i);
  }
  // 归一化
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dims; i++) arr[i] /= norm;
  return arr;
}
