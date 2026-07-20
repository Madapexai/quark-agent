/**
 * Signal Channel —— 通过 signal-cli-rest-api（本地部署）接入
 *
 * 接入方式：
 * - 轮询模式：定期 GET /v1/receive/{number} 拉新消息
 * - 回复：POST /v2/send 发文本
 * - signal-cli-rest-api 项目：https://github.com/bbernhard/signal-cli-rest-api
 *
 * 不依赖 SDK，仅用 fetch + Node 内置模块。
 */

import type { Channel, ChannelEvent, ChannelReply, Scope } from "../core/types.js";

export interface SignalChannelOptions {
  /** signal-cli-rest-api 地址，默认 http://127.0.0.1:8080 */
  apiUrl?: string;
  /** 已注册的 Signal 号码（带国家区号，如 +8613800000000） */
  phoneNumber: string;
  /** 轮询间隔 ms，默认 3000 */
  pollingIntervalMs?: number;
  /** 默认 scope */
  defaultScope?: Scope;
  /** 根据 Signal 号码解析 scope */
  resolveScope?: (phone: string) => Scope | undefined;
}

interface SignalMessage {
  envelope?: {
    source?: string;
    sourceNumber?: string;
    sourceName?: string;
    dataMessage?: {
      message?: string;
      timestamp?: number;
    };
    syncMessage?: unknown;
  };
}

export class SignalChannel implements Channel {
  readonly name = "signal";
  private timer?: ReturnType<typeof setInterval>;
  private pending = new Map<string, (reply: ChannelReply) => void>();
  private opts: Required<
    Omit<SignalChannelOptions, "defaultScope" | "resolveScope">
  > & {
    defaultScope?: Scope;
    resolveScope?: (phone: string) => Scope | undefined;
  };

  constructor(opts: SignalChannelOptions) {
    this.opts = {
      apiUrl: (opts.apiUrl ?? "http://127.0.0.1:8080").replace(/\/+$/, ""),
      phoneNumber: opts.phoneNumber,
      pollingIntervalMs: opts.pollingIntervalMs ?? 3000,
      defaultScope: opts.defaultScope,
      resolveScope: opts.resolveScope,
    };
  }

  async start(emit: (event: ChannelEvent) => void): Promise<void> {
    if (!this.opts.phoneNumber) {
      throw new Error("Signal phoneNumber 必填（带国家区号）");
    }

    // 立即拉一次，再定时
    void this.poll(emit);
    this.timer = setInterval(() => void this.poll(emit), this.opts.pollingIntervalMs);
    console.log(`[signal] 轮询 ${this.opts.apiUrl}/v1/receive/${this.opts.phoneNumber}`);
  }

  async reply(sessionId: string, reply: ChannelReply): Promise<void> {
    const resolve = this.pending.get(sessionId);
    if (resolve) resolve(reply);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
  }

  /** 轮询拉新消息并派发 */
  private async poll(emit: (event: ChannelEvent) => void): Promise<void> {
    try {
      const url = `${this.opts.apiUrl}/v1/receive/${this.opts.phoneNumber}`;
      const res = await fetch(url, { method: "GET" });
      if (!res.ok) return;
      const messages = (await res.json()) as SignalMessage[];
      if (!Array.isArray(messages)) return;

      for (const m of messages) {
        const env = m.envelope;
        if (!env) continue;
        // 仅处理数据消息，忽略同步消息
        const text = env.dataMessage?.message;
        const source = env.sourceNumber ?? env.source;
        if (!text || !source) continue;
        if (!text.trim()) continue;

        const sessionId = `signal-${source}`;
        const scope =
          this.opts.resolveScope?.(source) ?? this.opts.defaultScope;
        const event: ChannelEvent = {
          userId: source,
          sessionId,
          text,
          from: env.sourceName ?? source,
          receivedAt: env.dataMessage?.timestamp ?? Date.now(),
          scope,
          meta: { channel: this.name, source },
        };

        // 等 agent 回复后调 send API
        const reply = await new Promise<ChannelReply>((resolve) => {
          this.pending.set(sessionId, resolve);
          emit(event);
        });
        await this.sendReply(source, reply.text).catch(() => undefined);
        this.pending.delete(sessionId);
      }
    } catch {
      // 网络错误，下轮重试
    }
  }

  /** 调 signal-cli-rest-api 发送文本消息 */
  private async sendReply(to: string, text: string): Promise<void> {
    const url = `${this.opts.apiUrl}/v2/send`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        number: this.opts.phoneNumber,
        recipients: [to],
        message: text,
      }),
    });
  }
}
