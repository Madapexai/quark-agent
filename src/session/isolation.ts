/**
 * Context Isolation Policy —— 上下文隔离策略
 *
 * 设计（对标 OpenClaw dmScope + session types）：
 * - SessionScope 控制不同聊天窗口之间的上下文隔离粒度
 * - main：所有会话共享同一上下文（类似 Hermes Profile）
 * - isolated：每个会话独立上下文（OpenClaw 默认行为）
 * - per-peer：按发送者 ID 隔离
 * - named：命名会话，可显式复用
 *
 * SessionRouter 负责根据 policy 把入站消息路由到正确的 session，
 * 并控制 L0 working memory 的可见性边界。
 */

import type { Identity, MemoryEntry } from "../core/types.js";

// ============================================================================
// 隔离策略类型
// ============================================================================

/** 隔离模式 */
export type IsolationMode = "main" | "isolated" | "per-peer" | "named";

/** 会话作用域配置 */
export interface SessionScopeConfig {
  /** 隔离模式，默认 isolated */
  mode: IsolationMode;
  /** named 模式下的会话名映射：source → sessionName */
  namedMappings?: Record<string, string>;
  /** per-peer 模式下的 peer ID 提取函数标识 */
  peerIdField?: string;
  /** main 模式下的共享会话 ID */
  mainSessionId?: string;
}

/** 会话路由结果 */
export interface SessionRouteResult {
  /** 解析出的 session ID */
  sessionId: string;
  /** 该会话的隔离模式 */
  mode: IsolationMode;
  /** 是否为新建会话 */
  isNew: boolean;
  /** 会话的 identity */
  identity: Identity;
}

/** 入站消息上下文 */
export interface InboundContext {
  /** 来源通道（telegram, discord, api, ...） */
  channel: string;
  /** 发送者 ID */
  peerId?: string;
  /** 群组/房间 ID */
  roomId?: string;
  /** 是否为 DM */
  isDM: boolean;
  /** 显式指定的 session 名（用于 named 模式） */
  sessionName?: string;
  /** 用户 ID */
  userId: string;
  /** 原始消息文本 */
  text: string;
}

// ============================================================================
// Identity 重导出（方便调用方）
// ============================================================================

export type { Identity } from "../core/types.js";

// ============================================================================
// SessionRouter —— 根据隔离策略路由消息到正确的 session
// ============================================================================

export class SessionRouter {
  private config: SessionScopeConfig;
  private activeSessions = new Map<string, { createdAt: number; lastActiveAt: number }>();

  constructor(config: Partial<SessionScopeConfig> = {}) {
    this.config = {
      mode: config.mode ?? "isolated",
      namedMappings: config.namedMappings ?? {},
      peerIdField: config.peerIdField ?? "peerId",
      mainSessionId: config.mainSessionId ?? "main",
    };
  }

  /** 根据入站消息上下文解析目标 session */
  route(inbound: InboundContext): SessionRouteResult {
    const { mode, mainSessionId, namedMappings } = this.config;
    let sessionId: string;
    let isNew = false;

    switch (mode) {
      case "main":
        // 所有消息汇聚到同一个 session（类似 Hermes Profile）
        sessionId = mainSessionId!;
        isNew = !this.activeSessions.has(sessionId);
        break;

      case "per-peer":
        // 按发送者 ID 隔离
        sessionId = inbound.peerId
          ? `${inbound.channel}:peer:${inbound.peerId}`
          : `${inbound.channel}:anon:${inbound.roomId ?? "default"}`;
        isNew = !this.activeSessions.has(sessionId);
        break;

      case "named":
        // 命名会话：先查显式 sessionName，再查映射表（用 channel:peerId 或 roomId 作 key），最后 fallback
        const namedKey = inbound.roomId ?? `${inbound.channel}:${inbound.peerId ?? "default"}`;
        sessionId =
          inbound.sessionName ??
          namedMappings![namedKey] ??
          (inbound.isDM
            ? `${inbound.channel}:dm:${inbound.peerId ?? "default"}`
            : `${inbound.channel}:room:${inbound.roomId ?? "default"}`);
        isNew = !this.activeSessions.has(sessionId);
        break;

      case "isolated":
      default:
        // 每个独立的聊天窗口/房间独立 session
        // 优先用 peerId/roomId 作为唯一标识，避免 Date.now() 同毫秒碰撞
        const isoKey = inbound.peerId ?? inbound.roomId ?? Math.random().toString(36).slice(2, 10);
        sessionId = `${inbound.channel}:${inbound.isDM ? "dm" : "group"}:${isoKey}`;
        isNew = true;
        break;
    }

    const now = Date.now();
    this.activeSessions.set(sessionId, { createdAt: now, lastActiveAt: now });

    const identity: Identity = {
      userId: inbound.userId,
      sessionId,
      channel: inbound.channel,
    };

    return { sessionId, mode, isNew, identity };
  }

