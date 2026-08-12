/**
 * HarnessAdapter —— 把不同 harness（Claude Code / Codex / Hermes / Quark Agent）
 * 抽象为统一的上下文读写接口，让 RelayService 可以跨 harness 中继。
 *
 * 核心接口：
 * - exportContext(): 从当前 harness 导出上下文（读 CLAUDE.md / AGENTS.md / Memory 等）
 * - importContext(): 向当前 harness 注入外部上下文（写 CLAUDE.md / AGENTS.md / Memory 等）
 *
 * 实现适配器：
 * - QuarkAgentAdapter: 包装 Quark Agent 的 SqliteMemory（已有能力的复用）
 * - FileBasedAdapter: 通用文件适配器（Claude Code 的 CLAUDE.md、Codex 的 AGENTS.md 等）
 * - ClaudeCodeAdapter: 继承 FileBasedAdapter，文件名 CLAUDE.md + .claude/agents/
 * - CodexAdapter: 继承 FileBasedAdapter，文件名 AGENTS.md
 * - HermesAdapter: 读写 SOUL.md + MEMORY.md + sessions
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Memory, MemoryEntry } from "../core/types.js";

// ============================================================================
// 核心接口
// ============================================================================

/** harness 标识 */
export type HarnessType = "quark-agent" | "claude-code" | "codex" | "hermes" | string;

/** 上下文块（跨 harness 的统一表示） */
export interface ContextBlock {
  /** 来源 harness */
  sourceHarness: HarnessType;
  /** 来源 session 标识 */
  sourceSession: string;
  /** 消息角色 */
  role: "user" | "assistant" | "system";
  /** 消息内容 */
  content: string;
  /** 时间戳 */
  timestamp: number;
  /** 额外元数据 */
  meta?: Record<string, unknown>;
}

/** 导出过滤条件 */
export interface ExportFilter {
  lastN?: number;
  sinceTs?: number;
  untilTs?: number;
  keywords?: string[];
}

/** Harness 适配器接口 */
export interface HarnessAdapter {
  /** harness 类型标识 */
  readonly harnessId: HarnessType;
  /** 当前 session 标识 */
  readonly sessionId: string;
  /** 工作区根目录 */
  readonly rootDir: string;

  /** 从当前 harness 导出上下文 */
  exportContext(filter?: ExportFilter): Promise<ContextBlock[]>;

  /** 向当前 harness 注入外部上下文 */
  importContext(blocks: ContextBlock[], opts?: ImportOptions): Promise<ImportResult>;

  /** 获取当前 harness 的可读状态摘要 */
  getStatus(): Promise<HarnessStatus>;
}

/** 导入选项 */
export interface ImportOptions {
  /** 写入模式：append（追加到文件末尾）/ prepend（文件头部）/ replace（替换全部） */
  mode?: "append" | "prepend" | "replace";
  /** 目标文件名（FileBasedAdapter 用） */
  targetFile?: string;
  /** 是否用 system 角色包装 */
  wrapAsSystem?: boolean;
  /** 格式化模板（{content} 占位） */
  template?: string;
}

/** 导入结果 */
export interface ImportResult {
  /** 写入的字节数 */
  bytesWritten: number;
  /** 写入的目标路径 */
  targetPath: string;
  /** 注入的 block 数 */
  blockCount: number;
}

/** harness 状态 */
export interface HarnessStatus {
  harnessId: HarnessType;
  sessionId: string;
  rootDir: string;
  /** 上下文文件是否存在 */
  contextFiles: string[];
  /** 最后更新时间 */
  lastUpdated?: number;
  /** 额外信息 */
  meta?: Record<string, unknown>;
}

// ============================================================================
// QuarkAgentAdapter —— 包装 Quark Agent 的 Memory
// ============================================================================

export class QuarkAgentAdapter implements HarnessAdapter {
  readonly harnessId: HarnessType = "quark-agent";

  constructor(
    readonly rootDir: string,
    readonly sessionId: string,
    private memory: Memory,
  ) {}

  async exportContext(filter?: ExportFilter): Promise<ContextBlock[]> {
    const entries = await this.memory.list({
      sessionId: this.sessionId,
      layer: "L0",
      kind: "chat",
    });

    let filtered = entries;

    if (filter?.sinceTs) {
      filtered = filtered.filter((e) => e.createdAt >= filter.sinceTs!);
    }
    if (filter?.untilTs) {
      filtered = filtered.filter((e) => e.createdAt <= filter.untilTs!);
    }
    if (filter?.keywords && filter.keywords.length > 0) {
      filtered = filtered.filter((e) =>
        filter.keywords!.some((kw) => e.content.includes(kw)),
      );
    }
    if (filter?.lastN && filter.lastN > 0) {
      filtered = filtered
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-filter.lastN);
    }

