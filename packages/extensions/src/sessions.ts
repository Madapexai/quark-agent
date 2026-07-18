/**
 * @micro-agent/extensions —— Sessions 扩展插件
 *
 * 提供：
 * - 会话消息持久化（基于 Memory）
 * - Checkpoint 每轮保存，出错时自动恢复
 * - 死循环检测（同一工具连续重复调用）
 */

import type { Plugin, PluginContext, Identity, Message, ToolCall } from "@micro-agent/core";

export interface SessionStore {
  append(identity: Identity, msg: Message): Promise<void>;
  getMessages(identity: Identity): Promise<Message[]>;
  checkpoint(identity: Identity, messages: Message[]): Promise<void>;
  recover(identity: Identity): Promise<Message[] | null>;
  checkLoop(sessionId: string, call: ToolCall): boolean;
  cleanup(): void;
}

const MAX_CHECKPOINTS = 1000;
const MAX_RECENT_CALLS = 1000;
const LOOP_WINDOW_SIZE = 20;
const LOOP_THRESHOLD = 3;

function canonicalizeArgs(args: string): string {
  try {
    const parsed = JSON.parse(args);
    if (typeof parsed !== "object" || parsed === null) return args;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(parsed).sort()) {
      sorted[key] = parsed[key];
    }
    return JSON.stringify(sorted);
  } catch {
    return args;
  }
}

class MemorySessionStore implements SessionStore {
  private checkpoints = new Map<string, Message[]>();
  private recentCalls = new Map<string, { name: string; canonicalArgs: string; timestamps: number[] }>();
  private checkpointOrder: string[] = [];
  private pendingUserText = new Map<string, string>();

  constructor(private memory: PluginContext["memory"]) {}

  setPendingUser(sessionId: string, text: string): void {
    this.pendingUserText.set(sessionId, text);
  }

  consumePendingUser(sessionId: string): string | undefined {
    const text = this.pendingUserText.get(sessionId);
    this.pendingUserText.delete(sessionId);
    return text;
  }

  async append(identity: Identity, msg: Message): Promise<void> {
    await this.memory.add({
      content: JSON.stringify(msg),
      kind: "chat",
      layer: "L0",
      userId: identity.userId,
      sessionId: identity.sessionId,
    });
  }

  async getMessages(identity: Identity): Promise<Message[]> {
    const entries = await this.memory.list({ userId: identity.userId, sessionId: identity.sessionId, kind: "chat", layer: "L0" });
    const messages: Message[] = [];
    for (const e of entries) {
      try {
        messages.push(JSON.parse(e.content) as Message);
      } catch (err) {
        console.error("[sessions] Failed to parse stored message:", err);
      }
    }
    return messages;
  }

  async checkpoint(identity: Identity, messages: Message[]): Promise<void> {
    const key = identity.sessionId;
    if (!this.checkpoints.has(key)) {
      this.checkpointOrder.push(key);
    }
    this.checkpoints.set(key, [...messages]);
    while (this.checkpointOrder.length > MAX_CHECKPOINTS) {
      const oldest = this.checkpointOrder.shift();
      if (oldest) this.checkpoints.delete(oldest);
    }
  }

  async recover(identity: Identity): Promise<Message[] | null> {
    return this.checkpoints.get(identity.sessionId) ?? null;
  }

  checkLoop(sessionId: string, call: ToolCall): boolean {
    const canonicalArgs = canonicalizeArgs(call.arguments);
    const key = `${sessionId}:${call.name}:${canonicalArgs}`;
    const now = Date.now();

    const entry = this.recentCalls.get(key);
    if (entry) {
      entry.timestamps.push(now);
      while (entry.timestamps.length > LOOP_WINDOW_SIZE) {
        entry.timestamps.shift();
      }
      if (entry.timestamps.length >= LOOP_THRESHOLD) {
        return true;
      }
    } else {
      this.recentCalls.set(key, { name: call.name, canonicalArgs, timestamps: [now] });
    }

    if (this.recentCalls.size > MAX_RECENT_CALLS) {
      const firstKey = this.recentCalls.keys().next().value;
      if (firstKey) this.recentCalls.delete(firstKey);
    }

    return false;
  }

  cleanup(): void {
    this.checkpoints.clear();
    this.recentCalls.clear();
    this.checkpointOrder = [];
    this.pendingUserText.clear();
  }
}

export function sessionsExtension(): Plugin {
  return {
    name: "sessions",
    version: "0.1.0",
    dependencies: [],
    install(ctx: PluginContext) {
      const store = new MemorySessionStore(ctx.memory);
      ctx.registerService?.("sessions.store", store);

      ctx.registerHook("beforeRun", (hctx) => {
        const userText = hctx.mutable?.userText;
        if (userText) {
          store.setPendingUser(hctx.identity.sessionId, userText);
        }
        hctx.meta = hctx.meta ?? {};
        hctx.meta._recoveredFromCheckpoint = false;
      });

      ctx.registerHook("onMessage", async (hctx) => {
        if (hctx.mutable?.messages) {
          await store.checkpoint(hctx.identity, hctx.mutable.messages);
        }
      });

      ctx.registerHook("beforeTool", (hctx) => {
        if (hctx.toolCall) {
          const isLooping = store.checkLoop(hctx.identity.sessionId, hctx.toolCall);
          if (isLooping) {
            hctx.mutable = hctx.mutable ?? {};
            hctx.mutable.toolResult = "[loop] 工具连续重复调用，已中止";
          }
        }
      });

      ctx.registerHook("afterRun", async (hctx) => {
        const identity = hctx.identity;
        const userText = store.consumePendingUser(identity.sessionId);
        if (userText) {
          await store.append(identity, { role: "user", content: userText });
        }
        if (hctx.run?.reply) {
          await store.append(identity, { role: "assistant", content: hctx.run.reply });
        }
      });

      const offRecover = ctx.bus.on("sessions:recover", (payload: { identity: Identity }) => {
        store.recover(payload.identity).then((recovered) => {
          if (recovered) {
            ctx.bus.emit("sessions:recovered", { identity: payload.identity, messages: recovered });
          }
        }).catch((err) => {
          ctx.bus.emit("plugin:hookError", { point: "sessions:recover" as any, error: err });
        });
      });

      return () => {
        offRecover();
        store.cleanup();
      };
    },
  };
}

export function getSessionStore(ctx: PluginContext): SessionStore | undefined {
  return ctx.getService?.<SessionStore>("sessions.store");
}
