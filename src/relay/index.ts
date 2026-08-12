/**
 * RelayService —— 跨 session / 跨平台上下文中继
 *
 * 设计（对标 OpenClaw sub-agent session sharing + Hermes gateway routing）：
 * - 在已有隔离层上开可控穿透通道，不打破隔离
 * - relayed 消息存为 L1 + domain="relay"，不污染 L0 working memory
 * - ContextBuilder 在 RAG 层注入 relay block，独立 token 预算
 * - 支持 on-demand / realtime 两种模式
 *
 * 数据流：
 *   relay() → 读 source session 的 L0/L1 → 变换（脱敏/摘要/截断）→ 注入 target session 的 L1
 *   getRelayedContext() → 读 target session 的 relay 条目 → 格式化为 context block
 *   realtime → EventBus 监听 source 新消息 → 自动 relay
 */

import type { Memory, MemoryEntry, Provider, Tool, ToolSchema, ToolContext } from "../core/types.js";
import { estimateTokens } from "../memory/compress.js";
import type { HarnessAdapter, ContextBlock, ExportFilter } from "./harness-adapter.js";

// ============================================================================
// 类型定义
// ============================================================================

/** relay 来源 */
export interface RelaySource {
  /** 源平台名（feishu / wechat / telegram / ...） */
  channel?: string;
  /** 源 session ID（精确指定时用） */
  sessionId?: string;
  /** 源用户 ID（per-peer 隔离时用） */
  userId?: string;
  /** 获取范围 */
  range: {
    /** 最近 N 条消息 */
    lastN?: number;
    /** 从某个时间戳开始 */
    sinceTs?: number;
    /** 到某个时间戳结束 */
    untilTs?: number;
  };
}

/** relay 目标 */
export interface RelayTarget {
  /** 目标 session ID */
  sessionId: string;
  /** 目标用户 ID */
  userId?: string;
}

/** relay 策略：控制变换规则 */
export interface RelayPolicy {
  /** 摘要而非原文（节省 token，但需要 Provider） */
  summarize?: boolean;
  /** relayed context 的 token 上限 */
  maxTokens?: number;
  /** 脱敏正则（如手机号、身份证号） */
  redactPatterns?: Array<{ pattern: string; replacement: string }>;
  /** 是否包含发送者信息 */
  includeSenderInfo?: boolean;
  /** 关键词过滤（只 relay 包含这些关键词的消息） */
  filterKeywords?: string[];
  /** 导入模式（跨 harness relay 时：追加/插入头部/替换） */
  importMode?: "append" | "prepend" | "replace";
}

/** relay 配置 */
export interface RelayRequest {
  source: RelaySource;
  target: RelayTarget;
  policy?: RelayPolicy;
  /** 调度模式 */
  schedule?: "on-demand" | "realtime";
  /** realtime 模式下，EventBus 的监听事件类型 */
  realtimeEvent?: string;
}

/** relay 结果 */
export interface RelayResult {
  relayId: string;
  sourceSessionId: string;
  targetSessionId: string;
  relayedCount: number;
  contextBlock: string;
  tokenCount: number;
}

/** 活跃的 realtime relay */
interface ActiveRelay {
  config: RelayRequest;
  relayId: string;
  cleanup?: () => void;
}

/** EventBus 接口（用于 realtime relay） */
export interface RelayEventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
}

// ============================================================================
// RelayService —— 核心服务
// ============================================================================

export class RelayService {
  private activeRelays = new Map<string, ActiveRelay>();

  constructor(
    private memory?: Memory,
    private provider?: Provider,
    private model?: string,
  ) {}

