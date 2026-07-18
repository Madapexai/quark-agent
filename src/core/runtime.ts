/**
 * micro-agent 轻量运行时
 *
 * 目标（调研 §二/§四）：
 * - 极低常驻内存：单事件循环 + 定时器，无后台线程
 * - 空闲自动休眠（学 Hermes），唤醒即用
 * - trait 驱动：通道、工具、记忆都是可插拔 trait
 */

import type { Channel, ChannelEvent, AgentDeps, AgentConfig } from "./types.js";

export interface RuntimeOptions {
  /** 空闲多久后进入休眠（ms），默认 60_000 */
  idleSleepMs?: number;
  /** 心跳间隔（ms），用于 tracing 上报，默认 30_000 */
  heartbeatMs?: number;
}

type ReplyFn = (event: ChannelEvent) => Promise<string>;

/**
 * Runtime 持有一组 Channel，把入站事件分发给注册的 handler。
 * 它本身不持有模型状态——状态全在 Agent / Memory 里。
 */
export class Runtime {
  private channels: Channel[] = [];
  private handlers: ReplyFn[] = [];
  private running = false;
  private lastActivity = Date.now();
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private readonly opts: Required<RuntimeOptions>;

  constructor(opts: RuntimeOptions = {}) {
    this.opts = {
      idleSleepMs: opts.idleSleepMs ?? 60_000,
      heartbeatMs: opts.heartbeatMs ?? 30_000,
    } as Required<RuntimeOptions>;
  }

  /** 注册一个通道及其处理函数 */
  register(channel: Channel, handler: ReplyFn): void {
    this.channels.push(channel);
    this.handlers.push(handler);
  }

  /** 启动所有通道，开始派发事件 */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.lastActivity = Date.now();

    // 心跳：仅用于 tracing，不做重活
    this.heartbeatTimer = setInterval(() => {
      // 空闲检测：超过 idleSleepMs 没活动，可由 Memory 层触发 GC
      // 这里只记录，真正休眠交给 Memory 的 compaction
      const idle = Date.now() - this.lastActivity;
      if (idle > this.opts.idleSleepMs) {
        // 标记空闲，下次有事件再唤醒
      }
    }, this.opts.heartbeatMs);

    await Promise.all(
      this.channels.map(async (ch, i) => {
        const handler = this.handlers[i];
        await ch.start(async (event: ChannelEvent) => {
          this.lastActivity = Date.now();
          try {
            const reply = await handler(event);
            await ch.reply(event.sessionId, { text: reply });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await ch.reply(event.sessionId, { text: `[error] ${msg}` });
          }
          this.lastActivity = Date.now();
        });
      }),
    );
  }

  /** 优雅停止 */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await Promise.all(this.channels.map((ch) => ch.stop().catch(() => undefined)));
  }

  get isRunning(): boolean {
    return this.running;
  }
}

/**
 * 把 Agent 绑定到 Runtime 的便捷工厂：
 * 每个 Channel 事件 → Agent.run(userText, {userId, sessionId, scope, channel}) → 返回回复文本
 * 自动透传多 session 所需的身份与授权信息。
 */
export function bindAgent(
  config: AgentConfig,
  deps: AgentDeps,
): { channel: (ch: Channel) => (event: ChannelEvent) => Promise<string> } {
  return {
    channel: () => async (event: ChannelEvent) => {
      const { Agent } = await import("./agent.js");
      const agent = new Agent(config, deps);
      const result = await agent.run(event.text, {
        userId: event.userId,
        sessionId: event.sessionId,
        scope: event.scope,
        channel: event.from,
        meta: event.meta,
      });
      return result.reply;
    },
  };
}
