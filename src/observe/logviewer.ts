/**
 * 日志查看器 —— 实时日志缓存、过滤查询与订阅
 *
 * 对标 Hermes Web UI 的日志实时查看功能：
 * - 内存环形缓冲区（maxEntries），满了就 shift
 * - subscribe 用 Set<callback>，log 时遍历通知
 * - query 支持多条件过滤 + 分页
 * - filePath 可选持久化（JSONL 格式追加写）
 * - 提供 logger 全局单例
 */

import { appendFileSync } from "node:fs";

// ============================================================================
// 类型定义
// ============================================================================

export interface LogEntry {
  timestamp: number;
  level: "debug" | "info" | "warn" | "error";
  /** 来源模块（agent/provider/channel/...） */
  source: string;
  message: string;
  data?: Record<string, unknown>;
  /** 关联的 trace ID */
  traceId?: string;
  sessionId?: string;
}

export interface LogViewerOptions {
  /** 最大缓存条数，默认 10000 */
  maxEntries?: number;
  /** 持久化文件路径（可选，不设则纯内存） */
  filePath?: string;
}

export interface LogQueryFilter {
  level?: LogEntry["level"][];
  source?: string[];
  traceId?: string;
  sessionId?: string;
  /** 起始时间戳（含） */
  since?: number;
  /** 截止时间戳（含） */
  until?: number;
  /** 全文搜索（匹配 message 字段） */
  search?: string;
  /** 返回条数，默认 100 */
  limit?: number;
  /** 跳过条数 */
  offset?: number;
}

// ============================================================================
// LogViewer 实现
// ============================================================================

export class LogViewer {
  private entries: LogEntry[] = [];
  private readonly maxEntries: number;
  private readonly filePath?: string;
  /** 订阅回调集合 */
  private subscribers = new Set<(entry: LogEntry) => void>();

  constructor(opts?: LogViewerOptions) {
    this.maxEntries = opts?.maxEntries ?? 10000;
    this.filePath = opts?.filePath;
  }

  // --------------------------------------------------------------------------
  // 添加日志
  // --------------------------------------------------------------------------

  log(
    level: LogEntry["level"],
    source: string,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      source,
      message,
      data,
    };

    // 追加到内存缓冲区
    this.entries.push(entry);
    // 超出上限时移除最旧的条目
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }

    // 持久化（JSONL 格式追加写）
    if (this.filePath) {
      try {
        appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf8");
      } catch {
        // 持久化失败不影响主流程
      }
    }

    // 通知订阅者
    for (const cb of this.subscribers) {
      try {
        cb(entry);
      } catch {
        // 订阅回调异常不中断其他订阅者
      }
    }
  }

  // --------------------------------------------------------------------------
  // 查询日志
  // --------------------------------------------------------------------------

  query(filter?: LogQueryFilter): { entries: LogEntry[]; total: number } {
    if (!filter) {
      return { entries: this.entries.slice(-100), total: this.entries.length };
    }

    const {
      level,
      source,
      traceId,
      sessionId,
      since,
      until,
      search,
      limit = 100,
      offset = 0,
    } = filter;

    let filtered = this.entries;

    // 按日志级别过滤
    if (level && level.length > 0) {
      const levelSet = new Set(level);
      filtered = filtered.filter((e) => levelSet.has(e.level));
    }

    // 按来源模块过滤
    if (source && source.length > 0) {
      const sourceSet = new Set(source);
      filtered = filtered.filter((e) => sourceSet.has(e.source));
    }

    // 按 traceId 过滤
    if (traceId !== undefined) {
      filtered = filtered.filter((e) => e.traceId === traceId);
    }

    // 按 sessionId 过滤
    if (sessionId !== undefined) {
      filtered = filtered.filter((e) => e.sessionId === sessionId);
    }

    // 按时间范围过滤
    if (since !== undefined) {
      filtered = filtered.filter((e) => e.timestamp >= since);
    }
    if (until !== undefined) {
      filtered = filtered.filter((e) => e.timestamp <= until);
    }

    // 全文搜索
    if (search) {
      const lower = search.toLowerCase();
      filtered = filtered.filter((e) => e.message.toLowerCase().includes(lower));
    }

    const total = filtered.length;
    const entries = filtered.slice(offset, offset + limit);
    return { entries, total };
  }

  // --------------------------------------------------------------------------
  // 实时订阅（SSE 风格回调）
  // --------------------------------------------------------------------------

  subscribe(callback: (entry: LogEntry) => void): () => void {
    this.subscribers.add(callback);
    // 返回 unsubscribe 函数
    return () => {
      this.subscribers.delete(callback);
    };
  }

  // --------------------------------------------------------------------------
  // 日志统计
  // --------------------------------------------------------------------------

  stats(): {
    total: number;
    byLevel: Record<string, number>;
    bySource: Record<string, number>;
    errorsLast24h: number;
  } {
    const byLevel: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    let errorsLast24h = 0;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;

    for (const e of this.entries) {
      byLevel[e.level] = (byLevel[e.level] ?? 0) + 1;
      bySource[e.source] = (bySource[e.source] ?? 0) + 1;
      if (e.level === "error" && e.timestamp >= cutoff) {
        errorsLast24h++;
      }
    }

    return {
      total: this.entries.length,
      byLevel,
      bySource,
      errorsLast24h,
    };
  }

  // --------------------------------------------------------------------------
  // 清空日志
  // --------------------------------------------------------------------------

  clear(): void {
    this.entries = [];
  }
}

// ============================================================================
// 全局日志单例
// ============================================================================

/** 全局日志实例 */
export const logger = new LogViewer();