  /**
   * 一次性 relay：从 source session 读取消息 → 变换 → 注入 target session
   */
  async relay(config: RelayRequest): Promise<RelayResult> {
    if (!this.memory) throw new Error("RelayService.relay() requires Memory instance in constructor");
    const relayId = `relay-${Date.now().toString(36)}`;
    const policy = config.policy ?? {};

    // 1. 从 source session 读取消息
    const sourceMessages = await this.fetchSourceMessages(config.source);
    if (sourceMessages.length === 0) {
      return {
        relayId,
        sourceSessionId: config.source.sessionId ?? "(unknown)",
        targetSessionId: config.target.sessionId,
        relayedCount: 0,
        contextBlock: "",
        tokenCount: 0,
      };
    }

    // 2. 变换：脱敏 → 过滤 → 摘要/格式化
    const transformed = this.transformMessages(sourceMessages, policy);

    // 2.5 摘要（如果启用且有 provider）
    let finalContextBlock: string;
    if (policy.summarize && this.provider) {
      finalContextBlock = await this.summarizeMessages(transformed, config.source, policy);
    } else {
      finalContextBlock = this.formatContextBlock(transformed, config.source, policy);
    }

    // 3. 格式化为 context block（摘要模式下已经是格式化后的）
    const contextBlock = finalContextBlock;

    const tokenCount = estimateTokens(contextBlock);

    // 4. 注入 target session（存为 L1 + domain="relay"）
    await this.memory.add({
      userId: config.target.userId ?? "system",
      sessionId: config.target.sessionId,
      kind: "chat",
      layer: "L1",
      content: contextBlock,
      domain: "relay",
      importance: 0.8,
      meta: {
        relayId,
        sourceSessionId: config.source.sessionId,
        sourceChannel: config.source.channel,
        relayedAt: Date.now(),
        relayedCount: transformed.length,
        tokenCount,
      },
    });

    return {
      relayId,
      sourceSessionId: config.source.sessionId ?? "(unknown)",
      targetSessionId: config.target.sessionId,
      relayedCount: transformed.length,
      contextBlock,
      tokenCount,
    };
  }

  /**
   * 获取某 session 的所有 relayed context（供 ContextBuilder 调用）
   */
  async getRelayedContext(sessionId: string, budget: number = 2000): Promise<string> {
    if (!this.memory) throw new Error("RelayService.getRelayedContext() requires Memory instance");
    const entries = await this.memory.list({
      sessionId,
      layer: "L1",
      kind: "chat",
    });

    const relayEntries = entries.filter((e) => e.domain === "relay");
    if (relayEntries.length === 0) return "";

    // 按 relayedAt 降序排列（最新的在前）
    relayEntries.sort((a, b) => {
      const ta = (a.meta?.relayedAt as number) ?? a.createdAt;
      const tb = (b.meta?.relayedAt as number) ?? b.createdAt;
      return tb - ta;
    });

    // 在 token 预算内组装
    const parts: string[] = [];
    let used = 0;
    for (const entry of relayEntries) {
      const tokens = estimateTokens(entry.content);
      if (used + tokens > budget) {
        const remaining = budget - used;
        if (remaining > 50) {
          parts.push(entry.content.slice(0, remaining * 4));
        }
        break;
      }
      parts.push(entry.content);
      used += tokens;
    }

    return parts.join("\n\n---\n\n");
  }

  /**
   * 启动 realtime relay：监听 source session 新消息 → 自动注入 target
   */
  async startRealtime(
    config: RelayRequest,
    bus?: RelayEventBus,
  ): Promise<string> {
    const relayId = `relay-rt-${Date.now().toString(36)}`;
    const eventType = config.realtimeEvent ?? "message:received";

    if (!bus) {
      // 无 EventBus 时，降级为 on-demand
      const result = await this.relay(config);
      return result.relayId;
    }

    // 监听 source 的新消息
    const off = bus.on(eventType, async (data: unknown) => {
      const msg = data as { sessionId?: string; userId?: string; channel?: string };
      if (!msg) return;

      // 判断是否来自 source
      const isFromSource =
        (!config.source.sessionId || msg.sessionId === config.source.sessionId) &&
        (!config.source.channel || msg.channel === config.source.channel) &&
        (!config.source.userId || msg.userId === config.source.userId);

      if (!isFromSource) return;

      // 触发 relay（只 relay 最新 1 条）
      await this.relay({
        ...config,
        source: { ...config.source, range: { lastN: 1 } },
      });
    });

    this.activeRelays.set(relayId, { config, relayId, cleanup: off });

    return relayId;
  }

