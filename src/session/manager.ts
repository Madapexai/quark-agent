/**
 * SessionManager —— 多 session 并发 + checkpoint + 死循环检测 + 恢复
 *
 * 设计（学 OpenClaw 多 session + Hermes 持久）：
 * - 每个 session 的 L0 working memory 持久化到 memory 表（layer=L0）
 * - 每轮结束写 checkpoint（messages 快照）
 * - 崩溃后 recover() 从最近 checkpoint 恢复
 * - 死循环检测：记录每 session 最近 tool_call，相同签名连续超阈值则中止
 * - close()：触发 L0→L1 压缩
 */

import type Database from "better-sqlite3";
import type {
  Identity,
  Memory,
  Message,
  SessionManager,
  ToolCall,
} from "../core/types.js";
import { Compressor } from "../memory/compress.js";
import type { Provider } from "../core/types.js";

interface CheckpointRow {
  session_id: string;
  user_id: string;
  turn_id: string;
  messages: string;
  created_at: number;
}

export interface SqliteSessionManagerOptions {
  /** L0 working memory 最大轮数（超则触发压缩） */
  workingMemoryRounds?: number;
  /** 死循环检测阈值 */
  loopThreshold?: number;
  /** 摘要用模型 */
  model?: string;
}

export class SqliteSessionManager implements SessionManager {
  private readonly db: Database.Database;
  private readonly memory: Memory;
  private readonly compressor: Compressor;
  private readonly opts: Required<SqliteSessionManagerOptions>;
  /** 内存缓存：sessionId -> 最近 tool_call 签名序列 */
  private loopTracker = new Map<string, string[]>();

  constructor(
    db: Database.Database,
    memory: Memory,
    provider?: Provider,
    opts: SqliteSessionManagerOptions = {},
  ) {
    this.db = db;
    this.memory = memory;
    this.opts = {
      workingMemoryRounds: opts.workingMemoryRounds ?? 12,
      loopThreshold: opts.loopThreshold ?? 3,
      model: opts.model ?? "",
    };
    this.compressor = new Compressor(memory, provider, { model: this.opts.model });
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        messages TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, turn_id)
      );
      CREATE INDEX IF NOT EXISTS idx_cp_session ON checkpoints(session_id, created_at);
    `);
  }

  async getMessages(identity: Identity): Promise<Message[]> {
    // L0 working memory 从 memory 表取
    const entries = await this.memory.list({
      userId: identity.userId,
      sessionId: identity.sessionId,
      layer: "L0",
      kind: "chat",
    });
    return entries.map((e) => JSON.parse(e.content) as Message);
  }

  async append(identity: Identity, message: Message): Promise<void> {
    // 把 message 序列化存为 L0 chat 记忆
    await this.memory.add({
      content: JSON.stringify(message),
      kind: "chat",
      layer: "L0",
      userId: identity.userId,
      sessionId: identity.sessionId,
      importance: message.role === "user" ? 0.6 : 0.5,
    });

    // 溢出检测：异步压缩，不阻塞主流程
    const l0 = await this.memory.list({
      userId: identity.userId,
      sessionId: identity.sessionId,
      layer: "L0",
      kind: "chat",
    });
    if (l0.length > this.opts.workingMemoryRounds) {
      // 后台压缩，fire-and-forget 但捕获错误
      this.compressor.compressSession(identity).catch(() => undefined);
    }
  }

  async checkpoint(identity: Identity, messages: Message[]): Promise<void> {
    const turnId = identity.turnId ?? `${Date.now().toString(36)}`;
    this.db
      .prepare(
        "INSERT OR REPLACE INTO checkpoints (session_id, user_id, turn_id, messages, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(identity.sessionId, identity.userId, turnId, JSON.stringify(messages), Date.now());
  }

  async recover(identity: Identity): Promise<Message[]> {
    const row = this.db
      .prepare(
        "SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(identity.sessionId) as CheckpointRow | undefined;
    if (!row) return [];
    return JSON.parse(row.messages) as Message[];
  }

  async close(identity: Identity): Promise<void> {
    // 关闭 session：强制压缩 L0→L1，清空 L0
    await this.compressor.compressSession(identity);
    const l0 = await this.memory.list({
      userId: identity.userId,
      sessionId: identity.sessionId,
      layer: "L0",
      kind: "chat",
    });
    for (const m of l0) await this.memory.delete(m.id);
    this.loopTracker.delete(identity.sessionId);
  }

  checkLoop(sessionId: string, toolCall: ToolCall): boolean {
    const sig = `${toolCall.name}:${toolCall.arguments}`;
    const seq = this.loopTracker.get(sessionId) ?? [];
    seq.push(sig);
    // 只保留最近 threshold 条
    while (seq.length > this.opts.loopThreshold) seq.shift();
    this.loopTracker.set(sessionId, seq);

    // 最近的 threshold 条签名全相同 → 死循环
    if (seq.length >= this.opts.loopThreshold) {
      return seq.every((s) => s === sig);
    }
    return false;
  }

  /** 清理某 session 的 checkpoints（定期维护） */
  async purgeCheckpoints(sessionId: string, keepLast = 3): Promise<number> {
    const rows = this.db
      .prepare(
        "SELECT turn_id FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC",
      )
      .all(sessionId) as Array<{ turn_id: string }>;
    const toDelete = rows.slice(keepLast);
    const stmt = this.db.prepare("DELETE FROM checkpoints WHERE session_id = ? AND turn_id = ?");
    for (const r of toDelete) stmt.run(sessionId, r.turn_id);
    return toDelete.length;
  }
}
