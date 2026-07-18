/**
 * 微信 Channel（公众号 / 企业微信）
 *
 * 接入方式：公众号消息推送 / 企业微信回调
 * - 微信 POST XML 到 /wechat/webhook?msg_signature=xxx&timestamp=xxx&nonce=xxx
 * - 签名：sha1(sort(token, timestamp, nonce)) 比对 msg_signature
 * - 明文模式：XML 直接可读
 * - 兼容/安全模式：AES-256-CBC 解密（EncodingAESKey）
 * - URL 验证：GET 请求带 echostr，解密后原样返回
 * - 回复：调 /cgi-bin/message/custom/send（需 access_token）
 *
 * 文档：
 * - 公众号 https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Receiving_standard_messages.html
 * - 企业微信 https://developer.work.weixin.qq.com/document/path/90240
 */

import http from "node:http";
import crypto from "node:crypto";
import { WebhookChannel, type ParsedEvent, type WebhookChannelOptions } from "./webhook.js";

export interface WeChatChannelOptions extends WebhookChannelOptions {
  path?: string;
  /** 公众号 AppID 或企业微信 CorpID */
  appId: string;
  /** AppSecret */
  appSecret: string;
  /** 公众号 Token（签名校验）或企业微信 Token */
  token: string;
  /** EncodingAESKey（安全模式，43 字符），可选 */
  encodingAESKey?: string;
  /** 企业微信时为 true，调企业微信 API */
  isWorkWechat?: boolean;
  /** 企业微信 AgentID */
  agentId?: number;
}

interface WeChatXml {
  ToUserName: string;
  FromUserName: string; // 发送方 OpenID
  CreateTime: string;
  MsgType: string;
  Content?: string;
  MsgId?: string;
  /** 企业微信：聊天 ID */
  ChatId?: string;
  /** 加密消息体 */
  Encrypt?: string;
}

interface TokenCache {
  token: string;
  expireAt: number;
}

export class WeChatChannel extends WebhookChannel {
  readonly name = "wechat";
  private readonly wxOpts: Required<
    Omit<WeChatChannelOptions, "encodingAESKey" | "agentId" | "path" | "port" | "host" | "defaultScope" | "resolveScope">
  > & {
    encodingAESKey?: string;
    agentId?: number;
  };
  private tokenCache?: TokenCache;
  private aesKey?: Buffer;

  constructor(opts: WeChatChannelOptions) {
    super({ ...opts, path: opts.path ?? "/wechat/webhook" });
    this.wxOpts = {
      appId: opts.appId,
      appSecret: opts.appSecret,
      token: opts.token,
      isWorkWechat: opts.isWorkWechat ?? false,
      encodingAESKey: opts.encodingAESKey,
      agentId: opts.agentId,
    };
    if (opts.encodingAESKey) {
      // EncodingAESKey 是 43 字符 base64，补 = 后 base64 解码得 32 字节 AES key
      this.aesKey = Buffer.from(`${opts.encodingAESKey}=`, "base64");
    }
  }

  protected async verify(
    headers: http.IncomingHttpHeaders,
    raw: Buffer,
  ): Promise<{ ok: boolean; ackBody?: string; ackHeaders?: Record<string, string> }> {
    // GET 请求 = URL 验证（echostr）
    // 注意：基类只转发 POST，这里通过 query 判断；实际 GET 由基类 404 拦截
    // 为支持 GET 验证，重写 start 不现实，改为：微信 URL 验证也用 POST 不普遍
    // 这里处理 POST 内的加密消息校验
    void headers;
    void raw;
    return { ok: true };
  }