  /** 停止 realtime relay */
  stop(relayId: string): boolean {
    const active = this.activeRelays.get(relayId);
    if (!active) return false;
    active.cleanup?.();
    this.activeRelays.delete(relayId);
    return true;
  }

  /** 列出所有活跃 relay */
  listActive(): Array<{ relayId: string; source: string; target: string }> {
    return [...this.activeRelays.values()].map((a) => ({
      relayId: a.relayId,
      source: a.config.source.sessionId ?? a.config.source.channel ?? "(unknown)",
      target: a.config.target.sessionId,
    }));
  }

  /** 停止所有 realtime relay */
  stopAll(): void {
    for (const [, active] of this.activeRelays) {
      active.cleanup?.();
    }
    this.activeRelays.clear();
  }

  // ========================================================================
  // 跨 harness relay（HarnessAdapter → HarnessAdapter）
  // ========================================================================

  /**
   * 跨 harness relay：从 source adapter 导出上下文 → 变换 → 注入 target adapter
   *
   * 场景：
   *   - Claude Code → Codex：relay CCMD.md + .claude/agents → AGENTS.md
   *   - Codex → Quark Agent：relay AGENTS.md → Memory L1 relay
   *   - Hermes → Claude Code：relay SOUL.md + MEMORY.md → CLAUDE.md
   */
  async relayCrossHarness(
    source: HarnessAdapter,
    target: HarnessAdapter,
    filter?: ExportFilter,
    policy?: RelayPolicy,
  ): Promise<RelayResult> {
    const relayId = `relay-xh-${Date.now().toString(36)}`;
    const p = policy ?? {};

    // 1. 从 source adapter 导出上下文
    let blocks = await source.exportContext(filter);
    if (blocks.length === 0) {
      return {
        relayId,
        sourceSessionId: source.sessionId,
        targetSessionId: target.sessionId,
        relayedCount: 0,
        contextBlock: "",
        tokenCount: 0,
      };
    }

    // 2. 脱敏
    if (p.redactPatterns && p.redactPatterns.length > 0) {
      blocks = blocks.map((b) => ({
        ...b,
        content: this.redact(b.content, p.redactPatterns!),
      }));
    }

    // 3. 关键词过滤
    if (p.filterKeywords && p.filterKeywords.length > 0) {
      blocks = blocks.filter((b) =>
        p.filterKeywords!.some((kw) => b.content.includes(kw)),
      );
    }

    // 4. token 预算截断
    const maxTokens = p.maxTokens ?? 2000;
    const filtered: ContextBlock[] = [];
    let usedTokens = 0;
    for (const b of blocks) {
      const tokens = estimateTokens(b.content);
      if (usedTokens + tokens > maxTokens) break;
      filtered.push(b);
      usedTokens += tokens;
    }

    // 5. 注入 target adapter
    await target.importContext(filtered, {
      mode: p.importMode,
      wrapAsSystem: true,
    });

    const contextBlock = filtered
      .map((b) => `[${b.role}] [${b.sourceHarness}] ${b.content}`)
      .join("\n");

    return {
      relayId,
      sourceSessionId: `${source.harnessId}:${source.sessionId}`,
      targetSessionId: `${target.harnessId}:${target.sessionId}`,
      relayedCount: filtered.length,
      contextBlock,
      tokenCount: usedTokens,
    };
  }

  // ========================================================================
  // 内部方法
  // ========================================================================

