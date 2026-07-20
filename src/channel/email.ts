/**
 * Email Channel —— 用 Node 内置 net 模块实现最小 IMAP/SMTP 客户端
 *
 * 接入方式：
 * - start() 每 60s IMAP 拉 INBOX 新邮件（SEARCH UNSEEN + FETCH）
 * - reply() 通过 SMTP 发送（EHLO/AUTH LOGIN/MAIL FROM/RCPT TO/DATA）
 * - 仅支持基本 IMAP LOGIN/SELECT/FETCH/SEARCH（不做完整 IMAP 协议）
 * - 仅支持基本 SMTP（不带 STARTTLS 自动升级，假设端口为 465 SSL 或 25/587 明文）
 *
 * 不引 nodemailer / imapflow 等依赖，仅用 net + crypto。
 */

import net from "node:net";
import tls from "node:tls";
import type { Channel, ChannelEvent, ChannelReply, Scope } from "../core/types.js";

export interface EmailChannelOptions {
  /** SMTP 服务器地址 */
  smtpHost: string;
  /** SMTP 端口（465 用 TLS，其他用明文 net） */
  smtpPort?: number;
  /** IMAP 服务器地址 */
  imapHost: string;
  /** IMAP 端口（993 用 TLS，其他用明文 net） */
  imapPort?: number;
  /** 邮箱账号（也作为发件人） */
  username: string;
  /** 邮箱密码或授权码 */
  password: string;
  /** 轮询间隔 ms，默认 60000 */
  pollingIntervalMs?: number;
  /** 拉取的 mailbox，默认 INBOX */
  mailbox?: string;
  /** 是否使用 SSL：默认根据端口判断（465/993 → true） */
  smtpTls?: boolean;
  /** IMAP 是否使用 SSL：默认根据端口判断（993 → true） */
  imapTls?: boolean;
  /** 默认 scope */
  defaultScope?: Scope;
  /** 根据发件人邮箱解析 scope */
  resolveScope?: (email: string) => Scope | undefined;
}

/** 一行式 IMAP/SMTP TCP 客户端：建立连接后用 await send/recv 处理响应 */
class LineSocket {
  private socket: net.Socket;
  private buffer = "";
  private lineResolvers: Array<(line: string) => void> = [];
  private readonly onConnect: () => void;
  private readonly onError: (err: Error) => void;

  constructor(opts: {
    host: string;
    port: number;
    tls: boolean;
    onConnect: () => void;
    onError: (err: Error) => void;
  }) {
    this.onConnect = opts.onConnect;
    this.onError = opts.onError;
    if (opts.tls) {
      this.socket = tls.connect({ host: opts.host, port: opts.port }, this.onConnect);
    } else {
      this.socket = net.createConnection({ host: opts.host, port: opts.port }, this.onConnect);
    }
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf("\r\n")) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 2);
        const resolver = this.lineResolvers.shift();
        if (resolver) resolver(line);
      }
    });
    this.socket.on("error", (err) => this.onError(err));
  }

  /** 读取一行（含 IMAP 未标记响应 / SMTP 状态行） */
  readLine(): Promise<string> {
    return new Promise((resolve) => this.lineResolvers.push(resolve));
  }

  /** 读取多行直到匹配谓词（IMAP tagged response / SMTP 最终行） */
  async readUntil(test: (line: string) => boolean, maxLines = 100): Promise<string[]> {
    const lines: string[] = [];
    for (let i = 0; i < maxLines; i++) {
      const line = await this.readLine();
      lines.push(line);
      if (test(line)) break;
    }
    return lines;
  }

  write(line: string): void {
    this.socket.write(line + "\r\n");
  }

  close(): void {
    this.socket.end();
  }
}

export class EmailChannel implements Channel {
  readonly name = "email";
  private timer?: ReturnType<typeof setInterval>;
  private pending = new Map<string, (reply: ChannelReply) => void>();
  private opts: Required<
    Omit<EmailChannelOptions, "defaultScope" | "resolveScope" | "smtpTls" | "imapTls">
  > & {
    defaultScope?: Scope;
    resolveScope?: (email: string) => Scope | undefined;
    smtpTls: boolean;
    imapTls: boolean;
  };