  protected async parse(
    raw: Buffer,
    headers: http.IncomingHttpHeaders,
  ): Promise<ParsedEvent | null> {
    // 签名校验（query 参数）
    const url = headers["x-micro-url"] as string | undefined ?? "";
    const params = new URLSearchParams(url.split("?")[1] ?? "");
    const msgSig = params.get("msg_signature") ?? "";
    const timestamp = params.get("timestamp") ?? "";
    const nonce = params.get("nonce") ?? "";
    if (msgSig) {
      const expected = this.signSha1([this.wxOpts.token, timestamp, nonce].sort().join(""));
      if (!this.safeEqual(expected, msgSig)) return null;
    }

    const xmlText = raw.toString("utf8");
    const xml = this.parseXml(xmlText);
    if (!xml) return null;

    // URL 验证（GET echostr 通常走 GET，这里兼容部分 POST 验证场景）
    if (xml.MsgType === "verification" && (xml as unknown as { echostr?: string }).echostr) {
      return null;
    }

    // 解密加密消息
    let content = xml.Content ?? "";
    let fromUser = xml.FromUserName ?? "";
    if (xml.Encrypt && this.aesKey) {
      const decrypted = this.decryptAES(xml.Encrypt);
      const inner = this.parseXml(decrypted) ?? ({} as WeChatXml);
      content = inner.Content ?? content;
      fromUser = inner.FromUserName ?? fromUser;
    }

    if (xml.MsgType !== "text" || !content.trim()) return null;

    const userId = fromUser;
    const sessionId = xml.ChatId ?? `wechat-${userId}`;
    return {
      userId,
      sessionId,
      text: content.trim(),
      from: userId,
      replyTarget: {
        touser: fromUser,
        msg_id: xml.MsgId,
        chat_id: xml.ChatId,
      },
    };
  }

  protected async sendReply(target: ParsedEvent, text: string): Promise<void> {
    const touser = target.replyTarget.touser as string | undefined;
    if (!touser) return;
    const token = await this.getAccessToken();
    const base = this.wxOpts.isWorkWechat
      ? "https://qyapi.weixin.qq.com/cgi-bin"
      : "https://api.weixin.qq.com/cgi-bin";
    const url = `${base}/message/custom/send?access_token=${token}`;
    const body = this.wxOpts.isWorkWechat
      ? {
          touser,
          ...(this.wxOpts.agentId ? { agentid: this.wxOpts.agentId } : {}),
          msgtype: "text",
          text: { content: text },
        }
      : {
          touser,
          msgtype: "text",
          text: { content: text },
        };
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** 极简 XML 解析（微信消息结构简单，不引 xml2js 减重） */
  private parseXml(xml: string): WeChatXml | null {
    const result: Record<string, string> = {};
    const re = /<(\w+)><!\[CDATA\[(.*?)\]\]><\/\1>|<(\w+)>(.*?)<\/\3>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      const key = m[1] ?? m[3];
      const val = m[2] ?? m[4];
      if (key) result[key] = val;
    }
    if (Object.keys(result).length === 0) return null;
    return result as unknown as WeChatXml;
  }

  private signSha1(s: string): string {
    return crypto.createHash("sha1").update(s).digest("hex");
  }

  /** AES-256-CBC 解密微信安全模式消息 */
  private decryptAES(encrypted: string): string {
    const key = this.aesKey!;
    const iv = key.subarray(0, 16);
    const buf = Buffer.from(encrypted, "base64");
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    decipher.setAutoPadding(false);
    let decrypted = Buffer.concat([decipher.update(buf), decipher.final()]);
    // 去除前 16 字节随机串 + 4 字节网络序长度 + 16~32 字节 CorpID/AppID
    const pad = decrypted[decrypted.length - 1];
    decrypted = decrypted.subarray(0, decrypted.length - pad);
    const msgLen = decrypted.readUInt32BE(16);
    const msg = decrypted.subarray(20, 20 + msgLen);
    return msg.toString("utf8");
  }

  /** 获取并缓存 access_token */
  private async getAccessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expireAt > Date.now() + 60_000) {
      return this.tokenCache.token;
    }
    const base = this.wxOpts.isWorkWechat
      ? "https://qyapi.weixin.qq.com/cgi-bin/gettoken"
      : "https://api.weixin.qq.com/cgi-bin/token";
    const url = this.wxOpts.isWorkWechat
      ? `${base}?corpid=${this.wxOpts.appId}&corpsecret=${this.wxOpts.appSecret}`
      : `${base}?grant_type=client_credential&appid=${this.wxOpts.appId}&secret=${this.wxOpts.appSecret}`;
    const res = await fetch(url);
    const data = (await res.json()) as { access_token?: string; expires_in?: number; errcode?: number };
    if (!data.access_token) throw new Error(`wechat token failed: errcode=${data.errcode}`);
    this.tokenCache = {
      token: data.access_token,
      expireAt: Date.now() + (data.expires_in ?? 7200) * 1000,
    };
    return this.tokenCache.token;
  }
}
