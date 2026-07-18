/**
 * @micro-agent/core —— 极简 Agent Loop
 *
 * 核心职责：工具调用循环 + 消息管理 + Hook 触发。
 * 不包含：上下文压缩、自修复、session 恢复、RAG 召回——这些都是插件/扩展的事。
 */

import type {
  AgentConfig,
  AgentDeps,
  EventBusLike,
  HookContext,
  Identity,
  Message,
  RunOptions,
  RunResult,
  Scope,
  Tool,
  ToolCall,
} from "./types.js";
import { PluginRegistry } from "./plugin-registry.js";

const DEFAULT_MAX_ROUNDS = 8;
const DEFAULT_TIMEOUT_MS = 60_000;

const FULL_SCOPE: Scope = {
  tools: "*",
  sandboxTier: "full",
  models: "*",
  memoryDomains: "*",
};

export class Agent {
  private tools = new Map<string, Tool>();
  private registry: PluginRegistry | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly config: AgentConfig,
    private readonly deps: AgentDeps,
  ) {
    if (deps.tools) {
      for (const [k, v] of deps.tools) this.tools.set(k, v);
    }
  }

  private async ensureInitialized(scope: Scope): Promise<void> {
    if (this.registry) return;
    if (this.initPromise) return this.initPromise;

    const { memory, bus, plugins } = this.deps;
    this.initPromise = (async () => {
      const registry = new PluginRegistry({
        bus,
        memory,
        scope,
      });
      if (plugins) registry.registerAll(plugins);
      await registry.installAll();
      this.registry = registry;
      for (const [k, v] of registry.getTools()) this.tools.set(k, v);
    })();

    return this.initPromise;
  }

  async run(userText: string, opts: RunOptions = {}): Promise<RunResult> {
    const { provider, soul, bus, plugins } = this.deps;
    const scope = opts.scope ?? this.deps.scope ?? FULL_SCOPE;

    const identity: Identity = {
      userId: opts.userId ?? "default",
      sessionId: opts.sessionId ?? `s-${Date.now().toString(36)}`,
      channel: opts.channel,
    };

    if (plugins?.length || this.deps.tools?.size) {
      await this.ensureInitialized(scope);
    }
    const registry = this.registry;

    // beforeRun hook
    if (registry) {
      const hctx = { identity, mutable: { userText } };
      await registry.runHook("beforeRun", hctx);
      userText = hctx.mutable?.userText ?? userText;
    }

    const maxRounds = this.config.maxToolRounds ?? DEFAULT_MAX_ROUNDS;
    const deadline = Date.now() + (this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    // 组装基础 messages
    const messages: Message[] = [];
    const sysPrompt = this.config.systemPrompt ?? soul?.systemPrompt ?? `你是一个有用的 AI 助手 ${soul?.name ?? ""}`.trim();
    messages.push({ role: "system", content: sysPrompt });
    messages.push({ role: "user", content: userText });

    const toolSchemas = [...this.tools.values()].map((t) => t.schema);

    let lastReply = "";
    let rounds = 0;
    let totalToolCalls = 0;
    let aborted = false;

    while (rounds < maxRounds) {
      if (Date.now() > deadline) {
        lastReply = "[timeout] 超过最大执行时间";
        break;
      }
      rounds++;
      identity.turnId = `${identity.sessionId}-t${rounds}`;

      bus?.emit("agent:round:start", { identity, round: rounds });

      let resp;
      try {
        resp = await provider.chat({
          messages,
          model: this.config.model,
          temperature: this.config.temperature,
          maxTokens: this.config.maxTokens,
          tools: toolSchemas.length > 0 ? toolSchemas : undefined,
          signal: opts.signal,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        bus?.emit("agent:error", { identity, error: msg });
        if (registry) {
          await registry.runHook("onError", { identity, error: err instanceof Error ? err : new Error(msg) });
        }
        lastReply = `[provider error] ${msg}`;
        break;
      }

      lastReply = resp.content ?? "";
      bus?.emit("agent:round:end", { identity, round: rounds, reply: lastReply });

      if (!resp.toolCalls || resp.toolCalls.length === 0) break;

      messages.push({ role: "assistant", content: resp.content ?? "", toolCalls: resp.toolCalls });

      for (const call of resp.toolCalls) {
        // scope 检查
        if (scope.tools !== "*" && !scope.tools.includes(call.name)) {
          messages.push({
            role: "tool", content: `[denied] 工具 ${call.name} 不在授权范围内`,
            toolCallId: call.id, toolName: call.name,
          });
          continue;
        }

        // beforeTool hook
        if (registry) {
          const hctx: HookContext = { identity, toolCall: call, mutable: { toolResult: undefined } };
          await registry.runHook("beforeTool", hctx);
          if (hctx.mutable?.toolResult) {
            messages.push({ role: "tool", content: hctx.mutable.toolResult, toolCallId: call.id, toolName: call.name });
            continue;
          }
        }

        totalToolCalls++;
        const result = await this.executeTool(call, deadline, identity, bus, opts);
        messages.push({ role: "tool", content: result, toolCallId: call.id, toolName: call.name });

        if (registry) {
          await registry.runHook("afterTool", { identity, toolCall: call, toolResult: result });
        }

        bus?.emit("tool:executed", { identity, tool: call.name, result });
      }

      // 每轮结束 checkpoint hook
      if (registry) {
        const hctx = { identity, mutable: { messages } };
        await registry.runHook("onMessage", hctx);
      }
    }

    messages.push({ role: "assistant", content: lastReply });

    // afterRun hook
    if (registry) {
      await registry.runHook("afterRun", { identity, run: { reply: lastReply, rounds, toolCalls: totalToolCalls } });
    }

    bus?.emit("agent:done", { agentId: this.config.id, identity, reply: lastReply, rounds, toolCalls: totalToolCalls });

    return { reply: lastReply, rounds, toolCalls: totalToolCalls, aborted };
  }

  private async executeTool(
    call: ToolCall,
    deadline: number,
    identity: Identity,
    bus: EventBusLike | undefined,
    opts: RunOptions,
  ): Promise<string> {
    const tool = this.tools.get(call.name);
    if (!tool) return `[error] 未知工具: ${call.name}`;

    let args: Record<string, unknown> = {};
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {};
    } catch {
      return `[error] 工具参数非法 JSON`;
    }

    const ctx = {
      agent: { id: this.config.id, name: this.config.name },
      deadline,
      meta: { ...(opts.meta ?? {}), identity },
      signal: opts.signal,
    };

    try {
      return await tool.execute(args, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const error = err instanceof Error ? err : new Error(msg);
      bus?.emit("tool:error", { identity, tool: call.name, error, args });
      return `[error] ${msg}`;
    }
  }
}

export function createAgent(config: AgentConfig, deps: AgentDeps): Agent {
  return new Agent(config, deps);
}
