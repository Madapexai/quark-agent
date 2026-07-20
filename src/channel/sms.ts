/**
 * SMS / Twilio Channel —— 通过 Twilio REST API 收发短信
 *
 * 接入方式：
 * - webhook 模式：Twilio POST 到 /sms/webhook（接收回复的 SMS）
 * - reply：POST https://api.twilio.com/2010-04-01/Accounts/{Sid}/Messages.json
 * - 鉴权：HTTP Basic Auth（accountSid:authToken）
 *
 * 不引 twilio SDK，仅用 fetch + Node 内置模块。
 * 文档：https://www.twilio.com/docs/sms/api
 */

import http from "node:http";
import type { Channel, ChannelEvent, ChannelReply, Scope } from "../core/types.js";

export interface SmsChannelOptions {
  /** Twilio Account SID */
  accountSid: string;
  /** Twilio Auth Token */
  authToken: string;
  /** Twilio 发送号码（如 +1234567890） */
  fromNumber: string;
  /** HTTP 监听端口 */
  port?: number;
  /** HTTP 监听地址 */
  host?: string;
  /** webhook 路径 */
  path?: string;
  /** 默认 scope */
  defaultScope?: Scope;
  /** 根据发件人号码解析 scope */
  resolveScope?: (phone: string) => Scope | undefined;
}

export class SmsChannel implements Channel {
  readonly name = "sms";
  private server?: http.Server;
  private pending = new Map<string, (reply: ChannelReply) => void>();
  private opts: Required<
    Omit<SmsChannelOptions, "defaultScope" | "resolveScope">
  > & {
    defaultScope?: Scope;
    resolveScope?: (phone: string) => Scope | undefined;
  };

  constructor(opts: SmsChannelOptions) {
    this.opts = {
      accountSid: opts.accountSid,
      authToken: opts.authToken,
      fromNumber: opts.fromNumber,
      port: opts.port ?? 8791,
      host: opts.host ?? "0.0.0.0",
      path: opts.path ?? "/sms/webhook",
      defaultScope: opts.defaultScope,
      resolveScope: opts.resolveScope,
    };
  }

  async start(emit: (event: ChannelEvent) => void): Promise<void> {
    if (!this.opts.accountSid || !this.opts.authToken || !this.opts.fromNumber) {
      throw new Error("Twilio accountSid / authToken / fromNumber 必填");
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

      // 读取 body（Twilio 用 application/x-www-form-urlencoded）
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");

      // 立即 ACK（Twilio 要求快速 200，回复走异步 SMS）
      res.writeHead(200, { "Content-Type": "text/xml" }).end("<Response></Response>");

      const params = new URLSearchParams(raw);
      const from = params.get("From") ?? "";
      const body = params.get("Body") ?? "";
      if (!from || !body.trim()) return;

      const sessionId = `sms-${from}`;
      const scope = this.opts.resolveScope?.(from) ?? this.opts.defaultScope;
      const event: ChannelEvent = {
        userId: from,
        sessionId,
        text: body,
        from,
        receivedAt: Date.now(),
        scope,
        meta: { channel: this.name, from, messageSid: params.get("MessageSid") },
      };

      // 等 agent 回复，再 Twilio API 发 SMS
      const reply = await new Promise<ChannelReply>((resolve) => {
        this.pending.set(sessionId, resolve);
        emit(event);
      });
      await this.sendSms(from, reply.text).catch(() => undefined);
      this.pending.delete(sessionId);
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.opts.port, this.opts.host, () => resolve());
    });
    console.log(`[sms] webhook: http://${this.opts.host}:${this.opts.port}${this.opts.path}`);
  }

  async reply(sessionId: string, reply: ChannelReply): Promise<void> {
    const resolve = this.pending.get(sessionId);
    if (resolve) resolve(reply);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** 调 Twilio Messages API 发送 SMS */
  private async sendSms(to: string, text: string): Promise<void> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.opts.accountSid}/Messages.json`;
    const auth = Buffer.from(`${this.opts.accountSid}:${this.opts.authToken}`).toString("base64");
    const form = new URLSearchParams();
    form.set("To", to);
    form.set("From", this.opts.fromNumber);
    form.set("Body", text);
    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
  }
}