  /** 从 source session 读取消息 */
  private async fetchSourceMessages(source: RelaySource): Promise<MemoryEntry[]> {
    if (!this.memory) throw new Error("RelayService.fetchSourceMessages() requires Memory instance");
    const filter: { userId?: string; sessionId?: string; layer?: "L0" | "L1"; kind?: "chat" } = {};

    if (source.userId) filter.userId = source.userId;
    if (source.sessionId) filter.sessionId = source.sessionId;

    // 优先读 L0（working memory），没有则读 L1（summary）
    filter.layer = "L0";
    filter.kind = "chat";

    let entries = await this.memory.list(filter);

    // 如果 L0 没有，降级到 L1
    if (entries.length === 0) {
      filter.layer = "L1";
      entries = await this.memory.list(filter);
    }

    // 时间范围过滤
    let filtered = entries;
    if (source.range.sinceTs) {
      filtered = filtered.filter((e) => e.createdAt >= source.range.sinceTs!);
    }
    if (source.range.untilTs) {
      filtered = filtered.filter((e) => e.createdAt <= source.range.untilTs!);
    }

    // 按 lastN 截取（取最新的 N 条，正序排列）
    if (source.range.lastN && source.range.lastN > 0) {
      filtered = filtered
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-source.range.lastN);
    } else {
      filtered = filtered.sort((a, b) => a.createdAt - b.createdAt);
    }

    return filtered;
  }

  /** 变换消息：脱敏 → 关键词过滤 */
  private transformMessages(
    entries: MemoryEntry[],
    policy: RelayPolicy,
  ): MemoryEntry[] {
    let result = entries;

    // 1. 关键词过滤
    if (policy.filterKeywords && policy.filterKeywords.length > 0) {
      result = result.filter((e) =>
        policy.filterKeywords!.some((kw) => e.content.includes(kw)),
      );
    }

    // 2. 脱敏
    if (policy.redactPatterns && policy.redactPatterns.length > 0) {
      result = result.map((e) => ({
        ...e,
        content: this.redact(e.content, policy.redactPatterns!),
      }));
    }

    return result;
  }

  /** 用 LLM 摘要消息（无 provider 时降级为格式化） */
  private async summarizeMessages(
    entries: MemoryEntry[],
    source: RelaySource,
    policy: RelayPolicy,
  ): Promise<string> {
    const sourceLabel = source.channel
      ? `${source.channel}:${source.sessionId ?? "unknown"}`
      : source.sessionId ?? "unknown";

    const rawBlock = this.formatContextBlock(entries, source, policy);

    if (this.provider?.chat) {
      try {
        const resp = await this.provider.chat({
          messages: [
            {
              role: "system",
              content: `你是摘要助手。将以下聊天记录压缩为简洁摘要，保留关键事实、决定和待办。不超过 ${policy.maxTokens ?? 500} tokens。`,
            },
            { role: "user", content: rawBlock },
          ],
          model: this.model ?? "",
          temperature: 0.3,
          maxTokens: policy.maxTokens ?? 500,
        });
        return `[Relayed Summary — 来源: ${sourceLabel} — 摘要]\n${resp.content}`;
      } catch {
        // 降级
      }
    }

    return rawBlock;
  }

  /** 格式化为 context block */
  private formatContextBlock(
    entries: MemoryEntry[],
    source: RelaySource,
    policy: RelayPolicy,
  ): string {
    const sourceLabel = source.channel
      ? `${source.channel}:${source.sessionId ?? "unknown"}`
      : source.sessionId ?? "unknown";

    const maxTokens = policy.maxTokens ?? 2000;
    const header = `[Relayed Context — 来源: ${sourceLabel} — ${entries.length}条消息]`;
    const lines: string[] = [header];

    let usedTokens = estimateTokens(header);

    for (const entry of entries) {
      const role = this.extractRole(entry);
      const sender = policy.includeSenderInfo ? ` [${entry.userId}]` : "";
      const time = policy.includeSenderInfo
        ? ` [${new Date(entry.createdAt).toISOString().slice(0, 19)}]`
        : "";
      const line = `${role}${sender}${time}: ${entry.content}`;
      const lineTokens = estimateTokens(line);

      if (usedTokens + lineTokens > maxTokens) break;

      lines.push(line);
      usedTokens += lineTokens;
    }

    return lines.join("\n");
  }

  /** 从 MemoryEntry 提取角色 */
  private extractRole(entry: MemoryEntry): string {
    const meta = entry.meta as Record<string, unknown> | undefined;
    const role = meta?.role as string | undefined;
    if (role) return role;

    if (entry.content.startsWith("user:")) return "user";
    if (entry.content.startsWith("assistant:")) return "assistant";
    return "user";
  }

  /** 脱敏处理 */
  private redact(
    text: string,
    patterns: Array<{ pattern: string; replacement: string }>,
  ): string {
    let result = text;
    for (const { pattern, replacement } of patterns) {
      try {
        const regex = new RegExp(pattern, "g");
        result = result.replace(regex, replacement);
      } catch {
        // 无效正则跳过
      }
    }
    return result;
  }
}

