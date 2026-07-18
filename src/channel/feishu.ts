/**
 * 飞书（Lark/Feishu）Channel
 *
 * 接入方式：事件订阅 v2（长连接或 webhook）
 * - webhook 模式：飞书 POST 事件到 /feishu/webhook
 * - 需校验 Encrypt Key（AES-256-CBC 解密）+ Verification Token
 * - URL 验证：首次配置时飞书发 challenge，需原样返回
 * - 回复：调 /open-apis/im/v1/messages 接口（需 tenant_access_token）
 *
 * 文档：https://open.feishu.cn/document/server-docs/event-subscription-guide/overview
 */

import http from "node:http";
import crypto from "node:crypto";
import { WebhookChannel, type ParsedEvent, type WebhookChannelOptions } from "./webhook.js";

export interface FeishuChannelOptions extends WebhookChannelOptions {
  path?: string;
  /** 飞书应用 App ID */
  appId: string;
  /** 飞书应用 App Secret（换 tenant_access_token） */
  appSecret: string;
  /** 事件订阅 Verification Token */
  verificationToken?: string;
  /** 事件订阅 Encrypt Key（AES-256-CBC） */
  encryptKey?: string;
}

interface FeishuEvent {
  schema?: string;
  header?: {
    event_id?: string;
    event_type?: string;
    token?: string;
  };
  event?: {
    sender?: { sender_id?: { open_id?: string; union_id?: string } };
    message?: {
      chat_id?: string;
      message_id?: string;
      message_type?: string;
      content?: string;
    };
  };
  /** URL 验证请求 */
  challenge?: string;
  /** 加密事件体 */
  encrypt?: string;
  type?: string;
  token?: string;
}

interface TokenCache {
  token: string;
  expireAt: number;
}

export class FeishuChannel extends WebhookChannel {
  readonly name = "feishu";
  private readonly feishuOpts: Omit<FeishuChannelOptions, "path" | "port" | "host" | "defaultScope" | "resolveScope">;
  private tokenCache?: TokenCache;

  constructor(opts: FeishuChannelOptions) {
    super({ ...opts, path: opts.path ?? "/feishu/webhook" });
    this.feishuOpts = {
      appId: opts.appId,
      appSecret: opts.appSecret,
      verificationToken: opts.verificationToken,
      encryptKey: opts.encryptKey,
    };
  }

  protected async verify(
    _headers: http.IncomingHttpHeaders,
    raw: Buffer,
  ): Promise<{ ok: boolean; ackBody?: string; ackHeaders?: Record<string, string> }> {
    // 解密加密事件体（encryptKey 模式）
    let bodyText = raw.toString("utf8");
    let body: FeishuEvent;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return { ok: false };
    }
    if (body.encrypt && this.feishuOpts.encryptKey) {
      try {
        bodyText = this.decrypt(this.feishuOpts.encryptKey, body.encrypt);
        body = JSON.parse(bodyText);
      } catch {
        return { ok: false };
      }
    }
    // URL 验证：原样返回 challenge
    if (body.type === "url_verification" && body.challenge) {
      return {
        ok: true,
        ackBody: JSON.stringify({ challenge: body.challenge }),
        ackHeaders: { "Content-Type": "application/json" },
      };
    }
    // 非验证请求放行到 parse；bodyText 暂存供 parse 复用
    (this as unknown as { _lastBody: FeishuEvent })._lastBody = body;
    return { ok: true };
  }

  protected async parse(
    _raw: Buffer,
    _headers: http.IncomingHttpHeaders,
  ): Promise<ParsedEvent | null> {
    const body = (this as unknown as { _lastBody?: FeishuEvent })._lastBody;
    if (!body) return null;
    return this.parseEvent(body);
  }

  protected async sendReply(target: ParsedEvent, text: string): Promise<void> {
    const chatId = target.replyTarget.chat_id as string | undefined;
    const recvMsgId = target.replyTarget.message_id as string | undefined;
    if (!chatId) return;
    const token = await this.getTenantAccessToken();
    const url = "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id";
    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
        ...(recvMsgId ? { reply_in_thread: false } : {}),
      }),
    });
  }

  private parseEvent(body: FeishuEvent): ParsedEvent | null {
    // 校验 verification token
    if (this.feishuOpts.verificationToken && body.header?.token) {
      if (body.header.token !== this.feishuOpts.verificationToken) return null;
    }
    // 仅处理消息事件
    const msg = body.event?.message;
    const sender = body.event?.sender?.sender_id;
    if (!msg || !sender) return null;
    // 仅文本消息
    if (msg.message_type !== "text") return null;
    let text = "";
    try {
      const content = JSON.parse(msg.content ?? "{}");
      text = content.text ?? "";
    } catch {
      text = "";
    }
    if (!text.trim()) return null;
    // @机器人 时带 @user_xxx 前缀，剥除
    text = text.replace(/@_user_\d+/g, "").trim();

    const userId = sender.open_id ?? sender.union_id ?? "feishu-anon";
    return {
      userId,
      sessionId: msg.chat_id ?? `feishu-${userId}`,
      text,
      from: userId,
      replyTarget: { chat_id: msg.chat_id, message_id: msg.message_id },
    };
  }

  /** 换取并缓存 tenant_access_token（有效期约 2h） */
  private async getTenantAccessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expireAt > Date.now() + 60_000) {
      return this.tokenCache.token;
    }
    const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: this.feishuOpts.appId, app_secret: this.feishuOpts.appSecret }),
    });
    const data = (await res.json()) as { tenant_access_token?: string; expire?: number; code?: number };
    if (!data.tenant_access_token) throw new Error(`feishu token failed: code=${data.code}`);
    this.tokenCache = {
      token: data.tenant_access_token,
      expireAt: Date.now() + (data.expire ?? 7200) * 1000,
    };
    return this.tokenCache.token;
  }

  /** AES-256-CBC 解密飞书加密事件（encryptKey 模式） */
  private decrypt(encryptKey: string, encrypted: string): string {
    const key = crypto.createHash("sha256").update(encryptKey).digest();
    const buf = Buffer.from(encrypted, "base64");
    const iv = buf.subarray(0, 16);
    const cipherText = buf.subarray(16);
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    decipher.setAutoPadding(true);
    const decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]);
    // 去除前 32 字节随机串 + 4 字节长度 + 4 字节消息长度
    return decrypted.subarray(32 + 4).toString("utf8").replace(/^[\s\S]{4}/, "");
  }
}