    return filtered.map((e) => this.toContextBlock(e));
  }

  async importContext(blocks: ContextBlock[], opts?: ImportOptions): Promise<ImportResult> {
    const content = this.formatBlocks(blocks, opts);
    const id = await this.memory.add({
      userId: "relay",
      sessionId: this.sessionId,
      kind: "chat",
      layer: "L1",
      content,
      domain: "relay",
      importance: 0.8,
      meta: {
        sourceHarness: blocks[0]?.sourceHarness,
        blockCount: blocks.length,
        relayedAt: Date.now(),
      },
    });

    return {
      bytesWritten: content.length,
      targetPath: `memory:${id}`,
      blockCount: blocks.length,
    };
  }

  async getStatus(): Promise<HarnessStatus> {
    return {
      harnessId: this.harnessId,
      sessionId: this.sessionId,
      rootDir: this.rootDir,
      contextFiles: ["sqlite-memory"],
    };
  }

  private toContextBlock(e: MemoryEntry): ContextBlock {
    const meta = e.meta as Record<string, unknown> | undefined;
    return {
      sourceHarness: (meta?.sourceHarness as HarnessType) ?? "quark-agent",
      sourceSession: this.sessionId,
      role: (meta?.role as "user" | "assistant" | "system") ?? "user",
      content: e.content,
      timestamp: e.createdAt,
      meta: e.meta,
    };
  }

  private formatBlocks(blocks: ContextBlock[], _opts?: ImportOptions): string {
    const header = `[Relayed Context — from ${blocks[0]?.sourceHarness ?? "unknown"} — ${blocks.length} messages]`;
    const lines = [header];
    for (const b of blocks) {
      const time = new Date(b.timestamp).toISOString().slice(0, 19);
      lines.push(`[${b.role}] [${time}] ${b.content}`);
    }
    return lines.join("\n");
  }
}

// ============================================================================
// FileBasedAdapter —— 通用文件适配器（Claude Code / Codex / 通用）
// ============================================================================

export class FileBasedAdapter implements HarnessAdapter {
  readonly harnessId: HarnessType;
  readonly rootDir: string;
  readonly sessionId: string;

  /** 主上下文文件名（如 CLAUDE.md、AGENTS.md） */
  protected contextFile: string;
  /** 子 agent 目录（如 .claude/agents/） */
  protected agentsDir?: string;

  constructor(opts: {
    harnessId: HarnessType;
    rootDir: string;
    sessionId: string;
    contextFile: string;
    agentsDir?: string;
  }) {
    this.harnessId = opts.harnessId;
    this.rootDir = resolve(opts.rootDir);
    this.sessionId = opts.sessionId;
    this.contextFile = opts.contextFile;
    this.agentsDir = opts.agentsDir;
  }

  async exportContext(filter?: ExportFilter): Promise<ContextBlock[]> {
    const filePath = join(this.rootDir, this.contextFile);
    if (!existsSync(filePath)) return [];

    const content = readFileSync(filePath, "utf-8");
    if (!content.trim()) return [];

    // 把文件内容按 section 分割成多个 ContextBlock
    const sections = this.splitSections(content);
    let blocks = sections.map((s, i) => ({
      sourceHarness: this.harnessId,
      sourceSession: this.sessionId,
      role: "system" as const,
      content: s,
      timestamp: Date.now() - (sections.length - i) * 1000,
    }));

    // 关键词过滤
    if (filter?.keywords && filter.keywords.length > 0) {
      blocks = blocks.filter((b) =>
        filter.keywords!.some((kw) => b.content.includes(kw)),
      );
    }

    // lastN
    if (filter?.lastN && filter.lastN > 0) {
      blocks = blocks.slice(-filter.lastN);
    }

    return blocks;
  }

  async importContext(blocks: ContextBlock[], opts?: ImportOptions): Promise<ImportResult> {
    const targetFile = opts?.targetFile ?? this.contextFile;
    const targetPath = join(this.rootDir, targetFile);
    const mode = opts?.mode ?? "append";

    // 确保目录存在
    mkdirSync(this.rootDir, { recursive: true });

    const blockContent = this.formatBlocks(blocks, opts);
    const relayBlock = `\n\n## [Relayed Context — from ${blocks[0]?.sourceHarness ?? "unknown"} — ${new Date().toISOString()}]\n\n${blockContent}\n`;

    let finalContent: string;
    if (mode === "replace" || !existsSync(targetPath)) {
      finalContent = relayBlock.trim();
      writeFileSync(targetPath, finalContent, "utf-8");
    } else {
      const existing = readFileSync(targetPath, "utf-8");
      if (mode === "prepend") {
        finalContent = relayBlock + "\n" + existing;
      } else {
        // append
        finalContent = existing + relayBlock;
        appendFileSync(targetPath, relayBlock, "utf-8");
        finalContent = relayBlock;
      }
    }

    return {
      bytesWritten: relayBlock.length,
      targetPath,
      blockCount: blocks.length,
    };
  }

  async getStatus(): Promise<HarnessStatus> {
    const files: string[] = [];
    const mainPath = join(this.rootDir, this.contextFile);
    if (existsSync(mainPath)) {
      files.push(this.contextFile);
    }
    if (this.agentsDir) {
      const agentPath = join(this.rootDir, this.agentsDir);
      if (existsSync(agentPath)) {
        files.push(this.agentsDir);
      }
    }
    return {
      harnessId: this.harnessId,
      sessionId: this.sessionId,
      rootDir: this.rootDir,
      contextFiles: files,
    };
  }

