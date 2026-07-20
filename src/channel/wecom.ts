/**
 * 企业微信（WeCom）Channel —— 通过应用消息 API 收发
 *
 * 接入方式：
 * - 接收回调：企业微信 POST 到 /wecom/callback（含 msg_signature/timestamp/nonce）
 * - 加解密：AES-256-CBC（EncodingAESKey 43 字符 → 32 字节 key）
 * - 签名：sha1(sort(token, timestamp, nonce, encrypt)) 比对 msg_signature
 * - URL 验证：GET 带 echostr，解密后原样返回
 * - reply：先 GET access_token，POST https://qyapi.weixin.qq.com/cgi-bin/message/send
 *
 * 与 wechat.ts 区别：仅企业微信应用消息场景，非公众号 / 非通用 wechat 通道。
 * 文档：https://developer.work.weixin.qq.com/document/path/90240
 */

import http from "node:http";
import crypto from "node:crypto";
import type { Channel, ChannelEvent, ChannelReply, Scope } from "../core/types.js";

export interface WeComChannelOptions {
  /** 企业 CorpID */
  corpId: string;
  /** 应用 AgentID */
  agentId: number;
  /** 应用 Secret */
  secret: string;
  /** 回调 Token（签名校验） */
  token: string;
  /** EncodingAESKey（43 字符，加解密） */
  encodingAESKey: string;
  /** HTTP 监听端口 */
  port?: number;
  /** HTTP 监听地址 */
  host?: string;
  /** 回调路径 */
  path?: string;
  /** 默认 scope */
  defaultScope?: Scope;
  /** 根据企业微信 userId 解析 scope */
  resolveScope?: (wecomUserId: string) => Scope | undefined;
}

interface WeComXml {
  ToUserName?: string;
  FromUserName?: string; // 企业微信用户 UserID
  CreateTime?: string;
  MsgType?: string;
  Content?: string;
  MsgId?: string;
  AgentID?: string;
  Encrypt?: string;
}

interface TokenCache {
  token: string;
  expireAt: number;
}

export class WeComChannel implements Channel {
  readonly name = "wecom";
  private server?: http.Server;
  private pending = new Map<string, (reply: ChannelReply) => void>();
  private aesKey: Buffer;
  private tokenCache?: TokenCache;
  private opts: Required<
    Omit<WeComChannelOptions, "defaultScope" | "resolveScope">
  > & {
    defaultScope?: Scope;
    resolveScope?: (wecomUserId: string) => Scope | undefined;
  };

  constructor(opts: WeComChannelOptions) {
    this.opts = {
      corpId: opts.corpId,
      agentId: opts.agentId,
      secret: opts.secret,
      token: opts.token,
      encodingAESKey: opts.encodingAESKey,
      port: opts.port ?? 8793,
      host: opts.host ?? "0.0.0.0",
      path: opts.path ?? "/wecom/callback",
      defaultScope: opts.defaultScope,
      resolveScope: opts.resolveScope,
    };
    // EncodingAESKey 是 43 字符 base64，补 = 后 base64 解码得 32 字节 AES key
    this.aesKey = Buffer.from(`${opts.encodingAESKey}=`, "base64");
  }

