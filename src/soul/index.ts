/**
 * Soul —— 人格内核
 *
 * 设计：
 * - persona/traits/principles/speakingStyle 定义人格
 * - renderSoul 把它们渲染成 system prompt 的 base 部分
 * - 自进化模块可整体替换 soul（version +1），实现人格演进
 * - soul 本身可持久化到 SQLite
 */

import type Database from "better-sqlite3";
import type { Soul } from "../core/types.js";

export interface SoulSpec {
  id: string;
  name: string;
  persona: string;
  traits?: string[];
  principles?: string[];
  speakingStyle?: string;
}

/**
 * 渲染 soul 为 system prompt 的 base 部分。
 * 顺序固定：persona → traits → principles → speakingStyle，便于 prefix caching。
 */
export function renderSoul(spec: SoulSpec): string {
  const parts: string[] = [`你是 ${spec.name}。${spec.persona}`];
  if (spec.traits && spec.traits.length > 0) {
    parts.push(`性格特征：${spec.traits.join("、")}。`);
  }
  if (spec.principles && spec.principles.length > 0) {
    parts.push(`行为准则：\n${spec.principles.map((p) => `- ${p}`).join("\n")}`);
  }
  if (spec.speakingStyle) {
    parts.push(`说话风格：${spec.speakingStyle}`);
  }
  return parts.join("\n\n");
}

/** 从 spec 构造完整 Soul（自动渲染 systemPrompt + 时间戳） */
export function createSoul(spec: SoulSpec, version = 1): Soul {
  const now = Date.now();
  return {
    ...spec,
    traits: spec.traits ?? [],
    principles: spec.principles ?? [],
    systemPrompt: renderSoul(spec),
    version,
    createdAt: now,
    updatedAt: now,
  };
}

interface SoulRow {
  id: string;
  name: string;
  persona: string;
  traits: string;
  principles: string;
  speaking_style: string | null;
  system_prompt: string;
  version: number;
  created_at: number;
  updated_at: number;
}

/** Soul 持久化到 SQLite */
export class SoulStore {
  constructor(private readonly db: Database.Database) {
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS souls (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        persona TEXT NOT NULL,
        traits TEXT NOT NULL,
        principles TEXT NOT NULL,
        speaking_style TEXT,
        system_prompt TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  async save(soul: Soul): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO souls (id, name, persona, traits, principles, speaking_style, system_prompt, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, persona=excluded.persona, traits=excluded.traits,
           principles=excluded.principles, speaking_style=excluded.speaking_style,
           system_prompt=excluded.system_prompt, version=excluded.version, updated_at=excluded.updated_at`,
      )
      .run(
        soul.id,
        soul.name,
        soul.persona,
        JSON.stringify(soul.traits),
        JSON.stringify(soul.principles),
        soul.speakingStyle ?? null,
        soul.systemPrompt,
        soul.version,
        soul.createdAt,
        soul.updatedAt,
      );
  }

  async get(id: string): Promise<Soul | null> {
    const row = this.db.prepare("SELECT * FROM souls WHERE id = ?").get(id) as SoulRow | undefined;
    return row ? this.toSoul(row) : null;
  }

  async current(id = "default"): Promise<Soul> {
    const soul = await this.get(id);
    if (soul) return soul;
    // 兜底默认 soul
    return createSoul({
      id,
      name: "Micro Agent",
      persona: "你是一个轻量、可自进化的 agent 助手。回答简洁、准确，主动调用工具完成任务。",
      traits: ["简洁", "严谨", "主动"],
      principles: [
        "不确定时先调用工具验证，不要臆造",
        "回答控制在必要长度，避免冗余",
        "涉及不可逆操作时先确认",
      ],
      speakingStyle: "直接给结论，必要时附简短示例",
    });
  }

  /** 演进 soul：用新 spec 覆盖，version+1 */
  async evolve(id: string, spec: SoulSpec): Promise<Soul> {
    const old = await this.current(id);
    const next = createSoul(spec, old.version + 1);
    next.createdAt = old.createdAt;
    await this.save(next);
    return next;
  }

  private toSoul(r: SoulRow): Soul {
    return {
      id: r.id,
      name: r.name,
      persona: r.persona,
      traits: JSON.parse(r.traits) as string[],
      principles: JSON.parse(r.principles) as string[],
      speakingStyle: r.speaking_style ?? undefined,
      systemPrompt: r.system_prompt,
      version: r.version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