// ============================================================================
// RelayTool —— 让 LLM 可以自然语言触发 relay
// ============================================================================

export interface RelayToolOptions {
  relayService: RelayService;
}

/** 创建 relay 工具，LLM 可调用 sync_context 触发跨 session relay */
export function createRelayTool(opts: RelayToolOptions): Tool {
  const relay = opts.relayService;

  const schema: ToolSchema = {
    type: "function",
    function: {
      name: "sync_context",
      description:
        "从另一个聊天会话同步上下文到当前会话。用于跨群/跨平台信息中继。" +
        "例如：把飞书A群的最近消息同步到当前群，或把微信跟某人的对话同步过来分析。",
      parameters: {
        type: "object",
        properties: {
          source_channel: {
            type: "string",
            description: "来源平台（feishu/wechat/telegram 等）",
          },
          source_session_id: {
            type: "string",
            description: "来源会话 ID（群 ID 或对话 ID）",
          },
          source_user_id: {
            type: "string",
            description: "来源用户 ID（可选，用于 per-peer 隔离）",
          },
          last_n: {
            type: "number",
            description: "同步最近 N 条消息（默认 50）",
          },
          summarize: {
            type: "boolean",
            description: "是否摘要而非原文（节省 token，默认 false）",
          },
        },
        required: ["source_channel"],
      },
    },
  };

  return {
    name: "sync_context",
    description: schema.function.description,
    schema,
    async execute(
      args: {
        source_channel?: string;
        source_session_id?: string;
        source_user_id?: string;
        last_n?: number;
        summarize?: boolean;
      },
      ctx: ToolContext,
    ): Promise<string> {
      const identity = ctx.meta?.identity as { sessionId?: string; userId?: string } | undefined;
      const targetSessionId = identity?.sessionId ?? "unknown";
      const targetUserId = identity?.userId ?? "unknown";

      if (!args.source_channel && !args.source_session_id) {
        return "[error] 需要指定 source_channel 或 source_session_id";
      }

      const result = await relay.relay({
        source: {
          channel: args.source_channel,
          sessionId: args.source_session_id,
          userId: args.source_user_id,
          range: { lastN: args.last_n ?? 50 },
        },
        target: {
          sessionId: targetSessionId,
          userId: targetUserId,
        },
        policy: {
          summarize: args.summarize ?? false,
          maxTokens: 2000,
          includeSenderInfo: true,
          redactPatterns: [
            { pattern: "\\d{11}", replacement: "[手机号]" },
            { pattern: "\\d{17}[0-9Xx]", replacement: "[身份证]" },
          ],
        },
      });

      return `[relay] 已同步 ${result.relayedCount} 条消息（${result.tokenCount} tokens）从 ${result.sourceSessionId} 到 ${result.targetSessionId}`;
    },
  };
}
