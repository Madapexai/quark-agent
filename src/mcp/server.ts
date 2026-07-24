/**
 * MCP Server —— Model Context Protocol 服务端
 *
 * 设计（对标 MCP 标准）：
 * - 把 quark-agent 的 tools 通过 MCP 协议暴露给外部 client
 * - 两种传输：stdio（JSON-RPC over stdin/stdout）+ SSE（HTTP）
 * - 零依赖：用 node:http + node:readline + 手写 JSON-RPC
 *
 * 行预算：~200 行
 */

import { createServer } from "node:http";
import * as readline from "node:readline";

// MCP protocol types
export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPResource {
  uri: string;
  name: string;
  mimeType?: string;
}

export interface MCPPrompt {
  name: string;
  description: string;
  arguments: { name: string; description: string; required: boolean }[];
}

export class MCPServer {
  private tools: Map<string, MCPTool> = new Map();
  private resources: Map<string, MCPResource> = new Map();
  private prompts: Map<string, MCPPrompt> = new Map();
  private toolHandlers: Map<string, (args: Record<string, unknown>) => Promise<unknown>> = new Map();

  registerTool(
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    handler: (args: Record<string, unknown>) => Promise<unknown>,
  ): void {
    this.tools.set(name, { name, description, inputSchema });
    this.toolHandlers.set(name, handler);
  }

  registerResource(uri: string, name: string, mimeType?: string): void {
    this.resources.set(uri, { uri, name, mimeType });
  }

  registerPrompt(
    name: string,
    description: string,
    args: { name: string; description: string; required: boolean }[],
  ): void {
    this.prompts.set(name, { name, description, arguments: args });
  }

  // Handle JSON-RPC 2.0 request
  async handleRequest(method: string, params: Record<string, unknown> | null): Promise<unknown> {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: { listChanged: true },
            resources: { listChanged: true },
            prompts: { listChanged: true },
          },
          serverInfo: { name: "quark-agent-mcp", version: "1.0.0" },
        };
      case "tools/list":
        return { tools: Array.from(this.tools.values()) };
      case "tools/call": {
        const name = params?.name as string;
        const args = (params?.arguments ?? {}) as Record<string, unknown>;
        const handler = this.toolHandlers.get(name);
        if (!handler) throw new Error(`Unknown tool: ${name}`);
        return { content: [{ type: "text", text: String(await handler(args)) }] };
      }
      case "resources/list":
        return { resources: Array.from(this.resources.values()) };
      case "resources/read": {
        const uri = params?.uri as string;
        // Return placeholder — actual reading delegated to registered handlers
        return { contents: [{ uri, mimeType: "text/plain", text: "" }] };
      }
      case "prompts/list":
        return { prompts: Array.from(this.prompts.values()) };
      case "prompts/get": {
        const name = params?.name as string;
        const prompt = this.prompts.get(name);
        if (!prompt) throw new Error(`Unknown prompt: ${name}`);
        return { messages: [{ role: "user", content: { type: "text", text: prompt.description } }] };
      }
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  // Run as stdio transport
  async runStdio(): Promise<void> {
    const rl = readline.createInterface({ input: process.stdin });
    for await (const line of rl) {
      try {
        const msg = JSON.parse(line);
        const result = await this.handleRequest(msg.method, msg.params);
        const response = { jsonrpc: "2.0", id: msg.id, result };
        process.stdout.write(JSON.stringify(response) + "\n");
      } catch (err) {
        const response = {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        };
        process.stdout.write(JSON.stringify(response) + "\n");
      }
    }
  }

  // Run as SSE transport
  runSSE(port: number): void {
    const server = createServer(async (req, res) => {
      if (req.method === "POST") {
        // Handle JSON-RPC request
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", async () => {
          try {
            const msg = JSON.parse(body);
            const result = await this.handleRequest(msg.method, msg.params);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
          } catch (err) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: null,
                error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
              }),
            );
          }
        });
      } else if (req.method === "GET") {
        // SSE endpoint
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(": connected\n\n");
        // Keep alive
        const interval = setInterval(() => res.write(": ping\n\n"), 30000);
        req.on("close", () => clearInterval(interval));
      }
    });
    server.listen(port);
    console.log(`[MCP] SSE server listening on port ${port}`);
  }
}

// Helper: Create MCP server pre-registered with quark-agent's built-in tools
export async function createQuarkMCPServer(): Promise<MCPServer> {
  const mcp = new MCPServer();
  // Register built-in tools — these will be dynamically populated
  mcp.registerTool(
    "web_search",
    "Search the web",
    {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
    },
    async (args) => {
      // Placeholder — actual implementation delegates to WebSearchTool
      return `Search results for: ${args.query}`;
    },
  );
  mcp.registerTool(
    "web_fetch",
    "Fetch a URL",
    {
      type: "object",
      properties: { url: { type: "string", description: "URL to fetch" } },
      required: ["url"],
    },
    async (args) => {
      const res = await fetch(args.url as string);
      return await res.text();
    },
  );
  mcp.registerTool(
    "computer_screenshot",
    "Take a screenshot",
    {
      type: "object",
      properties: {},
    },
    async () => {
      return "Screenshot taken (requires computer_use module)";
    },
  );
  return mcp;
}
