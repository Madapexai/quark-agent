/** Agent 编排器：tool-calling 循环 + 多层上下文 + scope 授权 + session + 自恢复 + 自主修复 */

import type {
  AgentConfig,
  AgentDeps,
  ChatResponse,
  HookContext,
  Identity,
  Message,
  Scope,
  Span,
  Tool,
  ToolCall,
} from "./types.js";
import { buildContext, type ContextBudget } from "./context.js";
import { collectEnv, fullScope } from "../env/index.js";
import {
  AuthError,
  canUseTool,
  filterSandboxGlobals,
  filterTools,
  pickModel,
  sandboxTierSatisfies,
} from "../auth/scope.js";
import { estimateTokens } from "../memory/compress.js";
import type { PluginRegistry } from "../plugin/registry.js";
import { SelfHealer } from "./healer.js";

export interface RunOptions {
  userId?: string;
  sessionId?: string;
  /** 来源通道 */
  channel?: string;
  /** 该用户授权 scope（无则用 config.defaultScope） */
  scope?: Scope;
  /** 自定义环境变量 */
  envCustom?: Record<string, unknown>;
  /** 透传给工具的元数据 */
  meta?: Record<string, unknown>;
}

export interface RunResult {
  reply: string;
  rounds: number;
  toolCalls: number;
  span: Span;
  /** 上下文裁剪统计 */
  truncated: { working: number; rag: number };
  /** 实际使用的上下文 token 估算 */
  contextTokens: number;
  /** 是否从 checkpoint 恢复过 */
  recovered: boolean;
}

const DEFAULT_MAX_ROUNDS = 8;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_BUDGET = 8000;

export class Agent {
  plugins?: PluginRegistry;
  /** 自主修复器：tool 失败时诊断+自修复重试，不问用户。设为 undefined 关闭 */
  healer?: SelfHealer;

  constructor(
    private readonly config: AgentConfig,
    private readonly deps: AgentDeps,
  ) {}

