/**
 * MCP Registry —— MCP 客户端注册表
 *
 * 设计（对标 MCP 标准 + Claude Code 的 MCP 多 server 管理）：
 * - 连接外部 MCP server（stdio / SSE 两种传输）
 * - 自动发现远端 tools，聚合为统一注册表
 * - 继承 EventEmitter：tools_changed / disconnected / error 事件
 * - 零依赖：用 node:child_process + fetch + 手写 JSON-RPC
 *
 * 行预算：~180 行
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

export interface MCPServerConfig {
  name: string;
  command?: string; // stdio transport
  args?: string[];
  url?: string; // SSE transport
  env?: Record<string, string>;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export class MCPRegistry extends EventEmitter {
  private servers: Map<string, { config: MCPServerConfig; process?: ChildProcess; tools: MCPTool[] }> = new Map();

  async connect(config: MCPServerConfig): Promise<void> {
    if (config.command) {
      const proc = spawn(config.command, config.args ?? [], {
        env: { ...process.env, ...config.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      // Initialize handshake
      this.send(proc, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } });
      // List tools
      this.send(proc, { jsonrpc: "2.0", id: 2, method: "tools/list", params: null });
      // Store
      this.servers.set(config.name, { config, process: proc, tools: [] });
      // Listen for responses
      let buffer = "";
      proc.stdout?.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.result?.tools) {
              const entry = this.servers.get(config.name);
              if (entry) entry.tools = msg.result.tools;
              this.emit("tools_changed", config.name, msg.result.tools);
            }
          } catch {
            /* ignore parse errors */
          }
        }
      });
      proc.on("error", (err) => this.emit("error", config.name, err));
      proc.on("exit", () => this.emit("disconnected", config.name));
    } else if (config.url) {
      // SSE transport — just store config, connect on demand
      try {
        const res = await fetch(config.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } }),
        });
        await res.json();
        // List tools
        const toolsRes = await fetch(config.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: null }),
        });
        const toolsData = (await toolsRes.json()) as { result?: { tools?: MCPTool[] } };
        this.servers.set(config.name, { config, tools: toolsData.result?.tools ?? [] });
        this.emit("tools_changed", config.name, toolsData.result?.tools ?? []);
      } catch (err) {
        this.emit("error", config.name, err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private send(proc: ChildProcess, msg: Record<string, unknown>): void {
    proc.stdin?.write(JSON.stringify(msg) + "\n");
  }

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const entry = this.servers.get(serverName);
    if (!entry) throw new Error(`MCP server not found: ${serverName}`);
    if (entry.process) {
      // stdio transport
      return new Promise((resolve, reject) => {
        const id = Date.now();
        const handler = (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.id === id) {
              entry.process?.stdout?.off("data", handler);
              if (msg.error) reject(new Error(msg.error.message));
              else resolve(msg.result);
            }
          } catch {
            /* ignore */
          }
        };
        entry.process?.stdout?.on("data", handler);
        this.send(entry.process!, { jsonrpc: "2.0", id, method: "tools/call", params: { name: toolName, arguments: args } });
        setTimeout(() => reject(new Error("MCP tool call timeout")), 30000);
      });
    } else if (entry.config.url) {
      const res = await fetch(entry.config.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: toolName, arguments: args } }),
      });
      const data = (await res.json()) as { error?: { message: string }; result?: unknown };
      if (data.error) throw new Error(data.error.message);
      return data.result;
    }
    throw new Error(`MCP server ${serverName} has no transport`);
  }

  listServers(): string[] {
    return Array.from(this.servers.keys());
  }

  listTools(serverName: string): MCPTool[] {
    return this.servers.get(serverName)?.tools ?? [];
  }

  listAllTools(): { server: string; tool: MCPTool }[] {
    const result: { server: string; tool: MCPTool }[] = [];
    for (const [name, entry] of this.servers) {
      for (const tool of entry.tools) {
        result.push({ server: name, tool });
      }
    }
    return result;
  }

  async disconnect(serverName: string): Promise<void> {
    const entry = this.servers.get(serverName);
    if (entry?.process) {
      entry.process.kill();
    }
    this.servers.delete(serverName);
    this.emit("disconnected", serverName);
  }

  async disconnectAll(): Promise<void> {
    for (const name of this.servers.keys()) {
      await this.disconnect(name);
    }
  }
}
