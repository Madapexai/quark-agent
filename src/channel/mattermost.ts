/**
 * Mattermost Channel —— 通过 Mattermost REST API + WebSocket 接入
 *
 * 接入方式：
 * - WebSocket 连 gateway 接收 message 事件
 * - reply：POST /api/v4/posts（带 channel_id + message）
 * - 鉴权：Authorization: Bearer {token}（HTTP）+ WebSocket challenge 鉴权
 *
 * 不引 mattermost-js SDK，仅用 fetch + WebSocket。
 * 文档：https://api.mattermost.com/
 */

import type { Channel, ChannelEvent, ChannelReply, Scope } from "../core/types.js";

// Node 22+ 自带 WebSocket；旧版本需安装 ws 包
let WSClass: any = null;
try {
  // @ts-ignore Node 22+ built-in WebSocket
  WSClass = WebSocket;
} catch {}
if (!WSClass) {
  try {
    WSClass = require("ws");
  } catch {}
}

export interface MattermostChannelOptions {
  /** Mattermost 实例地址，如 https://mattermost.example.com */
  url: string;
  /** Bot/Personal Access Token */
  token: string;
  /** 团队名（如 default），可选 */
  teamName?: string;
  /** 仅响应这些 channel，可选 */
  channelIds?: string[];
  /** 默认 scope */
  defaultScope?: Scope;
  /** 根据 Mattermost userId 解析 scope */
  resolveScope?: (mattermostUserId: string) => Scope | undefined;
}

interface MattermostPost {
  id?: string;
  channel_id?: string;
  user_id?: string;
  message?: string;
  create_at?: number;
  root_id?: string;
}

export class MattermostChannel implements Channel {
  readonly name = "mattermost";
  private ws?: any;
  private pending = new Map<string, (reply: ChannelReply) => void>();
  private opts: Required<
    Omit<MattermostChannelOptions, "channelIds" | "defaultScope" | "resolveScope">
  > & {
    channelIds: string[];
    defaultScope?: Scope;
    resolveScope?: (mattermostUserId: string) => Scope | undefined;
  };
  private botUserId?: string;

  constructor(opts: MattermostChannelOptions) {
    this.opts = {
      url: opts.url.replace(/\/+$/, ""),
      token: opts.token,
      teamName: opts.teamName ?? "default",
      channelIds: opts.channelIds ?? [],
      defaultScope: opts.defaultScope,
      resolveScope: opts.resolveScope,
    };
  }

  async start(emit: (event: ChannelEvent) => void): Promise<void> {
    if (!this.opts.url || !this.opts.token) {
      throw new Error("Mattermost url 与 token 必填");
    }
    if (!WSClass) {
      throw new Error("No WebSocket available. Node 22+ 或安装 ws 包");
    }

    // 先获取本机 user id（用于忽略自己发的消息）
    await this.fetchMe().catch(() => undefined);

    // 拉 WebSocket gateway URL
    const wsUrl = await this.fetchWebSocketUrl();
    this.connect(wsUrl, emit);
    console.log(`[mattermost] 连接 ${wsUrl}`);
  }

  async reply(sessionId: string, reply: ChannelReply): Promise<void> {
    const resolve = this.pending.get(sessionId);
    if (resolve) resolve(reply);
  }

  async stop(): Promise<void> {
    this.ws?.close?.();
  }

  /** GET /api/v4/users/me —— 拿本机 userId */
  private async fetchMe(): Promise<void> {
    const res = await fetch(`${this.opts.url}/api/v4/users/me`, {
      headers: { Authorization: `Bearer ${this.opts.token}` },
    });
    if (res.ok) {
      const data = (await res.json()) as { id?: string };
      this.botUserId = data.id;
    }
  }

  /** GET /api/v4/websocket —— 拿 WebSocket gateway URL */
  private async fetchWebSocketUrl(): Promise<string> {
    // Mattermost 4.x+ 通常直接 wss://host/api/v4/websocket
    const httpUrl = new URL(this.opts.url);
    const wsScheme = httpUrl.protocol === "https:" ? "wss:" : "ws:";
    return `${wsScheme}//${httpUrl.host}/api/v4/websocket`;
  }

  /** 连接 WebSocket + 鉴权 + 监听 posted 事件 */
  private connect(wsUrl: string, emit: (event: ChannelEvent) => void): void {
    this.ws = new WSClass(wsUrl);

    this.ws.on("open", () => {
      // 发送鉴权 challenge
      this.ws.send(
        JSON.stringify({
          seq: 1,
          action: "authentication_challenge",
          data: { token: this.opts.token },
        }),
      );
    });

    this.ws.on("message", (data: Buffer) => {
      try {
        const payload = JSON.parse(data.toString());
        this.handleEvent(payload, emit);
      } catch {}
    });

    this.ws.on("close", () => {
      // 连接关闭，下次 start 会重连
    });

    this.ws.on("error", (err: Error) => {
      console.error("[mattermost] WebSocket error:", err.message);
    });
  }

  /** 处理 WebSocket 事件 */
  private handleEvent(payload: any, emit: (event: ChannelEvent) => void): void {
    // 鉴权 ACK
    if (payload.event === "hello") return;
    if (payload.status === "OK" && payload.seq_reply === 1) return;

    // posted 事件 = 新消息
    if (payload.event !== "posted") return;
    const data = payload.data;
    if (!data) return;

    let post: MattermostPost;
    try {
      post = JSON.parse(data.post ?? "{}");
    } catch {
      return;
    }

    // 忽略自己发的
    if (this.botUserId && post.user_id === this.botUserId) return;
    // 过滤 channelIds
    if (this.opts.channelIds.length > 0 && post.channel_id && !this.opts.channelIds.includes(post.channel_id)) {
      return;
    }

    const text = post.message ?? "";
    if (!text.trim()) return;

    const sender = post.user_id ?? "mattermost-anon";
    const sessionId = `mattermost-${post.channel_id}`;
    const scope = this.opts.resolveScope?.(sender) ?? this.opts.defaultScope;
    const event: ChannelEvent = {
      userId: sender,
      sessionId,
      text,
      from: sender,
      receivedAt: post.create_at ?? Date.now(),
      scope,
      meta: {
        channel: this.name,
        channelId: post.channel_id,
        postId: post.id,
        rootId: post.root_id,
      },
    };

    // 等 agent 回复后调 API 发消息（不阻塞 WebSocket）
    void this.awaitReplyAndSend(event, emit);
  }

  /** 等 agent 回复，再调 /api/v4/posts 发消息 */
  private async awaitReplyAndSend(
    event: ChannelEvent,
    emit: (event: ChannelEvent) => void,
  ): Promise<void> {
    const reply = await new Promise<ChannelReply>((resolve) => {
      this.pending.set(event.sessionId, resolve);
      emit(event);
    });
    const channelId = event.meta?.channelId as string | undefined;
    if (!channelId) return;
    const rootId = event.meta?.rootId as string | undefined;
    await this.sendPost(channelId, reply.text, rootId).catch(() => undefined);
    this.pending.delete(event.sessionId);
  }

  /** POST /api/v4/posts 发消息 */
  private async sendPost(channelId: string, text: string, rootId?: string): Promise<void> {
    const body: Record<string, unknown> = {
      channel_id: channelId,
      message: text,
    };
    if (rootId) body.root_id = rootId;
    await fetch(`${this.opts.url}/api/v4/posts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }
}