  /** 获取活跃会话列表 */
  listActiveSessions(): Array<{ sessionId: string; createdAt: number; lastActiveAt: number }> {
    return [...this.activeSessions.entries()].map(([sessionId, info]) => ({
      sessionId,
      ...info,
    }));
  }

  /** 获取活跃会话 ID 列表（便捷方法） */
  getActiveSessions(): string[] {
    return [...this.activeSessions.keys()];
  }

  /** 关闭会话（触发 L0→L1 压缩的信号）。传入 "__all__" 清空所有会话 */
  closeSession(sessionId: string): boolean {
    if (sessionId === "__all__") {
      const had = this.activeSessions.size;
      this.activeSessions.clear();
      return had > 0;
    }
    return this.activeSessions.delete(sessionId);
  }

  /** 更新配置 */
  updateConfig(patch: Partial<SessionScopeConfig>): void {
    Object.assign(this.config, patch);
  }

  /** 当前配置 */
  get currentConfig(): Readonly<SessionScopeConfig> {
    return { ...this.config };
  }
}

// ============================================================================
// ContextVisibility —— 控制 L0 working memory 的跨 session 可见性
// ============================================================================

/** 上下文可见性策略 */
export interface VisibilityPolicy {
  /** 允许跨 session 读取 L0 working memory 的模式 */
  crossSessionL0: "never" | "same-user" | "same-channel" | "always";
  /** L1 summary 的跨 session 可见性 */
  crossSessionL1: "never" | "same-user" | "same-channel" | "always";
  /** L2 facts 默认跨 session（长期记忆） */
  crossSessionL2: "never" | "same-user" | "same-channel" | "always";
}

/** 作用域可见性配置（简洁版） */
export interface ScopeVisibility {
  L0: "session" | "user" | "channel" | "global";
  L1: "session" | "user" | "channel" | "global";
  L2: "session" | "user" | "channel" | "global";
  L3: "session" | "user" | "channel" | "global";
}

/** 默认可见性：L0/L1 session 级隔离，L2/L3 user 级共享 */
export const DEFAULT_SCOPE_VISIBILITY: ScopeVisibility = {
  L0: "session",
  L1: "session",
  L2: "user",
  L3: "user",
};

/**
 * 按可见性策略过滤 memory entries
 *
 * @param entries 待过滤的条目
 * @param scope 可见性配置（默认 L0/L1 session 级，L2/L3 user 级）
 * @param userId 请求者 userId
 * @param sessionId 请求者 sessionId
 */
export function filterByVisibility(
  entries: MemoryEntry[],
  scope: ScopeVisibility = DEFAULT_SCOPE_VISIBILITY,
  userId?: string,
  sessionId?: string,
): MemoryEntry[] {
  return entries.filter((entry) => {
    const layer = (entry.layer as string) || "L0";
    const visibility = scope[layer as keyof ScopeVisibility] ?? "session";

    // 没有 sessionId 的条目（L2/L3 长期记忆）
    if (!entry.sessionId) {
      switch (visibility) {
        case "session":
          return false; // L2/L3 没有 sessionId，session 级永远看不到
        case "user":
          return entry.userId === userId;
        case "channel":
          return entry.userId === userId; // 简化：channel 级 ≈ user 级
        case "global":
          return true;
      }
    }

    // 有 sessionId 的条目（L0 working memory / L1 summary）
    // 同 session 直接通过
    if (sessionId && entry.sessionId === sessionId) return true;

    switch (visibility) {
      case "session":
        return false;
      case "user":
        return entry.userId === userId;
      case "channel":
        return entry.userId === userId;
      case "global":
        return true;
    }
  });
}

// ============================================================================
// 便捷函数：创建带默认配置的 SessionRouter
// ============================================================================

/** 创建默认隔离模式的 SessionRouter */
export function createIsolatedRouter(): SessionRouter {
  return new SessionRouter({ mode: "isolated" });
}

/** 创建共享模式的 SessionRouter（类似 Hermes Profile） */
export function createSharedRouter(mainSessionId = "main"): SessionRouter {
  return new SessionRouter({ mode: "main", mainSessionId });
}

/** 创建按 peer 隔离的 SessionRouter（类似 OpenClaw dmScope: per-peer） */
export function createPerPeerRouter(): SessionRouter {
  return new SessionRouter({ mode: "per-peer" });
}
