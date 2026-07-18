/**
 * Telegram Channel
 *
 * 两种接入模式：
 * - webhook 模式（默认）：Telegram POST update 到 /telegram/webhook
 *   签名：X-Telegram-Bot-Api-Secret-Token 比对 botToken 的 sha256
 * - 轮询模式（polling: true）：主动 getUpdates，无需公网 IP
 *
 * 回复：POST /bot{token}/sendMessage
 *
 * 文档：https://core.telegram.org/bots/api
 */

import http from "node:http";
import { WebhookChannel, type ParsedEvent, type WebhookChannelOptions } from "./webhook.js";
import type { ChannelEvent } from "../core/types.js";

export interface TelegramChannelOptions extends WebhookChannelOptions {
  path?: string;
  /** Bot Token，如 123456:ABC-DEF */
  botToken: string;
  /** 启用轮询模式（默认 false，用 webhook） */
  polling?: boolean;
  /** 轮询间隔 ms */
  pollingIntervalMs?: number;
  /** webhook 模式的 secret token（setWebhook 时设置） */
  webhookSecret?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    chat?: { id: number; type: string };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
  };
}

export class TelegramChannel extends WebhookChannel {
  readonly name = "telegram";
  private readonly tgOpts: Required<Omit<TelegramChannelOptions, "path" | "port" | "host" | "defaultScope" | "resolveScope" | "polling" | "pollingIntervalMs">> & {
    polling: boolean;
    pollingIntervalMs: number;
  };
  private pollingTimer?: ReturnType<typeof setInterval>;
  private lastUpdateId = 0;

  constructor(opts: TelegramChannelOptions) {
    super({ ...opts, path: opts.path ?? "/telegram/webhook" });
    this.tgOpts = {
      botToken: opts.botToken,
      webhookSecret: opts.webhookSecret ?? "",
      polling: opts.polling ?? false,
      pollingIntervalMs: opts.pollingIntervalMs ?? 2000,
    };
  }

  protected async verify(
    headers: http.IncomingHttpHeaders,
    _raw: Buffer,
  ): Promise<{ ok: boolean; ackBody?: string; ackHeaders?: Record<string, string> }> {
    if (this.tgOpts.webhookSecret) {
      const token = headers["x-telegram-bot-api-secret-token"] as string | undefined;
      if (!token || !this.safeEqual(token, this.tgOpts.webhookSecret)) {
        return { ok: false };
      }
    }
    return { ok: true };
  }

  protected async parse(
    raw: Buffer,
    _headers: http.IncomingHttpHeaders,
  ): Promise<ParsedEvent | null> {
    let update: TelegramUpdate;
    try {
      update = JSON.parse(raw.toString("utf8"));
    } catch {
      return null;
    }
    return this.parseUpdate(update);
  }

  protected async sendReply(target: ParsedEvent, text: string): Promise<void> {
    const chatId = target.replyTarget.chat_id as number | undefined;
    if (chatId === undefined) return;
    const url = `https://api.telegram.org/bot${this.tgOpts.botToken}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        reply_to_message_id: target.replyTarget.message_id ?? undefined,
      }),
    });
  }

  /** 轮询模式：override start，不启 HTTP server */
  async start(emit: (event: ChannelEvent) => void): Promise<void> {
    if (this.tgOpts.polling) {
      await this.startPolling(emit);
      return;
    }
    await super.start(emit);
  }

  private async startPolling(emit: (event: ChannelEvent) => void): Promise<void> {
    const poll = async () => {
      try {
        const url = `https://api.telegram.org/bot${this.tgOpts.botToken}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=30`;
        const res = await fetch(url);
        const data = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };
        if (!data.ok || !data.result) return;
        for (const update of data.result) {
          this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
          const parsed = this.parseUpdate(update);
          if (!parsed) continue;
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
          emit(event);
          const reply = await this.waitForReply(parsed.sessionId);
          await this.sendReply(parsed, reply.text).catch(() => undefined);
        }
      } catch {
        // 网络错误，下轮重试
      }
    };
    // 立即跑一次，再定时
    void poll();
    this.pollingTimer = setInterval(poll, this.tgOpts.pollingIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.pollingTimer) clearInterval(this.pollingTimer);
    if (!this.tgOpts.polling) {
      await super.stop();
    }
  }

  private parseUpdate(update: TelegramUpdate): ParsedEvent | null {
    const msg = update.message;
    if (!msg?.text || !msg.chat || !msg.from) return null;
    const userId = String(msg.from.id);
    const username = msg.from.username ?? msg.from.first_name ?? userId;
    return {
      userId,
      sessionId: String(msg.chat.id),
      text: msg.text,
      from: username,
      replyTarget: { chat_id: msg.chat.id, message_id: msg.message_id },
    };
  }
}
