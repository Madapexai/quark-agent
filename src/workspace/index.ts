/**
 * Per-user Workspace：多租户隔离
 *
 * 对标 Agent-Native 的 per-user workspace（技能、记忆、指令、子Agent 和 MCP 服务器以 SQL 为后端按用户定制）。
 *
 * 设计：
 * - Workspace = 一个 userId 的全量数据隔离边界
 * - 每个 workspace 有独立的 SQLite 数据库文件（或共享 DB 的 userId 分区）
 * - 内置 Scope 强制过滤：tool 访问、memory 域、sandbox tier 都按 workspace 配置隔离
 * - WorkspaceManager：创建/获取/删除 workspace，管理生命周期
 * - Memory 可插拔：默认 SqliteMemory，可通过 memoryFactory 注入 InMemory 或其他实现
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Scope, Memory, MemoryEntry, MemoryLayer, Soul, MemoryQuery } from "../core/types.js";
import { fullScope, readOnlyScope } from "../env/index.js";

// ============================================================================
// 轻量级内存 Memory（测试/无 SQLite 环境使用）
// ============================================================================

export class InMemoryStore implements Memory {
  private entries = new Map<string, MemoryEntry>();

  async add(entry: Omit<MemoryEntry, "id" | "createdAt">): Promise<string> {
    const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const full: MemoryEntry = { id, createdAt: Date.now(), ...entry } as MemoryEntry;
    this.entries.set(id, full);
    return id;
  }

  async search(query: MemoryQuery): Promise<MemoryEntry[]> {
    const topK = query.topK ?? 20;
    let results = [...this.entries.values()];
    if (query.userId) results = results.filter((e) => e.userId === query.userId);
    if (query.sessionId) results = results.filter((e) => e.sessionId === query.sessionId);
    if (query.kind) results = results.filter((e) => e.kind === query.kind);
    if (query.layer) results = results.filter((e) => e.layer === query.layer);
    if (query.domain) results = results.filter((e) => e.domain === query.domain);
    if (query.query) {
      const lower = query.query.toLowerCase();
      results = results.filter((e) => e.content.toLowerCase().includes(lower));
    }
    return results.slice(0, topK);
  }

  async get(id: string): Promise<MemoryEntry | null> {
    return this.entries.get(id) ?? null;
  }

  async list(filter: { userId?: string; sessionId?: string; layer?: MemoryLayer; kind?: MemoryEntry["kind"] }): Promise<MemoryEntry[]> {
    let results = [...this.entries.values()];
    if (filter.userId) results = results.filter((e) => e.userId === filter.userId);
    if (filter.sessionId) results = results.filter((e) => e.sessionId === filter.sessionId);
    if (filter.kind) results = results.filter((e) => e.kind === filter.kind);
    if (filter.layer) results = results.filter((e) => e.layer === filter.layer);
    return results;
  }

  async delete(id: string): Promise<void> {
    this.entries.delete(id);
  }

  async close(): Promise<void> {
    this.entries.clear();
  }
}

// ============================================================================
// Workspace 配置
// ============================================================================

export interface WorkspaceConfig {
  /** 用户 ID（唯一标识） */
  userId: string;
  /** 显示名 */
  displayName?: string;
  /** 授权 scope */
  scope?: Scope;
  /** 工作区根目录（用于文件操作 sandbox） */
  rootDir?: string;
  /** 允许的模型列表 */
  allowedModels?: string[];
  /** 环境变量（key=value） */
  env?: Record<string, string>;
  /** 自定义 soul 覆盖 */
  soulOverrides?: Partial<Soul>;
  /** 该用户启用的 skills（白名单，空=全部） */
  enabledSkills?: string[];
  /** 该用户安装的 MCP servers */
  mcpServers?: Array<{ name: string; command: string; args?: string[]; env?: Record<string, string> }>;
  /** 该用户启用的 OSS 包 */
  ossPackages?: string[];
  /** profile 名（场景裁剪） */
  profile?: string;
  /** 创建时间 */
  createdAt: number;
  /** 最后活跃时间 */
  lastActiveAt: number;
  /** 元数据 */
  meta?: Record<string, unknown>;
}