  /** 把文件内容按 ## 标题分割成 sections */
  protected splitSections(content: string): string[] {
    const lines = content.split("\n");
    const sections: string[] = [];
    let current: string[] = [];

    for (const line of lines) {
      if (/^##\s+/.test(line) && current.length > 0) {
        sections.push(current.join("\n").trim());
        current = [];
      }
      current.push(line);
    }
    if (current.length > 0) {
      sections.push(current.join("\n").trim());
    }

    return sections.filter((s) => s.length > 0);
  }

  /** 格式化 blocks 为文本 */
  protected formatBlocks(blocks: ContextBlock[], opts?: ImportOptions): string {
    if (opts?.template) {
      return blocks
        .map((b) => opts.template!.replace("{content}", b.content).replace("{role}", b.role))
        .join("\n");
    }

    const lines: string[] = [];
    for (const b of blocks) {
      const time = new Date(b.timestamp).toISOString().slice(0, 19);
      if (opts?.wrapAsSystem) {
        lines.push(`**[${b.sourceHarness}] [${time}]**\n${b.content}`);
      } else {
        lines.push(`[${b.role}] [${b.sourceHarness}] [${time}] ${b.content}`);
      }
    }
    return lines.join("\n");
  }
}

// ============================================================================
// 预置适配器：Claude Code / Codex / Hermes
// ============================================================================

/** Claude Code 适配器：读写 CLAUDE.md + .claude/agents/ */
export class ClaudeCodeAdapter extends FileBasedAdapter {
  constructor(rootDir: string, sessionId: string) {
    super({
      harnessId: "claude-code",
      rootDir,
      sessionId,
      contextFile: "CLAUDE.md",
      agentsDir: ".claude/agents",
    });
  }

  /** 导出时还读 .claude/agents/ 下的 subagent 定义 */
  async exportContext(filter?: ExportFilter): Promise<ContextBlock[]> {
    const blocks = await super.exportContext(filter);

    // 额外读 subagent 定义
    const agentsPath = join(this.rootDir, this.agentsDir ?? ".claude/agents");
    if (existsSync(agentsPath)) {
      // 简化：把 agents 目录路径作为 meta 附加上
      blocks.push({
        sourceHarness: this.harnessId,
        sourceSession: this.sessionId,
        role: "system",
        content: `[Claude Code subagents at ${agentsPath}]`,
        timestamp: Date.now(),
        meta: { agentsDir: agentsPath },
      });
    }

    return blocks;
  }
}

/** Codex 适配器：读写 AGENTS.md */
export class CodexAdapter extends FileBasedAdapter {
  constructor(rootDir: string, sessionId: string) {
    super({
      harnessId: "codex",
      rootDir,
      sessionId,
      contextFile: "AGENTS.md",
    });
  }
}

/** Hermes 适配器：读写 SOUL.md + MEMORY.md */
export class HermesAdapter extends FileBasedAdapter {
  constructor(rootDir: string, sessionId: string) {
    super({
      harnessId: "hermes",
      rootDir,
      sessionId,
      contextFile: "MEMORY.md",
      agentsDir: undefined,
    });
  }

  /** Hermes 额外导出 SOUL.md */
  async exportContext(filter?: ExportFilter): Promise<ContextBlock[]> {
    const blocks = await super.exportContext(filter);

    // 读 SOUL.md
    const soulPath = join(this.rootDir, "SOUL.md");
    if (existsSync(soulPath)) {
      const soulContent = readFileSync(soulPath, "utf-8");
      blocks.unshift({
        sourceHarness: this.harnessId,
        sourceSession: this.sessionId,
        role: "system",
        content: soulContent,
        timestamp: Date.now(),
        meta: { file: "SOUL.md" },
      });
    }

    return blocks;
  }

  /** Hermes 导入时也写到 MEMORY.md（append 模式） */
  async importContext(blocks: ContextBlock[], opts?: ImportOptions): Promise<ImportResult> {
    // 默认 append 到 MEMORY.md
    return super.importContext(blocks, {
      mode: "append",
      wrapAsSystem: true,
      ...opts,
    });
  }
}

// ============================================================================
// 适配器工厂
// ============================================================================

/** 按类型创建适配器 */
export function createHarnessAdapter(
  type: HarnessType,
  rootDir: string,
  sessionId: string,
  memory?: Memory,
): HarnessAdapter {
  switch (type) {
    case "claude-code":
      return new ClaudeCodeAdapter(rootDir, sessionId);
    case "codex":
      return new CodexAdapter(rootDir, sessionId);
    case "hermes":
      return new HermesAdapter(rootDir, sessionId);
    case "quark-agent":
      if (!memory) throw new Error("QuarkAgentAdapter requires Memory instance");
      return new QuarkAgentAdapter(rootDir, sessionId, memory);
    default:
      // 通用文件适配器
      return new FileBasedAdapter({
        harnessId: type,
        rootDir,
        sessionId,
        contextFile: "CONTEXT.md",
      });
  }
}