  async start(emit: (event: ChannelEvent) => void): Promise<void> {
    if (!this.opts.corpId || !this.opts.secret || !this.opts.token || !this.opts.encodingAESKey) {
      throw new Error("WeCom corpId/secret/token/encodingAESKey 必填");
    }

    this.server = http.createServer(async (req, res) => {
      const url = req.url ?? "";
      if (!url.startsWith(this.opts.path)) {
        res.writeHead(404).end('{"error":"not found"}');
        return;
      }

      const params = new URLSearchParams(url.split("?")[1] ?? "");
      const msgSig = params.get("msg_signature") ?? "";
      const timestamp = params.get("timestamp") ?? "";
      const nonce = params.get("nonce") ?? "";
      const echostr = params.get("echostr") ?? "";

      // GET = URL 验证（解密 echostr 原样返回）
      if (req.method === "GET") {
        if (!echostr) {
          res.writeHead(400).end('{"error":"missing echostr"}');
          return;
        }
        // 校验签名
        if (!this.verifySignature(msgSig, timestamp, nonce, echostr)) {
          res.writeHead(401).end('{"error":"bad signature"}');
          return;
        }
        const decrypted = this.decryptAES(echostr);
        res.writeHead(200, { "Content-Type": "text/plain" }).end(decrypted);
        return;
      }

      if (req.method !== "POST") {
        res.writeHead(405).end('{"error":"method not allowed"}');
        return;
      }

      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");

      // 立即 ACK（企业微信要求 5s 内响应，回复走异步消息）
      res.writeHead(200, { "Content-Type": "text/plain" }).end("success");

      const outerXml = this.parseXml(raw);
      if (!outerXml?.Encrypt) return;

      // 校验签名（含加密体）
      if (!this.verifySignature(msgSig, timestamp, nonce, outerXml.Encrypt)) return;

      // 解密
      const decryptedXml = this.decryptAES(outerXml.Encrypt);
      const innerXml = this.parseXml(decryptedXml);
      if (!innerXml) return;
      if (innerXml.MsgType !== "text") return;
      const content = innerXml.Content ?? "";
      const fromUser = innerXml.FromUserName ?? "";
      if (!content.trim() || !fromUser) return;

      const sessionId = `wecom-${fromUser}`;
      const scope = this.opts.resolveScope?.(fromUser) ?? this.opts.defaultScope;
      const event: ChannelEvent = {
        userId: fromUser,
        sessionId,
        text: content.trim(),
        from: fromUser,
        receivedAt: Date.now(),
        scope,
        meta: { channel: this.name, userId: fromUser, msgId: innerXml.MsgId },
      };

      // 等 agent 回复，再调 message/send
      const reply = await new Promise<ChannelReply>((resolve) => {
        this.pending.set(sessionId, resolve);
        emit(event);
      });
      await this.sendReply(fromUser, reply.text).catch(() => undefined);
      this.pending.delete(sessionId);
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.opts.port, this.opts.host, () => resolve());
    });
    console.log(`[wecom] callback: http://${this.opts.host}:${this.opts.port}${this.opts.path}`);
  }

  async reply(sessionId: string, reply: ChannelReply): Promise<void> {
    const resolve = this.pending.get(sessionId);
    if (resolve) resolve(reply);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** 签名校验：sha1(sort(token, timestamp, nonce [, encrypt])) */
  private verifySignature(
    msgSig: string,
    timestamp: string,
    nonce: string,
    encrypt: string,
  ): boolean {
    if (!msgSig) return false;
    const parts = [this.opts.token, timestamp, nonce, encrypt].sort().join("");
    const expected = crypto.createHash("sha1").update(parts).digest("hex");
    if (expected.length !== msgSig.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(msgSig));
  }

  /** AES-256-CBC 解密企业微信回调消息 */
  private decryptAES(encrypted: string): string {
    const iv = this.aesKey.subarray(0, 16);
    const buf = Buffer.from(encrypted, "base64");
    const decipher = crypto.createDecipheriv("aes-256-cbc", this.aesKey, iv);
    decipher.setAutoPadding(false);
    let decrypted = Buffer.concat([decipher.update(buf), decipher.final()]);
    // 去除 PKCS#7 padding
    const pad = decrypted[decrypted.length - 1];
    decrypted = decrypted.subarray(0, decrypted.length - pad);
    // 前 16 字节随机串 + 4 字节网络序消息长度 + 消息体 + CorpID
    const msgLen = decrypted.readUInt32BE(16);
    const msg = decrypted.subarray(20, 20 + msgLen);
    return msg.toString("utf8");
  }

  /** 获取并缓存 access_token */
  private async getAccessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expireAt > Date.now() + 60_000) {
      return this.tokenCache.token;
    }
    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${this.opts.corpId}&corpsecret=${this.opts.secret}`;
    const res = await fetch(url);
    const data = (await res.json()) as { access_token?: string; expires_in?: number; errcode?: number };
    if (!data.access_token) {
      throw new Error(`wecom gettoken failed: errcode=${data.errcode}`);
    }
    this.tokenCache = {
      token: data.access_token,
      expireAt: Date.now() + (data.expires_in ?? 7200) * 1000,
    };
    return this.tokenCache.token;
  }

  /** 调企业微信 message/send 发文本消息 */
  private async sendReply(toUser: string, text: string): Promise<void> {
    const token = await this.getAccessToken();
    const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        touser: toUser,
        msgtype: "text",
        agentid: this.opts.agentId,
        text: { content: text },
      }),
    });
  }

  /** 极简 XML 解析（企业微信消息结构简单，不引 xml2js 减重） */
  private parseXml(xml: string): WeComXml | null {
    const result: Record<string, string> = {};
    const re = /<(\w+)><!\[CDATA\[(.*?)\]\]><\/\1>|<(\w+)>(.*?)<\/\3>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      const key = m[1] ?? m[3];
      const val = m[2] ?? m[4];
      if (key) result[key] = val;
    }
    if (Object.keys(result).length === 0) return null;
    return result as unknown as WeComXml;
  }
}
