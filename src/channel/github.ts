/**
 * GitHub Channel —— 通过 webhook 接收 issue/PR/comment 事件，回复走 GitHub API
 *
 * 设计（学 OpenClaw 多渠道 + 隔离）：
 * - HTTP server 接收 GitHub webhook payload
 * - 每个 issue/PR 视为一个独立 session（sessionId = `${repo}#${issue_number}`）
 * - issue 作者 = userId
 * - 回复通过 GitHub Issues Comments API
 * - 支持 secret 校验签名（X-Hub-Signature-256）
 * - 可选轮询模式（polling: true）：定时拉 issue/PR 评论，无需公网 webhook
 *
 * 仅依赖 node:http + fetch，无 octokit 依赖（减重）。
 */

import crypto from "node:crypto";
import http from "node:http";
import type { Channel, ChannelEvent, ChannelReply, Scope } from "../core/types.js";

export interface GitHubChannelOptions {
  port?: number;
  host?: string;
  /** GitHub webhook secret（签名校验） */
  webhookSecret?: string;
  /** GitHub Personal Access Token（发评论 + 轮询拉评论用） */
  accessToken?: string;
  /** 触发动作：默认 opened/created/commented */
  triggerActions?: string[];
  /** 默认 scope（未识别用户时） */
  defaultScope?: Scope;
  /** 鉴权回调：根据 GitHub login 返回该用户 scope */
  resolveScope?: (login: string) => Scope | undefined;
  /** 启用轮询模式（默认 false，用 webhook）。轮询模式无需公网 IP */
  polling?: boolean;
  /** 轮询间隔 ms，默认 30000 */
  pollingIntervalMs?: number;
  /** 轮询目标 repo（owner/repo），可多个；轮询模式必填 */
  repos?: string[];
}

interface WebhookPayload {
  action?: string;
  issue?: {
    number: number;
    title?: string;
    body?: string;
    user?: { login: string };
    html_url?: string;
  };
  pull_request?: {
    number: number;
    title?: string;
    body?: string;
    user?: { login: string };
    html_url?: string;
  };
  comment?: {
    body?: string;
    user?: { login: string };
  };
  repository?: {
    name: string;
    full_name: string;
  };
}

export class GitHubChannel implements Channel {
  readonly name = "github";
  private server?: http.Server;
  private pending = new Map<string, (reply: ChannelReply) => void>();
  private pollingTimer?: ReturnType<typeof setInterval>;
  /** 轮询模式：每个 repo 的 issue/PR 最新评论 ID 缓存，避免重复派发 */
  private seenCommentIds = new Set<string>();
  private opts: Required<
    Omit<
      GitHubChannelOptions,
      "accessToken" | "webhookSecret" | "defaultScope" | "resolveScope" | "repos"
    >
  > & {
    accessToken: string;
    webhookSecret: string;
    defaultScope?: Scope;
    resolveScope?: (login: string) => Scope | undefined;
    repos: string[];
  };

  constructor(opts: GitHubChannelOptions = {}) {
    this.opts = {
      port: opts.port ?? 8788,
      host: opts.host ?? "0.0.0.0",
      triggerActions: opts.triggerActions ?? ["opened", "created", "commented"],
      accessToken: opts.accessToken ?? "",
      webhookSecret: opts.webhookSecret ?? "",
      defaultScope: opts.defaultScope,
      resolveScope: opts.resolveScope,
      polling: opts.polling ?? false,
      pollingIntervalMs: opts.pollingIntervalMs ?? 30_000,
      repos: opts.repos ?? [],
    };
  }

  async start(emit: (event: ChannelEvent) => void): Promise<void> {
    if (this.opts.polling) {
      await this.startPolling(emit);
      return;
    }
    await this.startWebhook(emit);
  }

