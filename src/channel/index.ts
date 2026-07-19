/**
 * Channel trait 实现：CLI, HTTP, Discord, Slack
 *
 * 设计（调研 §四 ZeroClaw trait 驱动）：
 * - 单一 Channel 接口，加新通道只需实现 start/reply/stop
 * - CLI：readline 流式
 * - HTTP：单端点 POST，无框架依赖（减重）
 * - Discord：Gateway WebSocket (zero discord.js dependency)
 * - Slack：Events API HTTP POST (zero @slack/bolt dependency)
 */

export { DiscordChannel } from "./discord.js";
export { SlackChannel } from "./slack.js";

import readline from "node:readline";
import http from "node:http";
import type { Channel, ChannelEvent, ChannelReply } from "../core/types.js";

// ============================================================================
// CLI 通道
// ============================================================================

export interface CliChannelOptions {
  prompt?: string;
  /** 输入流，默认 process.stdin */
  input?: NodeJS.ReadableStream;
  /** 输出流，默认 process.stdout */
  output?: NodeJS.WritableStream;
  /** 本地用户 ID */
  userId?: string;
  /** 会话 ID（不传则每次自增） */
  sessionId?: string;
}

export class CliChannel implements Channel {
  readonly name = "cli";
  private rl?: readline.Interface;
  private opts: Required<CliChannelOptions>;

  constructor(opts: CliChannelOptions = {}) {
    this.opts = {
      prompt: opts.prompt ?? "you> ",
      input: opts.input ?? process.stdin,
      output: opts.output ?? process.stdout,
      userId: opts.userId ?? "cli-user",
      sessionId: opts.sessionId ?? "cli-session",
    };
  }

  async start(emit: (event: ChannelEvent) => void): Promise<void> {
    this.rl = readline.createInterface({
      input: this.opts.input,
      output: this.opts.output,
      prompt: this.opts.prompt,
    });
    this.rl.prompt();
    this.rl.on("line", (line: string) => {
      const text = line.trim();
      if (!text) {
        this.rl?.prompt();
        return;
      }
      if (text === "/exit" || text === "/quit") {
        this.rl?.close();
        return;
      }
      emit({
        userId: this.opts.userId,
        sessionId: this.opts.sessionId,
        text,
        from: this.opts.userId,
        receivedAt: Date.now(),
      });
    });
    this.rl.on("close", () => {
      // 流关闭即停止
    });
  }

  async reply(_sessionId: string, reply: ChannelReply): Promise<void> {
    this.opts.output.write(`agent> ${reply.text}\n`);
    this.rl?.prompt();
  }

  async stop(): Promise<void> {
    this.rl?.close();
  }
}

// ============================================================================
// HTTP 通道（单端点，JSON）
// ============================================================================

export interface HttpChannelOptions {
  port?: number;
  host?: string;
  /** 鉴权 token，请求头 X-Micro-Token 必须匹配 */
  authToken?: string;
}

export class HttpChannel implements Channel {
  readonly name = "http";
  private server?: http.Server;
  private pending = new Map<string, (reply: ChannelReply) => void>();
  private opts: Required<HttpChannelOptions>;

  constructor(opts: HttpChannelOptions = {}) {
    this.opts = {
      port: opts.port ?? 8787,
      host: opts.host ?? "127.0.0.1",
      authToken: opts.authToken ?? "",
    };
  }

  async start(emit: (event: ChannelEvent) => void): Promise<void> {
    this.server = http.createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/chat") {
        res.writeHead(404).end('{"error":"not found"}');
        return;
      }
      if (this.opts.authToken) {
        const token = req.headers["x-micro-token"];
        if (token !== this.opts.authToken) {
          res.writeHead(401).end('{"error":"unauthorized"}');
          return;
        }
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: { text?: string; from?: string; userId?: string; sessionId?: string };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400).end('{"error":"invalid json"}');
        return;
      }
      if (!body.text) {
        res.writeHead(400).end('{"error":"missing text"}');
        return;
      }
      const sessionId = body.sessionId ?? `http-${Date.now()}`;
      const event: ChannelEvent = {
        userId: body.userId ?? body.from ?? "anonymous",
        sessionId,
        text: body.text,
        from: body.from ?? body.userId ?? "anonymous",
        receivedAt: Date.now(),
      };

      // 等待 agent 回复
      const reply = await new Promise<ChannelReply>((resolve) => {
        this.pending.set(sessionId, resolve);
        emit(event);
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply));
      this.pending.delete(sessionId);
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(this.opts.port, this.opts.host, () => resolve());
    });
  }

  async reply(sessionId: string, reply: ChannelReply): Promise<void> {
    const resolve = this.pending.get(sessionId);
    if (resolve) {
      resolve(reply);
    }
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}
