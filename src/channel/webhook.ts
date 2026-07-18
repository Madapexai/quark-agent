/**
 * WebhookChannel 基类 —— 复用 HTTP server + 签名校验 + pending 协调
 *
 * 三大 IM（飞书/微信/Telegram）渠道的共性：
 * - 都是 HTTP webhook 接收事件
 * - 都需要签名/token 校验
 * - 都要"等 agent 回复后再调平台 API 发消息"
 *
 * 子类只需实现 4 个抽象方法，无需重复写 HTTP 样板。
 */

import crypto from "node:crypto";
import http from "node:http";
import type { Channel, ChannelEvent, ChannelReply, Scope } from "../core/types.js";

export interface WebhookChannelOptions {
  port?: number;
  host?: string;
  /** webhook 路径，如 /feishu/webhook，子类有默认值 */
  path?: string;
  /** 默认 scope */
  defaultScope?: Scope;
  /** 根据 platform 内用户 ID 解析 scope */
  resolveScope?: (platformUserId: string) => Scope | undefined;
}

export interface ParsedEvent {
  /** 平台内用户 ID → 映射为 micro-agent 的 userId */
  userId: string;
  /** 平台内会话 ID（群/聊天 ID）→ 映射为 sessionId */
  sessionId: string;
  /** 入站文本 */
  text: string;
  /** 发送者展示名 */
  from: string;
  /** 回复所需上下文（如 chat_id、msg_id），由子类在 reply 时使用 */
  replyTarget: Record<string, unknown>;
}

export abstract class WebhookChannel implements Channel {
  abstract readonly name: string;
  private server?: http.Server;
  private pending = new Map<string, (reply: ChannelReply) => void>();
  protected readonly opts: Required<Omit<WebhookChannelOptions, "defaultScope" | "resolveScope">> & {
    defaultScope?: Scope;
    resolveScope?: (platformUserId: string) => Scope | undefined;
  };

  constructor(opts: WebhookChannelOptions) {
    this.opts = {
      port: opts.port ?? 8787,
      host: opts.host ?? "0.0.0.0",
      path: opts.path ?? "/webhook",
      defaultScope: opts.defaultScope,
      resolveScope: opts.resolveScope,
    };
  }

  async start(emit: (event: ChannelEvent) => void): Promise<void> {
    this.server = http.createServer(async (req, res) => {
      if (req.method !== "POST" || !req.url?.startsWith(this.opts.path)) {
        res.writeHead(404).end('{"error":"not found"}');
        return;
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks);

      // 子类校验签名 + 解析（可能返回需要立即 ACK 的响应体）
      const verified = await this.verify(req.headers, raw);
      if (!verified.ok) {
        res.writeHead(401).end('{"error":"bad signature"}');
        return;
      }

      const parsed = await this.parse(raw, req.headers);
      if (!parsed) {
        // 子类可要求立即返回特定响应（如飞书 challenge / 微信 echostr）
        if (verified.ackBody) {
          res.writeHead(200, verified.ackHeaders ?? { "Content-Type": "application/json" }).end(verified.ackBody);
        } else {
          res.writeHead(200).end('{"ok":"ignored"}');
        }
        return;
      }

      const scope = this.opts.resolveScope?.(parsed.userId) ?? this.opts.defaultScope;
      const event: ChannelEvent = {
        userId: parsed.userId,
        sessionId: parsed.sessionId,
        text: parsed.text,
        from: parsed.from,
        receivedAt: Date.now(),
        scope,
        meta: { ...parsed.replyTarget, channel: this.name },
      };

      // 立即 ACK（IM 平台通常要求 5s 内响应，agent 回复走异步）
      res.writeHead(200, verified.ackHeaders ?? { "Content-Type": "application/json" }).end(verified.ackBody ?? '{"ok":true}');

      // 等 agent 回复（异步，不阻塞 HTTP 响应）
      const reply = await new Promise<ChannelReply>((resolve) => {
        this.pending.set(parsed.sessionId, resolve);
        emit(event);
      });
      await this.sendReply(parsed, reply.text).catch(() => undefined);
      this.pending.delete(parsed.sessionId);
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.opts.port, this.opts.host, () => resolve());
    });
  }

  async reply(sessionId: string, reply: ChannelReply): Promise<void> {
    const resolve = this.pending.get(sessionId);
    if (resolve) resolve(reply);
  }

  /** 注册一个等待回复的 promise（轮询模式子类用） */
  protected waitForReply(sessionId: string): Promise<ChannelReply> {
    return new Promise((resolve) => {
      this.pending.set(sessionId, resolve);
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** 子类实现：校验签名，返回是否通过 + 可选的立即 ACK 响应 */
  protected abstract verify(
    headers: http.IncomingHttpHeaders,
    raw: Buffer,
  ): Promise<{ ok: boolean; ackBody?: string; ackHeaders?: Record<string, string> }>;

  /** 子类实现：解析平台 payload 为统一事件；返回 null 表示忽略（如非文本消息） */
  protected abstract parse(
    raw: Buffer,
    headers: http.IncomingHttpHeaders,
  ): Promise<ParsedEvent | null>;

  /** 子类实现：调用平台 API 发送回复 */
  protected abstract sendReply(target: ParsedEvent, text: string): Promise<void>;

  /** HMAC-SHA256 签名工具，子类复用 */
  protected hmacSha256(secret: string, data: string | Buffer): string {
    return crypto.createHmac("sha256", secret).update(data).digest("hex");
  }

  /** timing-safe 字符串比较 */
  protected safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }
}
