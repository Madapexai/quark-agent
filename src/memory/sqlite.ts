/**
 * Memory trait 实现：SQLite + FTS5 + 向量列 + L0/L1/L2/L3 分层
 *
 * 设计（调研 §四 Hermes/ZeroClaw + 多 session 隔离）：
 * - 单文件 SQLite，零外部依赖
 * - FTS5 关键词检索 + 向量余弦 + 时间衰减混合得分
 * - 按 (userId, sessionId, layer) 复合分区
 * - list() 支持按 user/session/layer 批量取，供压缩管线使用
 * - 空闲 compaction：L0→L1→L2
 */

import type Database from "better-sqlite3";
import type { Memory, MemoryEntry, MemoryLayer, MemoryQuery } from "../core/types.js";
import { pseudoEmbed } from "../provider/openai.js";

export interface SqliteMemoryOptions {
  path: string;
  vectorDims?: number;
  weights?: { fts?: number; vector?: number; importance?: number; recency?: number };
  recencyHalfLifeMs?: number;
}

interface Row {
  id: string;
  content: string;
  kind: string;
  layer: string;
  user_id: string;
  session_id: string | null;
  domain: string | null;
  embedding: Buffer | null;
  importance: number;
  created_at: number;
  meta: string | null;
}

const DEFAULT_DIMS = 64;
const DEFAULT_WEIGHTS = { fts: 0.45, vector: 0.35, importance: 0.1, recency: 0.1 };

export class SqliteMemory implements Memory {
  private readonly db: Database.Database;
  private readonly dims: number;
  private readonly weights: Required<NonNullable<SqliteMemoryOptions["weights"]>>;
  private readonly halfLifeMs: number;
  private embedFn?: (text: string) => Promise<Float32Array>;

  constructor(
    db: Database.Database,
    opts: SqliteMemoryOptions,
    embedFn?: (text: string) => Promise<Float32Array>,
  ) {
    this.db = db;
    this.dims = opts.vectorDims ?? DEFAULT_DIMS;
    this.weights = { ...DEFAULT_WEIGHTS, ...(opts.weights ?? {}) };
    this.halfLifeMs = opts.recencyHalfLifeMs ?? 7 * 24 * 3600_000;
    this.embedFn = embedFn;
    this.init();
  }

  private init(): void {
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        kind TEXT NOT NULL,
        layer TEXT NOT NULL,
        user_id TEXT NOT NULL,
        session_id TEXT,
        domain TEXT,
        embedding BLOB,
        importance REAL DEFAULT 0.5,
        created_at INTEGER NOT NULL,
        meta TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memory_user ON memory(user_id);
      CREATE INDEX IF NOT EXISTS idx_memory_session ON memory(session_id);
      CREATE INDEX IF NOT EXISTS idx_memory_layer ON memory(layer);
      CREATE INDEX IF NOT EXISTS idx_memory_user_session ON memory(user_id, session_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        content,
        content='memory',
        content_rowid='rowid',
        tokenize='unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
        INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, content) VALUES('delete', old.rowid, old.content);
        INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    `);
  }

  async add(entry: Omit<MemoryEntry, "id" | "createdAt">): Promise<string> {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = Date.now();
    const embedding = await this.embed(entry.content);
    const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    this.db
      .prepare(
        `INSERT INTO memory (id, content, kind, layer, user_id, session_id, domain, embedding, importance, created_at, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        entry.content,
        entry.kind,
        entry.layer,
        entry.userId,
        entry.sessionId ?? null,
        entry.domain ?? null,
        buf,
        entry.importance ?? 0.5,
        createdAt,
        entry.meta ? JSON.stringify(entry.meta) : null,
      );
    return id;
  }

