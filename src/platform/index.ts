/**
 * 平台连接器：把外部平台（GitHub / Slack / Jira / 自建 webhook）的能力注册为工具
 *
 * 设计（对标 Claude Code MCP + Codex apps 连接器）：
 * - 每个平台 = 一个 Plugin，热插拔
 * - 平台配置声明 actions（name + HTTP 模板），自动生成对应 Tool
 * - 内置 github 预设 + 通用 webhook，可扩展更多平台
 * - 打通不同平台：agent 可直接调 GitHub issue / Slack 消息 / 任意 webhook
 */

import type { Plugin, Tool, ToolContext, ToolSchema } from "../core/types.js";

/** 平台 action 定义：一个 HTTP 调用 = 一个工具 */
export interface PlatformAction {
  /** 工具名（自动加平台前缀） */
  name: string;
  description: string;
  /** JSON Schema 参数 */
  parameters: Record<string, unknown>;
  /** HTTP 方法 */
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** 路径模板，{{var}} 从参数插值，如 /repos/{{owner}}/{{repo}}/issues */
  pathTemplate: string;
  /** body 模板（POST/PUT 用），{{var}} 插值；留空则把整个参数作 body */
  bodyTemplate?: string;
}

export interface PlatformConfig {
  /** 平台名，作为工具前缀，如 github */
  name: string;
  baseURL: string;
  /** 鉴权头，如 { Authorization: "token xxx" } */
  headers?: Record<string, string>;
  actions: PlatformAction[];
  /** 自定义 fetch（测试用） */
  fetchImpl?: typeof fetch;
  /** 超时 ms */
  timeoutMs?: number;
}

/** 模板插值：把 {{var}} 替换为 params.var（URL 编码，保留路径斜杠） */
function fillTemplate(tpl: string, params: Record<string, unknown>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) =>
    encodeURIComponent(String(params[k] ?? "")).replace(/%2F/gi, "/"),
  );
}

/** 平台连接器：把 PlatformConfig 转为 Plugin，每个 action 注册为一个 Tool */
export function platformConnector(config: PlatformConfig): Plugin {
  return {
    name: `platform:${config.name}`,
    async install(ctx) {
      const tools: Tool[] = config.actions.map((action) => buildTool(config, action));
      for (const t of tools) ctx.registerTool(t);
      return async () => {
        for (const t of tools) ctx.unregisterTool(t.name);
      };
    },
  };
}

function buildTool(config: PlatformConfig, action: PlatformAction): Tool {
  const toolName = `${config.name}_${action.name}`;
  const schema: ToolSchema = {
    type: "function",
    function: { name: toolName, description: action.description, parameters: action.parameters },
  };
  return {
    name: toolName,
    description: action.description,
    schema,
    async execute(args: Record<string, unknown>, _ctx?: ToolContext) {
      const url = config.baseURL + fillTemplate(action.pathTemplate, args);
      const init: RequestInit = { method: action.method, headers: config.headers ?? {} };
      if (action.method !== "GET" && action.method !== "DELETE") {
        const body = action.bodyTemplate ? fillTemplate(action.bodyTemplate, args) : JSON.stringify(args);
        init.body = body;
        (init.headers as Record<string, string>)["Content-Type"] = "application/json";
      }
      const fetchFn = config.fetchImpl ?? fetch;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 30_000);
      try {
        const res = await fetchFn(url, { ...init, signal: controller.signal });
        const text = await res.text();
        if (!res.ok) return `[error] ${config.name} ${res.status}: ${text.slice(0, 500)}`;
        // 尝试精简 JSON 输出
        try {
          const json = JSON.parse(text);
          const summary = Array.isArray(json) ? `[${json.length} 条] ` + json.slice(0, 5).map((x) => JSON.stringify(x)).join("\n") : JSON.stringify(json, null, 2).slice(0, 4000);
          return `[ok] ${summary}`;
        } catch {
          return `[ok] ${text.slice(0, 4000)}`;
        }
      } catch (err) {
        return `[error] ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// ============================================================================
// 内置预设：GitHub
// ============================================================================

export interface GitHubConnectorOptions {
  token: string;
  /** 自定义 fetch */
  fetchImpl?: typeof fetch;
}

/** GitHub 连接器：issue 列表 / 创建 issue / 搜索仓库 */
export function githubConnector(opts: GitHubConnectorOptions): Plugin {
  return platformConnector({
    name: "github",
    baseURL: "https://api.github.com",
    headers: { Authorization: `token ${opts.token}`, Accept: "application/vnd.github+json" },
    fetchImpl: opts.fetchImpl,
    actions: [
      {
        name: "list_issues",
        description: "列出 GitHub 仓库的 issues",
        parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, state: { type: "string", description: "open/closed/all" } }, required: ["owner", "repo"] },
        method: "GET",
        pathTemplate: "/repos/{{owner}}/{{repo}}/issues?state={{state}}",
      },
      {
        name: "create_issue",
        description: "在 GitHub 仓库创建 issue",
        parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" } }, required: ["owner", "repo", "title"] },
        method: "POST",
        pathTemplate: "/repos/{{owner}}/{{repo}}/issues",
        bodyTemplate: `{"title":"{{title}}","body":"{{body}}"}`,
      },
      {
        name: "search_repos",
        description: "搜索 GitHub 仓库",
        parameters: { type: "object", properties: { q: { type: "string", description: "搜索关键词" } }, required: ["q"] },
        method: "GET",
        pathTemplate: "/search/repositories?q={{q}}",
      },
    ],
  });
}

/** 通用 webhook 连接器：把任意 webhook 端点注册为工具 */
export function webhookConnector(opts: {
  name: string;
  baseURL: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}): Plugin {
  return platformConnector({
    name: opts.name,
    baseURL: opts.baseURL,
    headers: opts.headers,
    fetchImpl: opts.fetchImpl,
    actions: [
      {
        name: "call",
        description: `调用 ${opts.name} webhook`,
        parameters: { type: "object", properties: { path: { type: "string", description: "路径，如 /notify" }, payload: { type: "string", description: "JSON 字符串 payload" } }, required: ["path"] },
        method: "POST",
        pathTemplate: "{{path}}",
      },
    ],
  });
}
