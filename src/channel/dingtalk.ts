/**
 * 钉钉（DingTalk）Channel —— 机器人 outgoing webhook + 加签回复
 *
 * 接入方式：
 * - outgoing 模式：钉钉 POST 到 /dingtalk/webhook（含 timestamp + sign query）
 * - 签名：HMAC-SHA256(secret, timestamp) → base64 → urlenc，与 sign 比对
 * - reply：POST 机器人 webhook URL + 计算签名（timestamp + sign 作为 query）
 *
 * 文档：
 * - 自定义机器人 outgoing https://open.dingtalk.com/document/robots/robot-overview
 * - 加签 https://open.dingtalk.com/document/robots/customize-robot-security-settings
 */

import http from "node:http";
import crypto from "node:crypto";
import type { Channel, ChannelEvent, ChannelReply, Scope } from "../core/types.js";

export interface DingTalkChannelOptions {
  /** 机器人 webhook URL（发消息用，https://oapi.dingtalk.com/robot/send?access_token=xxx） */
  webhookUrl: string;
  /** 加签密钥（SEC 开头） */
  secret: string;
  /** HTTP 监听端口 */
  port?: number;
  /** HTTP 监听地址 */
  host?: string;
  /** webhook 路径 */
  path?: string;
  /** 默认 scope */
  defaultScope?: Scope;
  /** 根据钉钉 userId 解析 scope */
  resolveScope?: (dingtalkUserId: string) => Scope | undefined;
}

interface DingTalkOutgoingPayload {
  msgtype?: string;
  text?: { content?: string };
  senderId?: string;
  senderNick?: string;
  conversationId?: string;
  chatbotUserId?: string;
  conversationType?: string; // 1 单聊 / 2 群
  msgId?: string;
  isAtAll?: boolean;
  sessionWebhookExpiredTime?: number;
}

export class DingTalkChannel implements Channel {
  readonly name = "dingtalk";
  private server?: http.Server;
  private pending = new Map<string, (reply: ChannelReply) => void>();
  private opts: Required<
    Omit<DingTalkChannelOptions, "defaultScope" | "resolveScope">
  > & {
    defaultScope?: Scope;
    resolveScope?: (dingtalkUserId: string) => Scope | undefined;
  };

  constructor(opts: DingTalkChannelOptions) {
    this.opts = {
      webhookUrl: opts.webhookUrl,
      secret: opts.secret,
      port: opts.port ?? 8792,
      host: opts.host ?? "0.0.0.0",
      path: opts.path ?? "/dingtalk/webhook",
      defaultScope: opts.defaultScope,
      resolveScope: opts.resolveScope,
    };
  }

  async start(emit: (event: ChannelEvent) => void): Promise<void> {
    if (!this.opts.webhookUrl || !this.opts.secret) {
      throw new Error("DingTalk webhookUrl 与 secret 必填");
    }

    this.server = http.createServer(async (req, res) => {
      const url = req.url ?? "";
      if (!url.startsWith(this.opts.path)) {
        res.writeHead(404).end('{"error":"not found"}');
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405).end('{"error":"method not allowed"}');
        return;
      }

      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks);

      // 签名校验（query: timestamp + sign）
      const params = new URLSearchParams(url.split("?")[1] ?? "");
      const timestamp = params.get("timestamp") ?? "";
      const sign = params.get("sign") ?? "";
      if (timestamp && sign) {
        const expected = this.sign(timestamp);
        if (expected !== sign) {
          res.writeHead(401).end('{"error":"bad sign"}');
          return;
        }
      }

      // 立即 ACK
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');

      let payload: DingTalkOutgoingPayload;
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }

      // 仅文本消息
      if (payload.msgtype !== "text") return;
      const text = payload.text?.content ?? "";
      if (!text.trim()) return;
      // 剥除 @机器人 时带的 @手机号 前缀
      const cleanText = text.replace(/@\d+/g, "").trim();
      if (!cleanText) return;

      const sender = payload.senderId ?? "dingtalk-anon";
      const sessionId = payload.conversationId ?? `dingtalk-${sender}`;
      const scope = this.opts.resolveScope?.(sender) ?? this.opts.defaultScope;
      const event: ChannelEvent = {
        userId: sender,
        sessionId,
        text: cleanText,
        from: payload.senderNick ?? sender,
        receivedAt: Date.now(),
        scope,
        meta: {
          channel: this.name,
          senderId: sender,
          conversationId: payload.conversationId,
          msgId: payload.msgId,
        },
      };

      // 等 agent 回复，再 POST webhook
      const reply = await new Promise<ChannelReply>((resolve) => {
        this.pending.set(sessionId, resolve);
        emit(event);
      });
      await this.sendReply(reply.text).catch(() => undefined);
      this.pending.delete(sessionId);
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.opts.port, this.opts.host, () => resolve());
    });
    console.log(`[dingtalk] webhook: http://${this.opts.host}:${this.opts.port}${this.opts.path}`);
  }

  async reply(sessionId: string, reply: ChannelReply): Promise<void> {
    const resolve = this.pending.get(sessionId);
    if (resolve) resolve(reply);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** 计算加签：HMAC-SHA256(secret, timestamp) → base64 → urlenc */
  private sign(timestamp: string): string {
    const stringToSign = `${timestamp}\n${this.opts.secret}`;
    const hmac = crypto.createHmac("sha256", this.opts.secret).update(stringToSign).digest("base64");
    return encodeURIComponent(hmac);
  }

  /** 调机器人 webhook URL 发文本（含 timestamp + sign） */
  private async sendReply(text: string): Promise<void> {
    const timestamp = String(Date.now());
    const sign = this.sign(timestamp);
    const sep = this.opts.webhookUrl.includes("?") ? "&" : "?";
    const url = `${this.opts.webhookUrl}${sep}timestamp=${timestamp}&sign=${sign}`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msgtype: "text",
        text: { content: text },
      }),
    });
  }
}
