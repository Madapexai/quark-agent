/**
 * Local Channel —— 本地沙箱通道，每 session 独立隔离沙箱
 *
 * 设计（学 OpenClaw 本地 + 相互隔离）：
 * - stdin 行作为入站事件
 * - 每个 session 创建独立 Sandbox 实例（互不共享全局）
 * - 支持 lightweight / full 两种 tier
 * - 适合"在本地终端跑 agent，工具调用进各自沙箱"场景
 */

import readline from "node:readline";
import type { Channel, ChannelEvent, ChannelReply, Scope, Sandbox } from "../core/types.js";
import { VmSandbox } from "../sandbox/vm.js";

export interface LocalChannelOptions {
  /** 本地用户 ID */
  userId?: string;
  /** 默认 session 前缀 */
  sessionPrefix?: string;
  /** 默认 scope */
  scope?: Scope;
  /** 沙箱工厂：可注入自定义沙箱实现（默认 VmSandbox） */
  sandboxFactory?: (sessionId: string) => Sandbox;
  prompt?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export class LocalChannel implements Channel {
  readonly name = "local";
  private rl?: readline.Interface;
  private emit?: (event: ChannelEvent) => void;
  private pending = new Map<string, (reply: ChannelReply) => void>();
  private sandboxes = new Map<string, Sandbox>();
  private opts: Required<
    Omit<LocalChannelOptions, "scope" | "sandboxFactory">
  > & {
    scope?: Scope;
    sandboxFactory?: (sessionId: string) => Sandbox;
  };
  private sessionCounter = 0;

  constructor(opts: LocalChannelOptions = {}) {
    this.opts = {
      userId: opts.userId ?? "local-user",
      sessionPrefix: opts.sessionPrefix ?? "local",
      scope: opts.scope,
      sandboxFactory: opts.sandboxFactory,
      prompt: opts.prompt ?? "local> ",
      input: opts.input ?? process.stdin,
      output: opts.output ?? process.stdout,
    };
  }

  async start(emit: (event: ChannelEvent) => void): Promise<void> {
    this.emit = emit;
    this.rl = readline.createInterface({
      input: this.opts.input,
      output: this.opts.output,
      prompt: this.opts.prompt,
    });
    this.opts.output.write(`[local channel] 输入消息开始对话，/new 开新 session，/exit 退出\n`);
    this.rl.prompt();
    this.rl.on("line", (line: string) => {
      const text = line.trim();
      if (!text) {
        this.rl?.prompt();
        return;
      }
      if (text === "/exit") {
        this.rl?.close();
        return;
      }
      if (text === "/new") {
        this.sessionCounter++;
        this.opts.output.write(`[new session] ${this.currentSessionId()}\n`);
        this.rl?.prompt();
        return;
      }
      const sessionId = this.currentSessionId();
      const event: ChannelEvent = {
        userId: this.opts.userId,
        sessionId,
        text,
        from: this.opts.userId,
        receivedAt: Date.now(),
        scope: this.opts.scope,
      };
      emit(event);
    });
  }

  async reply(sessionId: string, reply: ChannelReply): Promise<void> {
    const resolve = this.pending.get(sessionId);
    if (resolve) {
      resolve(reply);
    } else {
      this.opts.output.write(`<<< ${reply.text}\n`);
      this.rl?.prompt();
    }
  }

  /** 为某 session 获取/创建隔离沙箱 */
  getSandbox(sessionId: string): Sandbox {
    let sb = this.sandboxes.get(sessionId);
    if (!sb) {
      sb = this.opts.sandboxFactory
        ? this.opts.sandboxFactory(sessionId)
        : new VmSandbox();
      this.sandboxes.set(sessionId, sb);
    }
    return sb;
  }

  /** 等待某 session 的回复（供 runtime 协调） */
  waitForReply(sessionId: string): Promise<ChannelReply> {
    return new Promise((resolve) => {
      this.pending.set(sessionId, resolve);
    });
  }

  /** 通知有新事件并等待回复 */
  async dispatch(event: ChannelEvent): Promise<ChannelReply> {
    return new Promise((resolve) => {
      this.pending.set(event.sessionId, resolve);
      this.emit?.(event);
    });
  }

  async stop(): Promise<void> {
    this.rl?.close();
    for (const sb of this.sandboxes.values()) {
      await sb.dispose().catch(() => undefined);
    }
    this.sandboxes.clear();
  }

  private currentSessionId(): string {
    if (this.sessionCounter === 0) this.sessionCounter = 1;
    return `${this.opts.sessionPrefix}-${this.sessionCounter}`;
  }
}

/**
 * 沙箱工厂：按 tier 创建隔离沙箱。
 * lightweight：更短超时、更小内存上限、移除 IO 全局。
 * full：标准配置。
 */
export function tieredSandboxFactory(tier: "lightweight" | "full"): (sessionId: string) => Sandbox {
  return (_sessionId: string) => {
    if (tier === "lightweight") {
      return new VmSandbox({
        defaultTimeoutMs: 2000,
        defaultMemoryLimitBytes: 4 * 1024 * 1024,
      });
    }
    return new VmSandbox({
      defaultTimeoutMs: 10_000,
      defaultMemoryLimitBytes: 32 * 1024 * 1024,
    });
  };
}
