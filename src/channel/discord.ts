/**
 * Discord Channel — Bot Gateway adapter
 *
 * Uses Discord's Gateway API (WebSocket) to receive messages and reply.
 * Zero external deps: uses the built-in REST + Gateway via fetch + ws.
 *
 * Env:
 *   DISCORD_BOT_TOKEN   — bot token from https://discord.com/developers/applications
 *   DISCORD_CHANNEL_ID  — (optional) restrict to a specific channel
 *
 * Usage:
 *   import { DiscordChannel } from "quark-agent/channel";
 *   const channel = new DiscordChannel();
 *   runtime.register(channel, handler);
 *   await runtime.start();
 *
 * Reference: Codex CLI uses a similar lightweight Gateway pattern
 * (see openai/codex — no discord.js dependency, raw WebSocket).
 */

import { WebSocket } from "undici" // Node 18+ has ws; fallback to native
  .catch ? undefined : undefined; // type-only import hint

import type { Channel, ChannelEvent, ChannelReply } from "../core/types.js";

// ============================================================================
// Minimal Discord REST helper (zero deps)
// ============================================================================

async function discordRest(token: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Discord API ${res.status}: ${err}`);
  }
  return res.status === 204 ? null : res.json();
}

// ============================================================================
// Discord Gateway (WebSocket) — lightweight, no discord.js
// ============================================================================

export interface DiscordChannelOptions {
  token?: string;
  /** Restrict to this channel ID; if empty, respond in all channels */
  channelId?: string;
  /** Intent bits: default = GuildMessages + MessageContent + DirectMessages */
  intents?: number;
}

// Discord Gateway intent flags
const INTENT_GUILD_MESSAGES = 1 << 9;    // 512
const INTENT_DIRECT_MESSAGES = 1 << 12;  // 4096
const INTENT_MESSAGE_CONTENT = 1 << 15;  // 32768

const DEFAULT_INTENTS = INTENT_GUILD_MESSAGES | INTENT_DIRECT_MESSAGES | INTENT_MESSAGE_CONTENT;

export class DiscordChannel implements Channel {
  readonly name = "discord";
  private ws?: any; // WebSocket instance
  private heartbeatInterval?: ReturnType<typeof setInterval>;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private token: string;
  private channelId: string;
  private intents: number;
  private pendingReplies = new Map<string, (reply: ChannelReply) => void>();

  constructor(opts: DiscordChannelOptions = {}) {
    this.token = opts.token ?? process.env.DISCORD_BOT_TOKEN ?? "";
    this.channelId = opts.channelId ?? process.env.DISCORD_CHANNEL_ID ?? "";
    this.intents = opts.intents ?? DEFAULT_INTENTS;
  }

  async start(emit: (event: ChannelEvent) => void): Promise<void> {
    if (!this.token) {
      throw new Error("DISCORD_BOT_TOKEN is required. Get one at https://discord.com/developers/applications");
    }

    // Get Gateway URL
    const { url } = await discordRest(this.token, "GET", "/gateway");
    const wsUrl = `${url}?v=10&encoding=json`;

    this.connect(wsUrl, emit);
  }

  private connect(wsUrl: string, emit: (event: ChannelEvent) => void): void {
    // Use Node.js built-in WebSocket (Node 22+) or fall back to ws package
    try {
      // @ts-ignore - Node 22+ has built-in WebSocket
      this.ws = new WebSocket(wsUrl);
    } catch {
      // Fallback: try importing 'ws' package
      try {
        const WS = require("ws");
        this.ws = new WS(wsUrl);
      } catch {
        throw new Error("No WebSocket available. Node 22+ (built-in) or 'npm install ws' required.");
      }
    }

    this.ws.on("message", (data: Buffer) => {
      try {
        const payload = JSON.parse(data.toString());
        this.handleGatewayEvent(payload, wsUrl, emit);
      } catch {}
    });

    this.ws.on("close", () => {
      if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    });

    this.ws.on("error", (err: Error) => {
      console.error("[discord] WebSocket error:", err.message);
    });
  }

  private handleGatewayEvent(
    payload: any,
    wsUrl: string,
    emit: (event: ChannelEvent) => void,
  ): void {
    const { op, t, d, s } = payload;
    if (s) this.seq = s;

    // Op 10: Hello — start heartbeating
    if (op === 10) {
      const interval = d.heartbeat_interval;
      this.heartbeatInterval = setInterval(() => {
        this.send({ op: 1, d: this.seq });
      }, interval);
      // Identify
      this.send({
        op: 2,
        d: {
          token: this.token,
          intents: this.intents,
          properties: { os: "linux", browser: "quark-agent", device: "quark-agent" },
        },
      });
    }

    // Op 11: Heartbeat ACK
    if (op === 11) return;

    // Op 0: Dispatch
    if (op === 0) {
      // Ready — capture session info for resume
      if (t === "READY") {
        this.sessionId = d.session_id;
        this.resumeUrl = d.resume_gateway_url;
        console.log(`[discord] Connected as ${d.user.username}#${d.user.discriminator}`);
      }

      // MESSAGE_CREATE — the main event we care about
      if (t === "MESSAGE_CREATE") {
        const msg = d;
        // Ignore our own messages
        if (msg.author.bot) return;
        // Restrict to specific channel if configured
        if (this.channelId && msg.channel_id !== this.channelId) return;

        const sessionId = `discord-${msg.channel_id}`;
        emit({
          userId: `discord-${msg.author.id}`,
          sessionId,
          text: msg.content,
          from: msg.author.username,
          receivedAt: Date.now(),
          meta: { channelId: msg.channel_id, messageId: msg.id },
        });
      }
    }
  }

  private send(data: any): void {
    if (this.ws?.readyState === 1) { // OPEN
      this.ws.send(JSON.stringify(data));
    }
  }

  async reply(sessionId: string, reply: ChannelReply): Promise<void> {
    // Extract Discord channel ID from sessionId
    const channelId = sessionId.replace("discord-", "");
    await discordRest(this.token, "POST", `/channels/${channelId}/messages`, {
      content: reply.text?.slice(0, 2000), // Discord limit
    });
  }

  async stop(): Promise<void> {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.ws?.close?.();
  }
}
