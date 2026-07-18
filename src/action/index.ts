/**
 * defineAction：统一动作定义
 *
 * 对标 Agent-Native 的 defineAction，一个定义同时暴露到多个入口：
 * - Agent Tool：自动包装为 Tool 供 LLM function calling
 * - HTTP API：自动生成 REST 路由
 * - CLI：自动生成子命令
 * - MCP：自动暴露为 MCP tool
 * - A2A：自动暴露为 A2A task capability
 *
 * 核心理念：写一次，到处调用。调用者通过 ctx.caller 判断来源。
 */

import type { Tool, ToolSchema, ToolContext } from "../core/types.js";

/** 调用来源 */
export type ActionCaller = "agent" | "http" | "cli" | "mcp" | "a2a" | "ui";

/** Action 执行上下文 */
export interface ActionContext {
  caller: ActionCaller;
  userId: string;
  sessionId?: string;
  /** 原始请求对象（HTTP 时为 Request，CLI 时为 argv） */
  raw?: unknown;
  /** ToolContext（caller=agent 时） */
  toolCtx?: ToolContext;
  /** 透传元数据 */
  meta?: Record<string, unknown>;
}

/** Action 定义 */
export interface ActionDefinition<TInput = Record<string, unknown>, TOutput = unknown> {
  name: string;
  description: string;
  /** JSON Schema 参数声明（兼容 ToolSchema.parameters） */
  parameters: Record<string, unknown>;
  /** 执行函数 */
  run: (input: TInput, ctx: ActionContext) => Promise<TOutput> | TOutput;
  /** 暴露到哪些入口（默认全部） */
  expose?: ActionCaller[];
  /** HTTP 配置（caller=http 时） */
  http?: { method?: "GET" | "POST" | "PUT" | "DELETE"; path?: string };
  /** CLI 配置（caller=cli 时） */
  cli?: { command?: string; aliases?: string[] };
  /** MCP 配置（caller=mcp 时） */
  mcp?: { name?: string };
  /** A2A 配置（caller=a2a 时） */
  a2a?: { capability?: string };
  /** 是否需要人工审批 */
  requireApproval?: boolean | ((input: TInput, ctx: ActionContext) => boolean);
  /** 只读操作（不修改状态，可安全重放） */
  readOnly?: boolean;
}

/** Action 注册表 */
export class ActionRegistry {
  private actions = new Map<string, ActionDefinition>();

  /** 注册一个 action */
  register<T, U>(def: ActionDefinition<T, U>): void {
    this.actions.set(def.name, def as ActionDefinition);
  }

  /** 批量注册 */
  registerAll(defs: ActionDefinition[]): void {
    for (const d of defs) this.register(d);
  }

  /** 注销 */
  unregister(name: string): void {
    this.actions.delete(name);
  }

  /** 获取 */
  get(name: string): ActionDefinition | undefined {
    return this.actions.get(name);
  }

  /** 列出所有 action */
  list(): ActionDefinition[] {
    return [...this.actions.values()];
  }

  /** 按入口过滤，返回该入口可见的 action */
  forCaller(caller: ActionCaller): ActionDefinition[] {
    return [...this.actions.values()].filter(
      (a) => !a.expose || a.expose.includes(caller),
    );
  }

  /** 调用 action */
  async call(name: string, input: Record<string, unknown>, ctx: ActionContext): Promise<unknown> {
    const def = this.actions.get(name);
    if (!def) throw new Error(`Action not found: ${name}`);
    if (def.expose && !def.expose.includes(ctx.caller)) {
      throw new Error(`Action ${name} not exposed to ${ctx.caller}`);
    }
    return def.run(input as never, ctx);
  }

  // ---- 各入口自动转换 ----

  /** 把所有暴露给 agent 的 action 转成 Tool 列表 */
  toTools(): Tool[] {
    return this.forCaller("agent").map((def) => actionToTool(def));
  }

  /** 生成 HTTP 路由表（method + path → handler） */
  toHttpRoutes(): Array<{ method: string; path: string; handler: (input: Record<string, unknown>, ctx: ActionContext) => Promise<unknown>; def: ActionDefinition }> {
    return this.forCaller("http").map((def) => ({
      method: def.http?.method ?? "POST",
      path: def.http?.path ?? `/api/actions/${def.name}`,
      handler: async (input, ctx) => await def.run(input, ctx),
      def,
    }));
  }

  /** 生成 CLI 命令表 */
  toCliCommands(): Array<{ command: string; description: string; handler: (args: string[]) => Promise<unknown>; def: ActionDefinition }> {
    return this.forCaller("cli").map((def) => {
      const cmd = def.cli?.command ?? def.name;
      return {
        command: cmd,
        description: def.description,
        handler: async (args: string[]) => {
          // 简单 key=value 参数解析
          const input: Record<string, string> = {};
          for (const a of args) {
            const eq = a.indexOf("=");
            if (eq > 0) input[a.slice(0, eq)] = a.slice(eq + 1);
          }
          return def.run(input as never, { caller: "cli", userId: "cli" });
        },
        def,
      };
    });
  }
}

/** 全局单例注册表（便捷使用） */
const globalRegistry = new ActionRegistry();

/** 定义一个 action 并注册到全局注册表 */
export function defineAction<T, U>(def: ActionDefinition<T, U>): ActionDefinition<T, U> {
  globalRegistry.register(def);
  return def;
}

/** 获取全局注册表 */
export function getGlobalRegistry(): ActionRegistry {
  return globalRegistry;
}

/** 把 ActionDefinition 包装为 Tool */
export function actionToTool(def: ActionDefinition): Tool {
  const schema: ToolSchema = {
    type: "function",
    function: {
      name: def.name,
      description: def.description,
      parameters: def.parameters,
    },
  };
  return {
    name: def.name,
    description: def.description,
    schema,
    async execute(args: Record<string, unknown>, toolCtx: ToolContext): Promise<string> {
      try {
        const result = await def.run(args as never, {
          caller: "agent",
          userId: toolCtx.meta?.userId as string ?? "anonymous",
          sessionId: toolCtx.meta?.sessionId as string,
          toolCtx,
          meta: toolCtx.meta,
        });
        return typeof result === "string" ? result : JSON.stringify(result);
      } catch (err) {
        return `[error] ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}
