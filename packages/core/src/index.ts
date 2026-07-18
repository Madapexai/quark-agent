/**
 * @micro-agent/core —— 核心层入口
 *
 * 零依赖、<10KB、可嵌入任意 runtime。
 * 其他能力（Provider/Memory/Tool/Protocol/Channel/Sandbox/Auth）都通过 Plugin 注册。
 */

// 核心类型
export type {
  Identity, Role, ToolCall, Message,
  ChatRequest, ChatResponse, Provider,
  ToolSchema, ToolContext, Tool,
  MemoryEntry, MemoryQuery, Memory, MemoryLayer,
  Scope, SandboxTier, Soul,
  EventBusLike, EventHandler,
  HookPoint, HookContext, HookFn, PluginContext, Cleanup, Plugin, SubAgent,
  AgentConfig, AgentDeps, RunOptions, RunResult,
} from "./types.js";

import type { Tool, ToolContext } from "./types.js";

// 错误
export { AgentError, PluginError, ToolError, AuthError, TimeoutError } from "./errors.js";

// EventBus
export { EventBus, createEventBus } from "./event-bus.js";

// Plugin 系统
export { PluginRegistry } from "./plugin-registry.js";
export type { PluginRegistryOptions } from "./plugin-registry.js";

// Agent Loop
export { Agent, createAgent } from "./agent.js";

/** 工具函数：创建工具 */
export function defineTool<T = Record<string, unknown>>(def: {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: T, ctx: ToolContext): Promise<string>;
}): Tool {
  return {
    name: def.name,
    description: def.description,
    schema: {
      type: "function",
      function: { name: def.name, description: def.description, parameters: def.parameters },
    },
    execute: def.execute as Tool["execute"],
  };
}

/** 版本 */
export const VERSION = "0.1.0";
