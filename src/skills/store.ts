/**
 * SkillStore 实现：技能注册与沉淀
 *
 * 设计（调研 §四 Hermes 技能沉淀 + ZeroClaw trait）：
 * - 技能 = 触发条件 + prompt 模板 + 评估分数
 * - 自进化产物通过 evolve 模块写入此处
 * - match() 用关键词/正则匹配，触发对应技能的 prompt 模板
 * - 持久化到 SQLite（可与 memory 共用同一库）
 */

import type Database from "better-sqlite3";
import type { Skill, SkillStore } from "../core/types.js";

interface SkillRow {
  id: string;
  name: string;
  trigger: string;
  prompt_template: string;
  score: number;
  invocations: number;
  last_used_at: number;
  created_at: number;
  meta: string | null;
}

export class SqliteSkillStore implements SkillStore {
  constructor(private readonly db: Database.Database) {
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        trigger TEXT NOT NULL,
        prompt_template TEXT NOT NULL,
        score REAL DEFAULT 0,
        invocations INTEGER DEFAULT 0,
        last_used_at INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        meta TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_skills_score ON skills(score DESC);
    `);
  }

  async list(): Promise<Skill[]> {
    const rows = this.db
      .prepare("SELECT * FROM skills ORDER BY score DESC, invocations DESC")
      .all() as SkillRow[];
    return rows.map((r) => this.toSkill(r));
  }

  async add(skill: Skill): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO skills (id, name, trigger, prompt_template, score, invocations, last_used_at, created_at, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, trigger=excluded.trigger,
           prompt_template=excluded.prompt_template, score=excluded.score,
           meta=excluded.meta`,
      )
      .run(
        skill.id,
        skill.name,
        skill.trigger,
        skill.promptTemplate,
        skill.score,
        skill.invocations,
        skill.lastUsedAt,
        skill.createdAt,
        skill.meta ? JSON.stringify(skill.meta) : null,
      );
  }

  async remove(id: string): Promise<void> {
    this.db.prepare("DELETE FROM skills WHERE id = ?").run(id);
  }

  async match(text: string): Promise<Skill[]> {
    const all = await this.list();
    const lower = text.toLowerCase();
    const scored: Array<{ skill: Skill; hit: number }> = [];
    for (const skill of all) {
      // trigger 可能是关键词列表或正则
      const hit = this.scoreMatch(skill.trigger, lower);
      if (hit > 0) {
        scored.push({ skill, hit: hit * (0.5 + skill.score) });
      }
    }
    scored.sort((a, b) => b.hit - a.hit);

    // 命中后递增调用计数
    for (const { skill } of scored.slice(0, 1)) {
      this.db
        .prepare("UPDATE skills SET invocations = invocations + 1, last_used_at = ? WHERE id = ?")
        .run(Date.now(), skill.id);
    }
    return scored.slice(0, 3).map((s) => s.skill);
  }

  /** 把低分旧技能淘汰，保留高分沉淀（学 Hermes 自动沉淀） */
  async evict(keepTopN = 100): Promise<number> {
    const count = (
      this.db
        .prepare("SELECT COUNT(*) as c FROM skills")
        .get() as { c: number }
    ).c;
    if (count <= keepTopN) return 0;
    const deleted = this.db
      .prepare(
        `DELETE FROM skills WHERE id IN (
          SELECT id FROM skills ORDER BY score ASC, invocations ASC LIMIT ?
        )`,
      )
      .run(count - keepTopN);
    return deleted.changes;
  }

  private scoreMatch(trigger: string, text: string): number {
    // 正则形式 /pattern/flags
    if (trigger.startsWith("/")) {
      const m = trigger.match(/^\/(.+)\/([gimsuy]*)$/);
      if (m) {
        try {
          const re = new RegExp(m[1], m[2]);
          return re.test(text) ? 1 : 0;
        } catch {
          return 0;
        }
      }
    }
    // 关键词列表：逗号或空格分隔，全部小写匹配
    const keywords = trigger.toLowerCase().split(/[,\s]+/).filter(Boolean);
    if (keywords.length === 0) return 0;
    let hit = 0;
    for (const kw of keywords) {
      if (text.includes(kw)) hit++;
    }
    return hit / keywords.length;
  }

  private toSkill(r: SkillRow): Skill {
    return {
      id: r.id,
      name: r.name,
      trigger: r.trigger,
      promptTemplate: r.prompt_template,
      score: r.score,
      invocations: r.invocations,
      lastUsedAt: r.last_used_at,
      createdAt: r.created_at,
      meta: r.meta ? JSON.parse(r.meta) : undefined,
    };
  }
}
