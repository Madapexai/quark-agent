/**
 * 内置工具集：开箱即用的常用工具
 *
 * 设计：每个工具自包含、零外部依赖，可在沙箱内或外执行。
 */

import type { Tool, ToolContext, ToolSchema } from "../core/types.js";

// ============================================================================
// code_exec：在沙箱中执行 TS/JS 代码
// ============================================================================

export class CodeExecTool implements Tool {
  readonly name = "code_exec";
  readonly description = "在隔离沙箱中执行 TypeScript/JavaScript 代码并返回结果。用于计算、数据处理、原型验证。";
  readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: "code_exec",
      description: this.description,
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "要执行的代码，最后一条表达式作为返回值" },
          timeoutMs: { type: "number", description: "超时毫秒，默认 5000" },
        },
        required: ["code"],
      },
    },
  };

  async execute(args: { code: string; timeoutMs?: number }, ctx: ToolContext): Promise<string> {
    const result = await ctx.sandbox.run(args.code, {
      timeoutMs: args.timeoutMs,
    });
    if (!result.ok) {
      return `[执行失败 ${result.durationMs}ms] ${result.error}\nstdout: ${result.stdout}`;
    }
    const valStr = typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 2);
    return `[执行成功 ${result.durationMs}ms]\n返回: ${valStr}\nstdout: ${result.stdout}`;
  }
}

// ============================================================================
// memory_recall：召回相关记忆
// ============================================================================

export class MemoryRecallTool implements Tool {
  readonly name = "memory_recall";
  readonly description = "从长期记忆中检索相关信息。当你需要回忆之前的对话、事实或沉淀的技能时使用。";
  readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: "memory_recall",
      description: this.description,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "检索查询文本" },
          topK: { type: "number", description: "返回条数，默认 5" },
        },
        required: ["query"],
      },
    },
  };

  constructor(private readonly memory: { search: (q: { query: string; topK?: number }) => Promise<Array<{ content: string; kind: string }>> }) {}

  async execute(args: { query: string; topK?: number }): Promise<string> {
    const results = await this.memory.search({ query: args.query, topK: args.topK ?? 5 });
    if (results.length === 0) return "[无相关记忆]";
    return results.map((r, i) => `${i + 1}. [${r.kind}] ${r.content}`).join("\n");
  }
}

// ============================================================================
// http_get：简单的 HTTP GET（不依赖沙箱，直接用 fetch）
// ============================================================================

export class HttpGetTool implements Tool {
  readonly name = "http_get";
  readonly description = "发起 HTTP GET 请求获取网页或 API 数据。仅支持公开端点。";
  readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: "http_get",
      description: this.description,
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "完整 URL" },
          maxBytes: { type: "number", description: "最多返回字节数，默认 8192" },
        },
        required: ["url"],
      },
    },
  };

  async execute(args: { url: string; maxBytes?: number }, ctx: ToolContext): Promise<string> {
    const maxBytes = args.maxBytes ?? 8192;
    // 超时保护
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(30_000, ctx.deadline - Date.now()));
    try {
      const res = await fetch(args.url, { signal: controller.signal });
      if (!res.ok) return `[HTTP ${res.status}] ${res.statusText}`;
      const text = await res.text();
      return text.length > maxBytes ? text.slice(0, maxBytes) + "\n...[truncated]" : text;
    } catch (err) {
      return `[error] ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 默认工具集工厂 */
export function builtinTools(memory: { search: (q: { query: string; topK?: number }) => Promise<Array<{ content: string; kind: string }>> }): Map<string, Tool> {
  const tools: Tool[] = [new CodeExecTool(), new MemoryRecallTool(memory), new HttpGetTool()];
  return new Map(tools.map((t) => [t.name, t]));
}
