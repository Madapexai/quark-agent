/**
 * Matrix Channel —— 通过 Matrix Client-Server API 接入
 *
 * 接入方式：
 * - /sync 长轮询接收消息（since 增量）
 * - reply：PUT /_matrix/client/v3/rooms/{roomId}/send/m.room.message/{txnId}
 * - 鉴权：Authorization: Bearer {accessToken}
 *
 * 不引 matrix-js-sdk，仅用 fetch + Node 内置模块。
 * 文档：https://spec.matrix.org/v1.10/client-server-api/
 */

import type { Channel, ChannelEvent, ChannelReply, Scope } from "../core/types.js";

export interface MatrixChannelOptions {
  /** homeserver，如 https://matrix.org */
  homeserver: string;
  /** Matrix access token */
  accessToken: string;
  /** 本机 userId（如 @bot:matrix.org） */
  userId: string;
  /** 仅响应这些 room（为空则响应所有 joined room） */
  roomIds?: string[];
  /** /sync 长轮询超时 ms，默认 30000 */
  syncTimeoutMs?: number;
  /** 重连间隔 ms，默认 5000 */
  retryIntervalMs?: number;
  /** 默认 scope */
  defaultScope?: Scope;
  /** 根据 Matrix userId 解析 scope */
  resolveScope?: (matrixUserId: string) => Scope | undefined;
}

interface MatrixSyncResponse {
  next_batch?: string;
  rooms?: {
    join?: Record<
      string,
      {
        timeline?: {
          events?: Array<{
            type?: string;
            sender?: string;
            content?: { msgtype?: string; body?: string };
            origin_server_ts?: number;
          }>;
        };
      }
    >;
  };
}

export class MatrixChannel implements Channel {
  readonly name = "matrix";
  private since?: string;
  private running = false;
  private pending = new Map<string, (reply: ChannelReply) => void>();
  private txnCounter = 0;
  private opts: Required<
    Omit<MatrixChannelOptions, "roomIds" | "defaultScope" | "resolveScope">
  > & {
    roomIds: string[];
    defaultScope?: Scope;
    resolveScope?: (matrixUserId: string) => Scope | undefined;
  };

  constructor(opts: MatrixChannelOptions) {
    this.opts = {
      homeserver: opts.homeserver.replace(/\/+$/, ""),
      accessToken: opts.accessToken,
      userId: opts.userId,
      roomIds: opts.roomIds ?? [],
      syncTimeoutMs: opts.syncTimeoutMs ?? 30_000,
      retryIntervalMs: opts.retryIntervalMs ?? 5000,
      defaultScope: opts.defaultScope,
      resolveScope: opts.resolveScope,
    };
  }

  async start(emit: (event: ChannelEvent) => void): Promise<void> {
    if (!this.opts.accessToken || !this.opts.userId) {
      throw new Error("Matrix accessToken 与 userId 必填");
    }
    this.running = true;
    // 后台启动 sync 循环
    void this.syncLoop(emit);
    console.log(`[matrix] 连接 ${this.opts.homeserver} as ${this.opts.userId}`);
  }

  async reply(sessionId: string, reply: ChannelReply): Promise<void> {
    const resolve = this.pending.get(sessionId);
    if (resolve) resolve(reply);
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  /** /sync 长轮询主循环 */
  private async syncLoop(emit: (event: ChannelEvent) => void): Promise<void> {
    while (this.running) {
      try {
        const url = new URL(`${this.opts.homeserver}/_matrix/client/v3/sync`);
        url.searchParams.set("timeout", String(this.opts.syncTimeoutMs));
        if (this.since) url.searchParams.set("since", this.since);
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${this.opts.accessToken}` },
        });
        if (!res.ok) {
          await sleep(this.opts.retryIntervalMs);
          continue;
        }
        const data = (await res.json()) as MatrixSyncResponse;
        this.since = data.next_batch;
        await this.handleSync(data, emit);
      } catch {
        // 网络错误，等待后重试
        await sleep(this.opts.retryIntervalMs);
      }
    }
  }

  /** 处理 /sync 响应里的新事件 */
  private async handleSync(data: MatrixSyncResponse, emit: (event: ChannelEvent) => void): Promise<void> {
    const joined = data.rooms?.join;
    if (!joined) return;
    for (const [roomId, roomData] of Object.entries(joined)) {
      // 过滤 roomIds
      if (this.opts.roomIds.length > 0 && !this.opts.roomIds.includes(roomId)) continue;
      const events = roomData.timeline?.events ?? [];
      for (const ev of events) {
        // 仅处理文本消息
        if (ev.type !== "m.room.message") continue;
        if (ev.content?.msgtype !== "m.text") continue;
        // 忽略自己发的
        if (ev.sender === this.opts.userId) continue;
        const body = ev.content?.body ?? "";
        if (!body.trim()) continue;

        const sender = ev.sender ?? "matrix-anon";
        const sessionId = `matrix-${roomId}`;
        const scope = this.opts.resolveScope?.(sender) ?? this.opts.defaultScope;
        const event: ChannelEvent = {
          userId: sender,
          sessionId,
          text: body,
          from: sender,
          receivedAt: ev.origin_server_ts ?? Date.now(),
          scope,
          meta: { channel: this.name, roomId, sender },
        };

        // 等 agent 回复后发消息
        const reply = await new Promise<ChannelReply>((resolve) => {
          this.pending.set(sessionId, resolve);
          emit(event);
        });
        await this.sendRoomMessage(roomId, reply.text).catch(() => undefined);
        this.pending.delete(sessionId);
      }
    }
  }

  /** 调 Matrix API 向 room 发送文本消息 */
  private async sendRoomMessage(roomId: string, text: string): Promise<void> {
    const txnId = `m${Date.now()}-${++this.txnCounter}`;
    const url = `${this.opts.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(
      roomId,
    )}/send/m.room.message/${encodeURIComponent(txnId)}`;
    await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.opts.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        msgtype: "m.text",
        body: text,
      }),
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
