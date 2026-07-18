/**
 * SubAgent —— 子 agent 派发工具
 *
 * 设计（学 Claude Code / Codex 的子 agent）：
 * - 作为 Tool 注册，主 agent 可调 subagent 派发子任务
 * - 子 agent 继承父 scope 但可收窄 tools
 * - 子 agent 结果仅返回文本，不污染父上下文
 * - 父 agent 可并行派发多个子 agent
 *
 * 行预算：~90 行
 */

import type { Agent, RunOptions } from "./agent.js";
import type { Tool, ToolContext, ToolSchema, Scope } from "./types.js";

export interface SubAgentToolOptions {
  /** 父 agent 实例 */
  agent: Agent;
  /** 默认 scope（继承父） */
  parentScope?: Scope;
  /** 允许子 agent 使用的工具白名单（默认继承父全部） */
  allowedTools?: string[];
}

export class SubAgentTool implements Tool {
  readonly name = "subagent";
  readonly description = "派发一个子 agent 执行子任务。子 agent 有独立上下文，结果仅返回文本摘要。适合并行处理、上下文隔离、复杂任务拆分。";
  readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: "subagent",
      description: this.description,
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "子任务描述" },
          tools: { type: "array", items: { type: "string" }, description: "子 agent 可用工具名列表（默认继承全部）" },
          sessionId: { type: "string", description: "子 session ID（默认派生）" },
        },
        required: ["prompt"],
      },
    },
  };

  constructor(private readonly opts: SubAgentToolOptions) {}

  async execute(args: { prompt: string; tools?: string[]; sessionId?: string }, _ctx: ToolContext): Promise<string> {
    // 收窄 scope：仅允许指定工具
    const scope: Scope = this.opts.parentScope
      ? {
          ...this.opts.parentScope,
          tools: args.tools && args.tools.length > 0 ? args.tools : this.opts.allowedTools ?? this.opts.parentScope.tools,
        }
      : { tools: args.tools ?? "*", sandboxTier: "lightweight", sandboxGlobals: [], models: [], memoryDomains: "*" };

    const runOpts: RunOptions = {
      userId: "subagent",
      sessionId: args.sessionId ?? `sub-${Date.now().toString(36)}`,
      scope,
      channel: "subagent",
    };

    try {
      const result = await this.opts.agent.run(args.prompt, runOpts);
      // 只返回文本，丢弃 span 等细节，节省父上下文
      const summary = result.reply.slice(0, 4000);
      return `[subagent rounds=${result.rounds} toolCalls=${result.toolCalls}]\n${summary}`;
    } catch (e) {
      return `[error] subagent: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}