  async search(query: MemoryQuery): Promise<MemoryEntry[]> {
    const topK = query.topK ?? 5;
    const qvec = await this.embed(query.query);

    const ftsRows = this.ftsSearch(query, topK * 3);
    const vecRows = this.vectorScan(qvec, topK * 3, query);

    const candidates = new Map<string, { row: Row; ftsRank: number; vecScore: number }>();
    let ftsMax = 1;
    for (const r of ftsRows) {
      candidates.set(r.row.id, { row: r.row, ftsRank: r.rank, vecScore: 0 });
      if (Math.abs(r.rank) > ftsMax) ftsMax = Math.abs(r.rank);
    }
    for (const r of vecRows) {
      const existing = candidates.get(r.row.id);
      if (existing) {
        existing.vecScore = r.score;
      } else {
        candidates.set(r.row.id, { row: r.row, ftsRank: 0, vecScore: r.score });
      }
    }

    const now = Date.now();
    const scored = [...candidates.values()].map((c) => {
      const ftsNorm = ftsMax > 0 ? -c.ftsRank / ftsMax : 0;
      const recency = Math.pow(0.5, (now - c.row.created_at) / this.halfLifeMs);
      const importance = c.row.importance ?? 0.5;
      const score =
        this.weights.fts * Math.max(0, ftsNorm) +
        this.weights.vector * c.vecScore +
        this.weights.importance * importance +
        this.weights.recency * recency;
      return { entry: this.toEntry(c.row), score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map((s) => s.entry);
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const row = this.db.prepare("SELECT * FROM memory WHERE id = ?").get(id) as Row | undefined;
    return row ? this.toEntry(row) : null;
  }

  async delete(id: string): Promise<void> {
    this.db.prepare("DELETE FROM memory WHERE id = ?").run(id);
  }

  async list(filter: {
    userId?: string;
    sessionId?: string;
    layer?: MemoryLayer;
    kind?: MemoryEntry["kind"];
  }): Promise<MemoryEntry[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.userId) {
      where.push("user_id = ?");
      params.push(filter.userId);
    }
    if (filter.sessionId) {
      where.push("session_id = ?");
      params.push(filter.sessionId);
    }
    if (filter.layer) {
      where.push("layer = ?");
      params.push(filter.layer);
    }
    if (filter.kind) {
      where.push("kind = ?");
      params.push(filter.kind);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM memory ${clause} ORDER BY created_at ASC`)
      .all(...params) as Row[];
    return rows.map((r) => this.toEntry(r));
  }

  /** 关闭底层资源 */
  async close(): Promise<void> {
    this.db.close();
  }

  private async embed(text: string): Promise<Float32Array> {
    if (this.embedFn) {
      try {
        return await this.embedFn(text);
      } catch {
        return pseudoEmbed(text, this.dims);
      }
    }
    return pseudoEmbed(text, this.dims);
  }

  private ftsSearch(
    query: MemoryQuery,
    limit: number,
  ): Array<{ row: Row; rank: number }> {
    const match = this.sanitizeFtsQuery(query.filter ?? query.query);
    if (!match) return [];
    const where: string[] = [];
    const params: unknown[] = [match, limit];
    if (query.userId) {
      where.push("m.user_id = ?");
      params.splice(-1, 0, query.userId);
    }
    if (query.sessionId) {
      where.push("m.session_id = ?");
      params.splice(-1, 0, query.sessionId);
    }
    if (query.layer) {
      where.push("m.layer = ?");
      params.splice(-1, 0, query.layer);
    }
    if (query.kind) {
      where.push("m.kind = ?");
      params.splice(-1, 0, query.kind);
    }
    const clause = where.length > 0 ? `AND ${where.join(" AND ")}` : "";
    try {
      const rows = this.db
        .prepare(
          `SELECT m.*, f.rank as rank
           FROM memory_fts f JOIN memory m ON m.rowid = f.rowid
           WHERE memory_fts MATCH ? ${clause}
           ORDER BY f.rank
           LIMIT ?`,
        )
        .all(...params) as Array<Row & { rank: number }>;
      return rows.map((r) => ({ row: r as Row, rank: r.rank }));
    } catch {
      return [];
    }
  }

  private vectorScan(
    qvec: Float32Array,
    limit: number,
    query: MemoryQuery,
  ): Array<{ row: Row; score: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.userId) {
      where.push("user_id = ?");
      params.push(query.userId);
    }
    if (query.sessionId) {
      where.push("session_id = ?");
      params.push(query.sessionId);
    }
    if (query.layer) {
      where.push("layer = ?");
      params.push(query.layer);
    }
    if (query.kind) {
      where.push("kind = ?");
      params.push(query.kind);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM memory ${clause} ORDER BY created_at DESC LIMIT 1000`)
      .all(...params) as Row[];
    const scored: Array<{ row: Row; score: number }> = [];
    for (const row of rows) {
      if (!row.embedding) continue;
      const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
      const score = cosine(qvec, vec);
      scored.push({ row, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  private toEntry(row: Row): MemoryEntry {
    let embedding: Float32Array | undefined;
    if (row.embedding) {
      embedding = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      );
    }
    return {
      id: row.id,
      content: row.content,
      kind: row.kind as MemoryEntry["kind"],
      layer: row.layer as MemoryLayer,
      userId: row.user_id,
      sessionId: row.session_id ?? undefined,
      domain: row.domain ?? undefined,
      embedding,
      importance: row.importance,
      createdAt: row.created_at,
      meta: row.meta ? JSON.parse(row.meta) : undefined,
    };
  }

  private sanitizeFtsQuery(q: string): string {
    const tokens = q.match(/[\p{L}\p{N}_]+/gu);
    if (!tokens || tokens.length === 0) return "";
    return tokens.map((t) => t.toLowerCase()).join(" ");
  }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}