  constructor(opts: EmailChannelOptions) {
    const smtpTls = opts.smtpTls ?? (opts.smtpPort === 465);
    const imapTls = opts.imapTls ?? (opts.imapPort === 993);
    this.opts = {
      smtpHost: opts.smtpHost,
      smtpPort: opts.smtpPort ?? 465,
      imapHost: opts.imapHost,
      imapPort: opts.imapPort ?? 993,
      username: opts.username,
      password: opts.password,
      pollingIntervalMs: opts.pollingIntervalMs ?? 60_000,
      mailbox: opts.mailbox ?? "INBOX",
      smtpTls,
      imapTls,
      defaultScope: opts.defaultScope,
      resolveScope: opts.resolveScope,
    };
  }

  async start(emit: (event: ChannelEvent) => void): Promise<void> {
    if (!this.opts.username || !this.opts.password) {
      throw new Error("Email username 与 password 必填");
    }
    // 立即拉一次，再定时
    void this.poll(emit);
    this.timer = setInterval(() => void this.poll(emit), this.opts.pollingIntervalMs);
    console.log(`[email] 轮询 IMAP ${this.opts.imapHost}:${this.opts.imapPort}/${this.opts.mailbox}`);
  }

  async reply(sessionId: string, reply: ChannelReply): Promise<void> {
    const resolve = this.pending.get(sessionId);
    if (resolve) resolve(reply);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
  }

  /** 轮询拉新邮件并派发 */
  private async poll(emit: (event: ChannelEvent) => void): Promise<void> {
    let client: LineSocket | null = null;
    try {
      client = await this.connectImap();
      await this.imapLogin(client);
      await this.imapSelect(client, this.opts.mailbox);
      const uids = await this.imapSearchUnseen(client);
      for (const uid of uids) {
        const { from, subject, body } = await this.imapFetch(client, uid);
        if (!from) continue;
        const sessionId = `email-${from}`;
        const text = subject ? `[${subject}] ${body}` : body;
        if (!text.trim()) continue;

        const scope =
          this.opts.resolveScope?.(from) ?? this.opts.defaultScope;
        const event: ChannelEvent = {
          userId: from,
          sessionId,
          text,
          from,
          receivedAt: Date.now(),
          scope,
          meta: { channel: this.name, uid, subject },
        };

        // 等 agent 回复
        const reply = await new Promise<ChannelReply>((resolve) => {
          this.pending.set(sessionId, resolve);
          emit(event);
        });
        await this.smtpSend(from, subject ? `Re: ${subject}` : "Re: your email", reply.text).catch(
          () => undefined,
        );
        this.pending.delete(sessionId);
      }
      try {
        client.write("A999 LOGOUT");
      } catch {}
    } catch {
      // 网络或解析错误，下轮重试
    } finally {
      client?.close();
    }
  }

  /** 建立 IMAP 连接，等待 greeting */
  private connectImap(): Promise<LineSocket> {
    return new Promise((resolve, reject) => {
      const client = new LineSocket({
        host: this.opts.imapHost,
        port: this.opts.imapPort,
        tls: this.opts.imapTls,
        onConnect: () => {
          // 等 OK greeting
          void client.readLine().then(() => resolve(client));
        },
        onError: (err) => reject(err),
      });
    });
  }

  /** IMAP LOGIN */
  private async imapLogin(client: LineSocket): Promise<void> {
    client.write(`A1 LOGIN ${this.opts.username} ${this.opts.password}`);
    await client.readUntil((l) => /^A1 /i.test(l));
  }

  /** IMAP SELECT mailbox */
  private async imapSelect(client: LineSocket, mailbox: string): Promise<void> {
    client.write(`A2 SELECT ${mailbox}`);
    await client.readUntil((l) => /^A2 /i.test(l));
  }

  /** IMAP SEARCH UNSEEN，返回 UID 数组 */
  private async imapSearchUnseen(client: LineSocket): Promise<string[]> {
    client.write("A3 UID SEARCH UNSEEN");
    const lines = await client.readUntil((l) => /^A3 /i.test(l));
    const searchLine = lines.find((l) => /^\* SEARCH /i.test(l));
    if (!searchLine) return [];
    const parts = searchLine.replace(/^\* SEARCH /i, "").trim().split(/\s+/);
    return parts.filter(Boolean);
  }

