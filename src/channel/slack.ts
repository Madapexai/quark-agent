/**
 * Slack Channel — Bolt-style Event adapter
 *
 * Uses Slack's Events API via HTTP POST (slash command + event subscription).
 * Zero external deps: handles verification + event parsing natively.
 *
 * Env:
 *   SLACK_BOT_TOKEN       — xoxb-... bot token
 *   SLACK_SIGNING_SECRET  — signing secret for request verification
 *   SLACK_CHANNEL_ID      — (optional) restrict to a channel
 *
 * Usage:
 *   import { SlackChannel } from "quark-agent/channel";
 *   const channel = new SlackChannel({ port: 3000 });
 *   runtime.register(channel, handler);
 *   await runtime.start();
 *
 * Setup in Slack:
 *   1. Create app at https://api.slack.com/apps
 *   2. Enable Event Subscriptions → Request URL: https://your-server/slack/events
 *   3. Subscribe to: message.channels, message.groups, message.im
 *   4. Install to workspace → get Bot Token + Signing Secret
 *
 * Reference: Slack Bolt uses the same request verification + event dispatch
 * pattern (see @slack/bolt — App, ExpressReceiver). This implementation
 * inlines the core logic without the framework dependency.
 */

import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Channel, ChannelEvent, ChannelReply } from "../core/types.js";

// ============================================================================
// Slack request verification (signing secret)
// ============================================================================

function verifySlackRequest(
  signingSecret: string,
  body: string,
  timestamp: string,
  signature: string,
): boolean {
  const sigBase = `v0:${timestamp}:${body}`;
  const hash = createHmac("sha256", signingSecret).update(sigBase).digest("hex");
  const expected = `v0=${hash}`;
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ============================================================================
// Minimal Slack REST helper
// ============================================================================

async function slackApi(token: string, method: string, endpoint: string, body?: unknown): Promise<any> {
  const res = await fetch(`https://slack.com/api/${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
  return data;
}

// ============================================================================
// SlackChannel
// ============================================================================

export interface SlackChannelOptions {
  token?: string;
  signingSecret?: string;
  port?: number;
  channelId?: string;
  /** Path for event subscription endpoint */
  path?: string;
}

export class SlackChannel implements Channel {
  readonly name = "slack";
  private server?: http.Server;
  private token: string;
  private signingSecret: string;
  private port: number;
  private channelId: string;
  private path: string;

  constructor(opts: SlackChannelOptions = {}) {
    this.token = opts.token ?? process.env.SLACK_BOT_TOKEN ?? "";
    this.signingSecret = opts.signingSecret ?? process.env.SLACK_SIGNING_SECRET ?? "";
    this.port = opts.port ?? parseInt(process.env.SLACK_PORT ?? "3000", 10);
    this.channelId = opts.channelId ?? process.env.SLACK_CHANNEL_ID ?? "";
    this.path = opts.path ?? "/slack/events";
  }

  async start(emit: (event: ChannelEvent) => void): Promise<void> {
    if (!this.token) {
      throw new Error("SLACK_BOT_TOKEN is required. Get one at https://api.slack.com/apps");
    }
    if (!this.signingSecret) {
      throw new Error("SLACK_SIGNING_SECRET is required for request verification");
    }

    this.server = http.createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== this.path) {
        res.writeHead(404).end("not found");
        return;
      }

      // Read body
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const rawBody = Buffer.concat(chunks).toString("utf8");

      // Verify signature
      const timestamp = req.headers["x-slack-request-timestamp"] as string;
      const signature = req.headers["x-slack-signature"] as string;
      if (!timestamp || !signature) {
        res.writeHead(401).end("missing signature headers");
        return;
      }

      // Reject replay attacks (>5 min old)
      if (Math.abs(Date.now() / 1000 - parseInt(timestamp, 10)) > 300) {
        res.writeHead(401).end("stale request");
        return;
      }

      if (!verifySlackRequest(this.signingSecret, rawBody, timestamp, signature)) {
        res.writeHead(401).end("invalid signature");
        return;
      }

      let payload: any;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        res.writeHead(400).end("invalid json");
        return;
      }

      // URL verification challenge (Slack sends this when you configure the Request URL)
      if (payload.type === "url_verification") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ challenge: payload.challenge }));
        return;
      }

      // Event callback
      if (payload.type === "event_callback") {
        const event = payload.event;

        // Only handle message events
        if (event.type === "message" && !event.bot_id && !event.subtype) {
          // Restrict to specific channel if configured
          if (this.channelId && event.channel !== this.channelId) {
            res.writeHead(200).end("");
            return;
          }

          const sessionId = `slack-${event.channel}`;
          emit({
            userId: `slack-${event.user}`,
            sessionId,
            text: event.text,
            from: event.user,
            receivedAt: Date.now(),
            meta: { channelId: event.channel, threadTs: event.thread_ts },
          });
        }

        res.writeHead(200).end("");
        return;
      }

      res.writeHead(200).end("");
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, "0.0.0.0", () => resolve());
    });

    console.log(`[slack] Event endpoint: http://0.0.0.0:${this.port}${this.path}`);
  }

  async reply(sessionId: string, reply: ChannelReply): Promise<void> {
    const channelId = sessionId.replace("slack-", "");
    await slackApi(this.token, "POST", "chat.postMessage", {
      channel: channelId,
      text: reply.text?.slice(0, 40000), // Slack limit
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}