  /** webhook 模式：HTTP server 接收 GitHub 事件 */
  private async startWebhook(emit: (event: ChannelEvent) => void): Promise<void> {
    this.server = http.createServer(async (req, res) => {
      if (req.method !== "POST" || !req.url?.startsWith("/github/webhook")) {
        res.writeHead(404).end('{"error":"not found"}');
        return;
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks);
      const sig = req.headers["x-hub-signature-256"] as string | undefined;
      const event = req.headers["x-github-event"] as string | undefined;

      // 签名校验
      if (this.opts.webhookSecret) {
        if (!sig || !this.verifySignature(raw, this.opts.webhookSecret, sig)) {
          res.writeHead(401).end('{"error":"bad signature"}');
          return;
        }
      }

      let payload: WebhookPayload;
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        res.writeHead(400).end('{"error":"invalid json"}');
        return;
      }

      // 解析事件
      const parsed = this.parseEvent(event ?? "issue", payload);
      if (!parsed) {
        res.writeHead(200).end('{"ok":"ignored"}');
        return;
      }

      const scope =
        (this.opts.resolveScope?.(parsed.userId) ?? this.opts.defaultScope);
      const channelEvent: ChannelEvent = {
        userId: parsed.userId,
        sessionId: parsed.sessionId,
        text: parsed.text,
        from: parsed.userId,
        receivedAt: Date.now(),
        scope,
        meta: { repo: parsed.repo, number: parsed.number, event },
      };

      // 等待 agent 回复
      const reply = await new Promise<ChannelReply>((resolve) => {
        this.pending.set(parsed.sessionId, resolve);
        emit(channelEvent);
      });

      // 发评论
      if (this.opts.accessToken) {
        await this.postComment(parsed.repo, parsed.number, reply.text).catch(() => undefined);
      }
      this.pending.delete(parsed.sessionId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, replied: !!this.opts.accessToken }));
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.opts.port, this.opts.host, () => resolve());
    });
  }

  /** 轮询模式：定时拉每个 repo 的最新 issue/PR 评论，无需公网 webhook */
  private async startPolling(emit: (event: ChannelEvent) => void): Promise<void> {
    if (!this.opts.accessToken) {
      throw new Error("GitHub 轮询模式需要 accessToken");
    }
    if (this.opts.repos.length === 0) {
      throw new Error("GitHub 轮询模式需要至少一个 repo（owner/repo）");
    }

    const poll = async () => {
      for (const repo of this.opts.repos) {
        await this.pollRepoComments(repo, emit).catch(() => undefined);
      }
    };
    // 立即跑一次，再定时
    void poll();
    this.pollingTimer = setInterval(poll, this.opts.pollingIntervalMs);
    console.log(`[github] 轮询模式：${this.opts.repos.join(", ")}（每 ${this.opts.pollingIntervalMs}ms）`);
  }

  /** 拉某个 repo 最近 issue 评论 + PR 评论（issue comments API 兼容 PR 评论） */
  private async pollRepoComments(repo: string, emit: (event: ChannelEvent) => void): Promise<void> {
    // 拉 issue comments（GitHub Issues Comments API 覆盖 issue + PR 评论）
    const url = `https://api.github.com/repos/${repo}/issues/comments?sort=created&direction=desc&per_page=10`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.opts.accessToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) return;
    const comments = (await res.json()) as Array<{
      id?: number;
      body?: string;
      user?: { login?: string };
      issue_url?: string;
      created_at?: string;
    }>;
    if (!Array.isArray(comments)) return;

    // 按时间正序处理（先旧后新）
    for (const c of comments.reverse()) {
      if (!c.id || !c.body || !c.user?.login) continue;
      const key = `${repo}#${c.id}`;
      if (this.seenCommentIds.has(key)) continue;
      this.seenCommentIds.add(key);
      // 缓存上限 5000 条，防内存膨胀
      if (this.seenCommentIds.size > 5000) {
        const first = this.seenCommentIds.values().next().value;
        if (first) this.seenCommentIds.delete(first);
      }

      // 从 issue_url 解析 number
      const match = c.issue_url?.match(/\/issues\/(\d+)$/);
      if (!match) continue;
      const number = parseInt(match[1], 10);
      const sessionId = `${repo}#issue-${number}`;
      const userId = c.user.login;
      const scope = this.opts.resolveScope?.(userId) ?? this.opts.defaultScope;
      const event: ChannelEvent = {
        userId,
        sessionId,
        text: c.body,
        from: userId,
        receivedAt: c.created_at ? Date.parse(c.created_at) : Date.now(),
        scope,
        meta: { repo, number, event: "issue_comment", commentId: c.id },
      };

      // 等 agent 回复后发评论
      const reply = await new Promise<ChannelReply>((resolve) => {
        this.pending.set(sessionId, resolve);
        emit(event);
      });
      await this.postComment(repo, number, reply.text).catch(() => undefined);
      this.pending.delete(sessionId);
    }
  }

  async reply(sessionId: string, reply: ChannelReply): Promise<void> {
    const resolve = this.pending.get(sessionId);
    if (resolve) resolve(reply);
  }

  async stop(): Promise<void> {
    if (this.pollingTimer) clearInterval(this.pollingTimer);
    if (this.server) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    }
  }

  private parseEvent(
    event: string,
    payload: WebhookPayload,
  ): { userId: string; sessionId: string; text: string; repo: string; number: number } | null {
    const action = payload.action;
    if (action && !this.opts.triggerActions.includes(action)) return null;

    const repo = payload.repository?.full_name ?? "unknown/repo";
    const isPR = event === "pull_request" || !!payload.pull_request;
    const item = payload.pull_request ?? payload.issue;
    if (!item || !item.number) return null;

    const number = item.number;
    const userId = item.user?.login ?? payload.comment?.user?.login ?? "anonymous";
    const sessionId = `${repo}#${isPR ? "pr" : "issue"}-${number}`;
    const title = item.title ?? "";
    const body = payload.comment?.body ?? item.body ?? "";
    const text = body || title;

    if (!text.trim()) return null;
    return { userId, sessionId, text: `${title ? `[${title}] ` : ""}${text}`, repo, number };
  }

  private async postComment(repo: string, number: number, body: string): Promise<void> {
    const url = `https://api.github.com/repos/${repo}/issues/${number}/comments`;
    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.accessToken}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ body }),
    });
  }

  private verifySignature(raw: Buffer, secret: string, sig: string): boolean {
    const expected = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
    // 长度不同直接 false，避免 timing-safe 报错
    if (expected.length !== sig.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  }
}