  /** IMAP FETCH UID，解析 From/Subject/Body（极简版） */
  private async imapFetch(
    client: LineSocket,
    uid: string,
  ): Promise<{ from: string; subject: string; body: string }> {
    client.write(`A4 UID FETCH ${uid} (BODY.PEEK[])`);
    const lines = await client.readUntil((l) => /^A4 /i.test(l), 500);
    const raw = lines.join("\r\n");

    // 极简解析：From / Subject / 文本 body
    const fromMatch = raw.match(/\r\nFrom:\s*([^<]*)(?:<([^>]+)>)?/i);
    const from = fromMatch?.[2] ?? fromMatch?.[1]?.trim() ?? "";
    const subjectMatch = raw.match(/\r\nSubject:\s*(.+?)(\r\n\S)/i);
    const subject = subjectMatch?.[1]?.trim() ?? "";

    // body = 最后一个空行之后的内容（极简，未处理 MIME multipart / base64）
    const bodyMatch = raw.match(/\r\n\r\n([\s\S]+)$/);
    let body = bodyMatch?.[1] ?? "";
    // 截掉 IMAP 末尾标记 ")" 行
    body = body.replace(/\r\n\)\r\n.*$/s, "").trim();
    return { from, subject, body };
  }

  /** 通过 SMTP 发邮件 */
  private async smtpSend(to: string, subject: string, body: string): Promise<void> {
    let client: LineSocket | null = null;
    try {
      client = await this.connectSmtp();
      await this.smtpExpect(client, "220");
      client.write(`EHLO ${this.opts.smtpHost}`);
      await this.smtpReadMultiline(client, "250");
      client.write("AUTH LOGIN");
      await this.smtpExpect(client, "334");
      client.write(Buffer.from(this.opts.username).toString("base64"));
      await this.smtpExpect(client, "334");
      client.write(Buffer.from(this.opts.password).toString("base64"));
      await this.smtpExpect(client, "235");
      client.write(`MAIL FROM:<${this.opts.username}>`);
      await this.smtpExpect(client, "250");
      client.write(`RCPT TO:<${to}>`);
      await this.smtpExpect(client, "250");
      client.write("DATA");
      await this.smtpExpect(client, "354");
      const date = new Date().toUTCString();
      const msg =
        `From: ${this.opts.username}\r\n` +
        `To: ${to}\r\n` +
        `Subject: ${subject}\r\n` +
        `Date: ${date}\r\n` +
        `Content-Type: text/plain; charset=utf-8\r\n` +
        `\r\n` +
        `${body}\r\n.`;
      client.write(msg);
      await this.smtpExpect(client, "250");
      client.write("QUIT");
    } finally {
      client?.close();
    }
  }

  /** 建立 SMTP 连接 */
  private connectSmtp(): Promise<LineSocket> {
    return new Promise((resolve, reject) => {
      const client = new LineSocket({
        host: this.opts.smtpHost,
        port: this.opts.smtpPort,
        tls: this.opts.smtpTls,
        onConnect: () => resolve(client),
        onError: (err) => reject(err),
      });
    });
  }

  /** 读取 SMTP 单行响应，验证状态码前缀 */
  private async smtpExpect(client: LineSocket, codePrefix: string): Promise<void> {
    const lines = await this.smtpReadMultiline(client, codePrefix);
    if (lines.length === 0) {
      throw new Error(`SMTP 期望 ${codePrefix}，但无响应`);
    }
  }

  /** SMTP 多行响应（形如 "250-xxx" / "250 xxx"，最后一行 "250 "） */
  private async smtpReadMultiline(
    client: LineSocket,
    codePrefix: string,
  ): Promise<string[]> {
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      const line = await client.readLine();
      lines.push(line);
      // 最后一行：状态码后是空格（不是 "-"）
      if (new RegExp(`^${codePrefix} `).test(line)) break;
      if (!new RegExp(`^${codePrefix}-`).test(line)) break;
    }
    return lines;
  }
}
