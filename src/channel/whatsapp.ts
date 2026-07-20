/**
 * WhatsApp Channel —— 通过 WhatsApp Business Cloud API（Meta Graph API）接入
 *
 * 接入方式：
 * - webhook 模式：Meta POST 事件到 /whatsapp/webhook
 * - GET 校验：配置 webhook 时 Meta 发 hub.challenge 验证请求
 * - 签名：X-Hub-Signature-256（HMAC-SHA256 over raw body，用 appSecret）
 * - 回复：POST https://graph.facebook.com/v18.0/{phone_id}/messages
 *
 * 文档：https://developers.facebook.com/docs/whatsapp/cloud-api
 */

import http from "node:http";
import crypto from "node:crypto";
import type { Channel, ChannelEvent, ChannelReply, Scope } from "../core/types.js";

export interface WhatsAppChannelOptions {
  /** WhatsApp Business Phone Number ID（Graph API 路径参数） */
  phoneNumberId: string;
  /** Meta Graph API access token（永久或长期 token） */
  accessToken: string;
  /** App Secret，用于校验 X-Hub-Signature-256 */
  appSecret?: string;
  /** webhook 校验 token（配置 webhook 时填的 verify token） */
  verifyToken?: string;
  /** HTTP 监听端口 */
  port?: number;
  /** HTTP 监听地址 */
  host?: string;
  /** webhook 路径 */
  path?: string;
  /** Graph API 版本，默认 v18.0 */
  apiVersion?: string;
  /** 默认 scope */
  defaultScope?: Scope;
  /** 根据 WhatsApp 用户手机号解析 scope */
  resolveScope?: (phone: string) => Scope | undefined;
}

interface WhatsAppWebhookPayload {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      value?: {
        messaging_product?: string;
        from?: string; // 用户手机号
        messages?: Array<{
          id?: string;
          type?: string;
          text?: { body?: string };
          timestamp?: string;
        }>;
      };
      field?: string;
    }>;
  }>;
}

export class WhatsAppChannel implements Channel {
  readonly name = "whatsapp";
  private server?: http.Server;
  private pending = new Map<string, (reply: ChannelReply) => void>();
  private opts: Required<
    Omit<WhatsAppChannelOptions, "appSecret" | "verifyToken" | "defaultScope" | "resolveScope">
  > & {
    appSecret: string;
    verifyToken: string;
    defaultScope?: Scope;
    resolveScope?: (phone: string) => Scope | undefined;
  };

  constructor(opts: WhatsAppChannelOptions) {
    this.opts = {
      phoneNumberId: opts.phoneNumberId,
      accessToken: opts.accessToken,
      appSecret: opts.appSecret ?? "",
      verifyToken: opts.verifyToken ?? "",
      port: opts.port ?? 8790,
      host: opts.host ?? "0.0.0.0",
      path: opts.path ?? "/whatsapp/webhook",
      apiVersion: opts.apiVersion ?? "v18.0",
      defaultScope: opts.defaultScope,
      resolveScope: opts.resolveScope,
    };
  }

  async start(emit: (event: ChannelEvent) => void): Promise<void> {
    if (!this.opts.phoneNumberId || !this.opts.accessToken) {
      throw new Error("WhatsApp phoneNumberId 与 accessToken 必填");
    }

    this.server = http.createServer(async (req, res) => {
      const url = req.url ?? "";
      if (!url.startsWith(this.opts.path)) {
        res.writeHead(404).end('{"error":"not found"}');
        return;
      }

      // GET = webhook 配置时的验证请求
      if (req.method === "GET") {
        const params = new URLSearchParams(url.split("?")[1] ?? "");
        const mode = params.get("hub.mode");
        const token = params.get("hub.verify_token");
        const challenge = params.get("hub.challenge");
        if (mode === "subscribe" && token === this.opts.verifyToken && challenge) {
          res.writeHead(200, { "Content-Type": "text/plain" }).end(challenge);
        } else {
          res.writeHead(403).end('{"error":"bad verify token"}');
        }
        return;
      }

      if (req.method !== "POST") {
        res.writeHead(405).end('{"error":"method not allowed"}');
        return;
      }

      // 读取 body
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks);

      // 签名校验（appSecret 配置时）
      if (this.opts.appSecret) {
        const sig = req.headers["x-hub-signature-256"] as string | undefined;
        if (!sig || !this.verifySignature(raw, this.opts.appSecret, sig)) {
          res.writeHead(401).end('{"error":"bad signature"}');
          return;
        }
      }

      // 立即 ACK（Meta 要求 5s 内返回 200）
      res.writeHead(200).end('{"ok":true}');

      let payload: WhatsAppWebhookPayload;
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }

      const parsed = this.parsePayload(payload);
      if (!parsed) return;

      const scope =
        this.opts.resolveScope?.(parsed.userId) ?? this.opts.defaultScope;
      const event: ChannelEvent = {
        userId: parsed.userId,
        sessionId: parsed.sessionId,
        text: parsed.text,
        from: parsed.userId,
        receivedAt: Date.now(),
        scope,
        meta: { phone: parsed.userId, messageId: parsed.messageId },
      };

      // 等 agent 回复，再调 Graph API 发消息
      const reply = await new Promise<ChannelReply>((resolve) => {
        this.pending.set(parsed.sessionId, resolve);
        emit(event);
      });
      await this.sendReply(parsed.userId, reply.text).catch(() => undefined);
      this.pending.delete(parsed.sessionId);
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.opts.port, this.opts.host, () => resolve());
    });
    console.log(`[whatsapp] webhook: http://${this.opts.host}:${this.opts.port}${this.opts.path}`);
  }

  async reply(sessionId: string, reply: ChannelReply): Promise<void> {
    const resolve = this.pending.get(sessionId);
    if (resolve) resolve(reply);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** 解析 webhook payload，返回用户手机号 / 文本 / 消息 ID */
  private parsePayload(
    payload: WhatsAppWebhookPayload,
  ): { userId: string; sessionId: string; text: string; messageId?: string } | null {
    const changes = payload.entry?.[0]?.changes?.[0];
    const value = changes?.value;
    if (!value || value.messaging_product !== "whatsapp") return null;
    const from = value.from;
    const msg = value.messages?.[0];
    if (!from || !msg) return null;
    if (msg.type !== "text") return null;
    const text = msg.text?.body ?? "";
    if (!text.trim()) return null;
    return {
      userId: from,
      sessionId: `whatsapp-${from}`,
      text,
      messageId: msg.id,
    };
  }

  /** 调 Graph API 发送文本消息 */
  private async sendReply(to: string, text: string): Promise<void> {
    const url = `https://graph.facebook.com/${this.opts.apiVersion}/${this.opts.phoneNumberId}/messages`;
    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      }),
    });
  }

  /** X-Hub-Signature-256 校验：HMAC-SHA256(raw, appSecret) → "sha256=<hex>" */
  private verifySignature(raw: Buffer, appSecret: string, sig: string): boolean {
    const expected =
      "sha256=" + crypto.createHmac("sha256", appSecret).update(raw).digest("hex");
    if (expected.length !== sig.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  }
}