  async run(userText: string, opts: RunOptions = {}): Promise<RunResult> {
    const { tracer, memory, provider, tools, soul, sessions } = this.deps;
    const scope = opts.scope ?? this.config.defaultScope ?? fullScope();

    const identity: Identity = {
      userId: opts.userId ?? "default",
      sessionId: opts.sessionId ?? `s-${Date.now().toString(36)}`,
      channel: opts.channel,
    };

    // beforeRun hook（可修改 userText）
    if (this.plugins) {
      const hctx: HookContext = { identity, mutable: { userText } };
      await this.plugins.runHook("beforeRun", hctx);
      userText = hctx.mutable?.userText ?? userText;
    }
    // 每次 run 重置自修复计数，避免跨 run 累积
    this.healer?.reset();

    const span = tracer.startSpan("agent.run", "agent", {
      agentId: this.config.id,
      userId: identity.userId,
      sessionId: identity.sessionId,
      model: this.config.model,
    });

    const maxRounds = this.config.maxToolRounds ?? DEFAULT_MAX_ROUNDS;
    const deadline = Date.now() + (this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const budget = this.config.contextTokenBudget ?? DEFAULT_BUDGET;

    // 1. 恢复或加载 L0 working memory
    let working: Message[] = [];
    let recovered = false;
    if (sessions) {
      try {
        working = await sessions.recover(identity);
        if (working.length > 0) recovered = true;
      } catch {
        // 无 checkpoint，正常开始
      }
      if (working.length === 0) {
        working = await sessions.getMessages(identity).catch(() => []);
      }
    }

    // 2. 召回 RAG：L2 facts + L1 summary
    const recalled = await memory
      .search({
        query: userText,
        topK: 6,
        userId: identity.userId,
      })
      .catch(() => []);

    // 3. 匹配技能
    const matchedSkills = this.deps.skills ? await this.deps.skills.match(userText).catch(() => []) : [];

    // 4. 组装上下文
    const env = collectEnv(identity, scope, { custom: opts.envCustom });
    const toolSchemasRaw = tools ? [...tools.values()].map((t) => t.schema) : [];
    const toolSchemas = filterTools(scope, toolSchemasRaw);

    const ctx = buildContext({
      soul,
      env,
      skills: matchedSkills,
      recalled,
      tools: toolSchemas,
      working,
      currentUserText: userText,
      budget: { total: budget } as Partial<ContextBudget>,
    });

    const messages = [...ctx.messages];
    let lastReply = "";
    let rounds = 0;
    let totalToolCalls = 0;

    // 5. tool-calling 循环
    while (rounds < maxRounds) {
      if (Date.now() > deadline) {
        lastReply = "[timeout] 超过最大执行时间";
        break;
      }
      rounds++;
      identity.turnId = `${identity.sessionId}-t${rounds}`;

      const model = pickModel(scope, this.config.model, this.config.model);
      const toolSpan = tracer.startSpan("provider.chat", "provider", {
        round: rounds,
        model,
      });

      let resp: ChatResponse;
      try {
        resp = await provider.chat({
          messages,
          model,
          temperature: this.config.temperature,
          maxTokens: this.config.maxTokens,
          tools: toolSchemas.length > 0 ? toolSchemas : undefined,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        tracer.endSpan(toolSpan, "error", msg);
        // 自恢复：从 checkpoint 恢复 messages 重试一次
        if (sessions && rounds === 1) {
          const restored = await sessions.recover(identity).catch(() => []);
          if (restored.length > 0) {
            messages.length = 0;
            messages.push(...ctx.messages.slice(0, 1), ...restored, ctx.messages[ctx.messages.length - 1]);
            recovered = true;
            continue;
          }
        }
        lastReply = `[provider error] ${msg}`;
        break;
      }
      tracer.endSpan(toolSpan, "ok");
      lastReply = resp.content ?? "";

      // 6. 处理 tool_calls（含 scope 授权 + 死循环检测）
      if (!resp.toolCalls || resp.toolCalls.length === 0) {
        break;
      }

      messages.push({
        role: "assistant",
        content: resp.content ?? "",
        toolCalls: resp.toolCalls,
      });

      let aborted = false;
      for (const call of resp.toolCalls) {
        // scope 授权
        if (!canUseTool(scope, call.name)) {
          messages.push({
            role: "tool",
            content: `[denied] 工具 ${call.name} 不在授权范围内`,
            toolCallId: call.id,
            toolName: call.name,
          });
          continue;
        }
        // 死循环检测
        if (sessions?.checkLoop(identity.sessionId, call)) {
          messages.push({
            role: "tool",
            content: `[loop] 工具 ${call.name} 连续重复调用，已中止`,
            toolCallId: call.id,
            toolName: call.name,
          });
          aborted = true;
          break;
        }
        totalToolCalls++;
        const toolResult = await this.executeTool(call, tools, scope, deadline, identity, opts.meta);
        messages.push({
          role: "tool",
          content: toolResult,
          toolCallId: call.id,
          toolName: call.name,
        });
      }
      if (aborted) break;

      // 每轮结束 checkpoint
      if (sessions) {
        await sessions.checkpoint(identity, messages).catch(() => undefined);
      }
    }

    // 7. 写入 L0 working memory + 对话沉淀
    if (sessions) {
      await sessions.append(identity, { role: "user", content: userText }).catch(() => undefined);
      await sessions.append(identity, { role: "assistant", content: lastReply }).catch(() => undefined);
    } else {
      await memory
        .add({
          content: `用户: ${userText}\n助手: ${lastReply}`,
          kind: "chat",
          layer: "L0",
          userId: identity.userId,
          sessionId: identity.sessionId,
          importance: 0.5,
        })
        .catch(() => undefined);
    }

    const contextTokens = Object.values(ctx.usage).reduce((a, b) => a + b, 0) + estimateTokens(lastReply);
    tracer.endSpan(span, "ok");

    // afterRun hook
    if (this.plugins) {
      const hctx: HookContext = {
        identity,
        run: { reply: lastReply, rounds, toolCalls: totalToolCalls },
      };
      await this.plugins.runHook("afterRun", hctx);
    }

    return {
      reply: lastReply,
      rounds,
      toolCalls: totalToolCalls,
      span,
      truncated: ctx.truncated,
      contextTokens,
      recovered,
    };
  }

  private async executeTool(
    call: ToolCall,
    tools: Map<string, Tool> | undefined,
    scope: Scope,
    deadline: number,
    identity: Identity,
    meta?: Record<string, unknown>,
  ): Promise<string> {
    const { tracer, sandbox } = this.deps;
    const toolSpan = tracer.startSpan("tool.execute", "tool", {
      tool: call.name,
      userId: identity.userId,
      args: call.arguments,
    });

    const tool = tools?.get(call.name);
    if (!tool) {
      tracer.endSpan(toolSpan, "error", `unknown tool: ${call.name}`);
      return `[error] 未知工具: ${call.name}`;
    }

    let args: Record<string, unknown> = {};
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {};
    } catch {
      tracer.endSpan(toolSpan, "error", "invalid json args");
      return `[error] 工具参数非法 JSON`;
    }

    if (call.name === "code_exec" && !sandboxTierSatisfies(scope, "lightweight")) {
      tracer.endSpan(toolSpan, "error", "sandbox tier denied");
      return `[denied] 当前 scope 不允许执行沙箱代码 (sandboxTier=${scope.sandboxTier})`;
    }

    // beforeTool hook（可注入 toolResult 提前中止）
    if (this.plugins) {
      const hctx: HookContext = { identity, toolCall: call, mutable: {} };
      await this.plugins.runHook("beforeTool", hctx);
      if (hctx.mutable?.toolResult) {
        tracer.endSpan(toolSpan, "ok", "hook-injected");
        return hctx.mutable.toolResult;
      }
    }

    const ctx = {
      sandbox: {
        ...sandbox,
        run: (code: string, options?: Record<string, unknown>) => {
          const allowed = new Set(filterSandboxGlobals(scope, Object.keys(options?.globals ?? {})));
          const globals: Record<string, unknown> = {};
          for (const [k, v] of Object.entries((options?.globals ?? {}) as Record<string, unknown>)) {
            if (allowed.has(k)) globals[k] = v;
          }
          return sandbox.run(code, { ...options, tier: scope.sandboxTier, globals });
        },
      },
      agent: { id: this.config.id, name: this.config.name },
      deadline,
      meta: { ...meta, identity },
    };

    try {
      let result = await tool.execute(args, ctx as never);
      // 自主修复：失败时像人一样诊断+自修复重试，不问用户
      if (result.startsWith("[error]") && this.healer) {
        const heal = this.healer.heal(call, result);
        if (heal.retryCall) {
          try {
            const fixedArgs = JSON.parse(heal.retryCall.arguments);
            const r2 = await tool.execute(fixedArgs, ctx as never);
            if (!r2.startsWith("[error]")) {
              tracer.endSpan(toolSpan, "ok", heal.diagnosis);
              return r2;
            }
          } catch {
            // 修复后仍失败，返回原始错误
          }
        }
      }
      tracer.endSpan(toolSpan, "ok");

      if (this.plugins) {
        const hctx: HookContext = { identity, toolCall: call, toolResult: result };
        await this.plugins.runHook("afterTool", hctx);
      }
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof AuthError) {
        tracer.endSpan(toolSpan, "error", `auth:${err.code}`);
        return `[denied:${err.code}] ${msg}`;
      }
      tracer.endSpan(toolSpan, "error", msg);
      return `[error] ${msg}`;
    }
  }
}
