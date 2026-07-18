/**
 * MCP Client —— Model Context Protocol 客户端
 *
 * 设计（对标 MCP 标准 + Claude Code 的 MCP 接入）：
 * - 两种传输：stdio（spawn 子进程）+ SSE（HTTP）
 * - 自动发现远端 tools / resources，注册为 micro-agent 的 Tool
 * - 作为 Plugin 装载，卸载时关闭连接
 * - 零依赖：用 node:child_process + fetch + 手写 JSON-RPC
 *
 * 行预算：~200 行
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { Plugin, Tool, ToolContext, ToolSchema } from "../core/types.js";

export type McpServerConfig =
  | { cmd: string; args?: string[]; env?: Record<string, string> }
  | { url: string };

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** MCP 连接抽象：stdio 与 SSE 各自实现 */
interface McpConnection {
  request(method: string, params?: unknown): Promise<unknown>;
  close(): Promise<void>;
}

// ============================================================================
// stdio 传输
// ============================================================================

class StdioConnection implements McpConnection {
  private proc: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buf = "";

  constructor(cfg: { cmd: string; args?: string[]; env?: Record<string, string> }) {
    this.proc = spawn(cfg.cmd, cfg.args ?? [], {
      env: { ...process.env, ...cfg.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr?.on("data", () => { /* 忽略 stderr */ });
    this.proc.on("error", (e) => {
      for (const { reject } of this.pending.values()) reject(e);
      this.pending.clear();
    });
  }

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } catch {
        // 跳过非 JSON
      }
    }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin?.write(JSON.stringify(req) + "\n");
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request ${method} timeout`));
        }
      }, 30_000);
    });
  }

  async close(): Promise<void> {
    this.proc.kill();
  }
}

// ============================================================================
// SSE 传输
// ============================================================================

class SseConnection implements McpConnection {
  private nextId = 1;
  private endpoint: string | null = null;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private abortCtl = new AbortController();

  constructor(private readonly url: string) {}

  async init(): Promise<void> {
    // 先建立 SSE 流，接收 endpoint 事件
    const res = await fetch(this.url, { headers: { Accept: "text/event-stream" }, signal: this.abortCtl.signal });
    if (!res.ok || !res.body) throw new Error(`SSE connect ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    // 异步读 SSE
    (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          this.handleSseBlock(block);
        }
      }
    })().catch(() => undefined);
    // 等待 endpoint
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (this.endpoint) { clearInterval(check); resolve(); }
      }, 100);
      setTimeout(() => { clearInterval(check); resolve(); }, 5000);
    });
  }

  private handleSseBlock(block: string): void {
    const lines = block.split("\n");
    let event = "message";
    let data = "";
    for (const ln of lines) {
      if (ln.startsWith("event:")) event = ln.slice(6).trim();
      else if (ln.startsWith("data:")) data += ln.slice(5).trim();
    }
    if (event === "endpoint") {
      this.endpoint = data;
      return;
    }
    if (event === "message" && data) {
      try {
        const msg = JSON.parse(data) as JsonRpcResponse;
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } catch {
        // 跳过
      }
    }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (!this.endpoint) throw new Error("SSE not initialized");
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const base = new URL(this.url);
    const postUrl = new URL(this.endpoint, base);
    await fetch(postUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal: this.abortCtl.signal,
    }).catch((e) => {
      const p = this.pending.get(id);
      if (p) { this.pending.delete(id); p.reject(e as Error); }
    });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request ${method} timeout`));
        }
      }, 30_000);
    });
  }

  async close(): Promise<void> {
    this.abortCtl.abort();
  }
}

// ============================================================================
// MCP Plugin：把 MCP server 的 tools 注册为 micro-agent Tool
// ============================================================================

export function mcpPlugin(server: McpServerConfig, prefix?: string): Plugin {
  return {
    name: `mcp:${prefix ?? "default"}`,
    async install(ctx) {
      const conn: McpConnection = "cmd" in server ? new StdioConnection(server) : new SseConnection(server.url);
      if ("url" in server) await (conn as SseConnection).init();

      const result = (await conn.request("tools/list")) as { tools?: McpToolDef[] };
      const tools = result.tools ?? [];
      const registered: string[] = [];
      for (const def of tools) {
        const name = prefix ? `${prefix}.${def.name}` : def.name;
        const tool: Tool = {
          name,
          description: def.description ?? `MCP tool ${def.name}`,
          schema: {
            type: "function",
            function: { name, description: def.description ?? "", parameters: def.inputSchema },
          } as ToolSchema,
          async execute(args: Record<string, unknown>, _tc: ToolContext): Promise<string> {
            const r = (await conn.request("tools/call", { name: def.name, arguments: args })) as {
              content?: Array<{ type: string; text?: string }>;
              isError?: boolean;
            };
            const text = r.content?.map((c) => c.text ?? "").join("") ?? "";
            return r.isError ? `[error] ${text}` : text;
          },
        };
        ctx.registerTool(tool);
        registered.push(name);
      }

      return async () => {
        for (const n of registered) ctx.unregisterTool(n);
        await conn.close();
      };
    },
  };
}
