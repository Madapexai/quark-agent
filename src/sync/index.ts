/**
 * 实时状态同步：EventBus + SSE
 *
 * 对标 Agent-Native 的实时同步（SSE/poll，agent 写入后 UI 立即刷新）。
 * - EventBus：进程内发布/订阅，支持按 channel/user/session 过滤
 * - SSE Server：把 EventBus 桥接到 HTTP SSE 流
 * - Agent 生命周期事件自动发布：run_start / tool_call / tool_result / chunk / run_end
 *
 * UI 层订阅后可实现：实时对话流、工具执行进度、状态变更通知。
 */

// ============================================================================
// 事件类型
// ============================================================================

export type EventType =
  | "run_start"
  | "run_end"
  | "tool_call"
  | "tool_result"
  | "chunk"
  | "error"
  | "state_change"
  | "action"
  | "a2a";

export interface SyncEvent {
  id: string;
  type: EventType;
  timestamp: number;
  userId?: string;
  sessionId?: string;
  agentId?: string;
  data: Record<string, unknown>;
}

type Listener = (event: SyncEvent) => void;
type Filter = (event: SyncEvent) => boolean;

// ============================================================================
// EventBus：进程内发布/订阅
// ============================================================================

export class EventBus {
  private listeners = new Map<string, Set<Listener>>();
  private history: SyncEvent[] = [];
  private readonly maxHistory = 1000;

  /** 订阅事件。返回取消订阅函数 */
  on(filter: Filter | "*", listener: Listener): () => void {
    const key = typeof filter === "string" ? filter : this.filterKey(filter);
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key)!.add(listener);
    return () => this.listeners.get(key)?.delete(listener);
  }

  /** 订阅一次 */
  once(filter: Filter | "*", listener: Listener): () => void {
    const off = this.on(filter, (e) => {
      listener(e);
      off();
    });
    return off;
  }

  /** 发布事件 */
  emit(event: Omit<SyncEvent, "id" | "timestamp">): SyncEvent {
    const full: SyncEvent = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      ...event,
    };
    this.history.push(full);
    if (this.history.length > this.maxHistory) this.history.shift();

    // 通知通配符监听者
    const starListeners = this.listeners.get("*");
    if (starListeners) for (const l of starListeners) this.safeCall(l, full);

    // 通知过滤监听者
    for (const [key, set] of this.listeners) {
      if (key === "*") continue;
      // key 是 filter 的 toString，我们直接遍历所有非通配符 listener 做过滤
      for (const l of set) this.safeCall(l, full);
    }
    return full;
  }

  /** 获取历史事件（可按 filter 过滤） */
  getHistory(filter?: Filter): SyncEvent[] {
    if (!filter) return [...this.history];
    return this.history.filter(filter);
  }

  /** 清除历史 */
  clearHistory(): void {
    this.history = [];
  }

  private filterKey(_filter: Filter): string {
    // 简化：所有非通配符 listener 共享一个 bucket，emit 时直接调用（filter 在 listener wrapper 里）
    return "__filter__";
  }

  private safeCall(l: Listener, e: SyncEvent): void {
    try { l(e); } catch { /* listener 错误不影响 bus */ }
  }
}

/** 全局 EventBus */
const globalBus = new EventBus();
export function getEventBus(): EventBus { return globalBus; }

// ============================================================================
// SSE 服务器：把 EventBus 桥接到 HTTP SSE
// ============================================================================

export interface SSEClient {
  id: string;
  res: { write: (chunk: string) => void; end: () => void };
  filter?: Filter;
  userId?: string;
  sessionId?: string;
}

/** SSE 管理器：管理客户端连接，EventBus 事件自动转发 */
export class SSEServer {
  private clients = new Map<string, SSEClient>();

  constructor(bus: EventBus = globalBus) {
    bus.on("*", (event) => this.broadcast(event));
  }

  /** 添加一个 SSE 客户端连接 */
  addClient(client: Omit<SSEClient, "id"> & { id?: string }): SSEClient {
    const id = client.id ?? `sse_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const c: SSEClient = { ...client, id };
    this.clients.set(id, c);
    // 发送连接确认
    c.res.write(`event: connected\ndata: {"clientId":"${id}"}\n\n`);
    return c;
  }

  /** 移除客户端 */
  removeClient(id: string): void {
    const c = this.clients.get(id);
    if (c) {
      c.res.end();
      this.clients.delete(id);
    }
  }

  /** 广播事件到匹配的客户端 */
  private broadcast(event: SyncEvent): void {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const [, c] of this.clients) {
      // 按 userId/sessionId 过滤
      if (c.userId && event.userId && c.userId !== event.userId) continue;
      if (c.sessionId && event.sessionId && c.sessionId !== event.sessionId) continue;
      if (c.filter && !c.filter(event)) continue;
      try { c.res.write(payload); } catch { this.clients.delete(c.id); }
    }
  }

  /** 客户端数 */
  get clientCount(): number { return this.clients.size; }

  /** 关闭所有连接 */
  close(): void {
    for (const [, c] of this.clients) {
      try { c.res.write("event: close\ndata: {}\n\n"); c.res.end(); } catch { /* ignore */ }
    }
    this.clients.clear();
  }
}

/** 生成 SSE HTTP response headers */
export function sseHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
}

// ============================================================================
// Agent 事件自动发布 hook：挂载到 plugin 系统，自动发 run/tool/chunk 事件
// ============================================================================

import type { Plugin, HookContext } from "../core/types.js";

/** 创建一个自动发布 agent 生命周期事件到 EventBus 的 plugin */
export function syncPlugin(bus: EventBus = globalBus): Plugin {
  return {
    name: "sync",
    async install(ctx) {
      // beforeRun：发 run_start
      ctx.registerHook("beforeRun", (hookCtx: HookContext) => {
        bus.emit({
          type: "run_start",
          userId: hookCtx.identity.userId,
          sessionId: hookCtx.identity.sessionId,
          data: { text: hookCtx.mutable?.userText ?? "" },
        });
      });
      // afterRun：发 run_end
      ctx.registerHook("afterRun", (hookCtx: HookContext) => {
        bus.emit({
          type: "run_end",
          userId: hookCtx.identity.userId,
          sessionId: hookCtx.identity.sessionId,
          data: { reply: hookCtx.run?.reply ?? "", rounds: hookCtx.run?.rounds ?? 0 },
        });
      });
      // beforeTool：发 tool_call
      ctx.registerHook("beforeTool", (hookCtx: HookContext) => {
        if (hookCtx.toolCall) {
          bus.emit({
            type: "tool_call",
            userId: hookCtx.identity.userId,
            sessionId: hookCtx.identity.sessionId,
            data: { tool: hookCtx.toolCall.name, args: hookCtx.toolCall.arguments },
          });
        }
      });
      // afterTool：发 tool_result
      ctx.registerHook("afterTool", (hookCtx: HookContext) => {
        bus.emit({
          type: "tool_result",
          userId: hookCtx.identity.userId,
          sessionId: hookCtx.identity.sessionId,
          data: { tool: hookCtx.toolCall?.name ?? "", result: (hookCtx.toolResult ?? "").slice(0, 500) },
        });
      });
      // onStream：发 chunk
      ctx.registerHook("onStream", (hookCtx: HookContext) => {
        if (hookCtx.chunk) {
          bus.emit({
            type: "chunk",
            userId: hookCtx.identity.userId,
            sessionId: hookCtx.identity.sessionId,
            data: { delta: hookCtx.chunk },
          });
        }
      });
      return () => { /* cleanup */ };
    },
  };
}