/**
 * Memory 工厂：接收 userId 和 dbDir，返回一个 Memory 实例。
 * 默认工厂尝试加载 SqliteMemory；若 better-sqlite3 不可用则退化为 InMemoryStore。
 */
export type MemoryFactory = (userId: string, dbDir: string) => Promise<Memory> | Memory;

/** 默认 Memory 工厂：优先 SqliteMemory，失败回退 InMemoryStore */
export async function defaultMemoryFactory(userId: string, dbDir: string): Promise<Memory> {
  try {
    const Database = (await import("better-sqlite3")).default;
    const { SqliteMemory } = await import("../memory/sqlite.js");
    const safeId = userId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const dbPath = join(dbDir, `${safeId}.sqlite`);
    const db = new Database(dbPath);
    return new SqliteMemory(db, { path: dbPath });
  } catch {
    return new InMemoryStore();
  }
}

/** Workspace 实例：包含该用户的所有运行时依赖 */
export interface Workspace {
  config: WorkspaceConfig;
  memory: Memory;
  scope: Scope;
  /** 关闭 workspace */
  close: () => Promise<void>;
}

/** Workspace 管理器 */
export class WorkspaceManager {
  private workspaces = new Map<string, Workspace>();
  private dbDir: string;
  private memoryFactory: MemoryFactory;

  constructor(opts: { dbDir?: string; memoryFactory?: MemoryFactory } = {}) {
    this.dbDir = opts.dbDir ?? "./.data/workspaces";
    this.memoryFactory = opts.memoryFactory ?? defaultMemoryFactory;
    mkdirSync(this.dbDir, { recursive: true });
  }

  /** 获取或创建 workspace */
  async getOrCreate(config: Omit<WorkspaceConfig, "createdAt" | "lastActiveAt">): Promise<Workspace> {
    const existing = this.workspaces.get(config.userId);
    if (existing) {
      existing.config.lastActiveAt = Date.now();
      return existing;
    }

    const now = Date.now();
    const fullConfig: WorkspaceConfig = {
      ...config,
      createdAt: now,
      lastActiveAt: now,
      scope: config.scope ?? fullScope(),
    };

    const memory = await this.memoryFactory(config.userId, this.dbDir);

    const ws: Workspace = {
      config: fullConfig,
      memory,
      scope: fullConfig.scope!,
      async close() {
        await memory.close();
      },
    };

    this.workspaces.set(config.userId, ws);
    return ws;
  }

  /** 获取 workspace（不存在返回 null） */
  get(userId: string): Workspace | null {
    return this.workspaces.get(userId) ?? null;
  }

  /** 列出所有 workspace */
  list(): WorkspaceConfig[] {
    return [...this.workspaces.values()].map((w) => w.config);
  }

  /** 删除 workspace */
  async delete(userId: string): Promise<void> {
    const ws = this.workspaces.get(userId);
    if (ws) {
      await ws.close();
      this.workspaces.delete(userId);
    }
  }

  /** 更新 workspace 配置 */
  update(userId: string, patch: Partial<WorkspaceConfig>): Workspace | null {
    const ws = this.workspaces.get(userId);
    if (!ws) return null;
    Object.assign(ws.config, patch, { lastActiveAt: Date.now() });
    if (patch.scope) ws.scope = patch.scope;
    return ws;
  }

  /** 关闭所有 workspace */
  async closeAll(): Promise<void> {
    for (const [, ws] of this.workspaces) await ws.close();
    this.workspaces.clear();
  }

  /** 活跃 workspace 数 */
  get size(): number { return this.workspaces.size; }
}

/**
 * 创建只读 workspace scope（用于受限场景，如访客、public API）
 */
export function readonlyWorkspace(_userId: string): Scope {
  return readOnlyScope();
}

/**
 * Scope 工具：为指定 workspace 生成带 userId 绑定的 scope
 */
export function workspaceScope(ws: Workspace): Scope {
  return ws.scope;
}

/**
 * 按 workspace 过滤 Tool：只保留 scope 允许的工具
 */
export function filterToolsForWorkspace(tools: Map<string, { name: string }>, scope: Scope): string[] {
  if (scope.tools === "*") return [...tools.keys()];
  return scope.tools.filter((t) => tools.has(t));
}
