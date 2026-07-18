/**
 * micro-agent —— 轻量级自进化 Agent 框架
 *
 * 公共 API 出口。按模块分组导出。
 */

// core
export * from "./core/types.js";
export { Agent } from "./core/agent.js";
export type { RunOptions, RunResult } from "./core/agent.js";
export { Runtime, bindAgent } from "./core/runtime.js";
export type { RuntimeOptions } from "./core/runtime.js";
export { buildContext, computeBudget, DEFAULT_BUDGET_RATIO } from "./core/context.js";
export type { ContextBudget, BuildContextInput, BuiltContext } from "./core/context.js";

// provider
export { OpenAIProvider, OpenRouterProvider, pseudoEmbed } from "./provider/openai.js";
export type { OpenAIProviderOptions } from "./provider/openai.js";

// memory
export { SqliteMemory, cosine } from "./memory/sqlite.js";
export type { SqliteMemoryOptions } from "./memory/sqlite.js";
export { Compressor, estimateTokens } from "./memory/compress.js";
export type { CompressorOptions } from "./memory/compress.js";

// sandbox
export { VmSandbox } from "./sandbox/vm.js";
export type { VmSandboxOptions } from "./sandbox/vm.js";

// channel
export { CliChannel, HttpChannel } from "./channel/index.js";
export type { CliChannelOptions, HttpChannelOptions } from "./channel/index.js";
export { GitHubChannel } from "./channel/github.js";
export type { GitHubChannelOptions } from "./channel/github.js";
export { LocalChannel, tieredSandboxFactory } from "./channel/local.js";
export type { LocalChannelOptions } from "./channel/local.js";
export { WebhookChannel } from "./channel/webhook.js";
export type { WebhookChannelOptions, ParsedEvent } from "./channel/webhook.js";
export { FeishuChannel } from "./channel/feishu.js";
export type { FeishuChannelOptions } from "./channel/feishu.js";
export { WeChatChannel } from "./channel/wechat.js";
export type { WeChatChannelOptions } from "./channel/wechat.js";
export { TelegramChannel } from "./channel/telegram.js";
export type { TelegramChannelOptions } from "./channel/telegram.js";

// skills
export { SqliteSkillStore } from "./skills/store.js";

// soul
export { SoulStore, createSoul, renderSoul } from "./soul/index.js";
export type { SoulSpec } from "./soul/index.js";

// env
export { collectEnv, renderEnv, fullScope, lightweightScope, readOnlyScope } from "./env/index.js";
export type { CollectEnvOptions } from "./env/index.js";

// auth
export { AuthError, canUseTool, canUseModel, canReadDomain, filterTools, filterSandboxGlobals, pickModel, sandboxTierSatisfies } from "./auth/scope.js";

// session
export { SqliteSessionManager } from "./session/manager.js";
export type { SqliteSessionManagerOptions } from "./session/manager.js";

// evolve
export { Evolver } from "./evolve/gepa.js";
export type { EvalCase, EvolveConfig, EvolveResult } from "./evolve/gepa.js";

// observe
export { InMemoryTracer, printSpanTree } from "./observe/tracing.js";

// tools
export { CodeExecTool, MemoryRecallTool, HttpGetTool, builtinTools } from "./tools/builtin.js";
export { TextToImageTool, TextToVideoTool, MakeSlidesTool, multimodalTools } from "./tools/multimodal.js";
export type { ImageGenConfig, MultimodalProvider } from "./tools/multimodal.js";
export { StrReplaceTool, FileReadTool, FileWriteTool, editTools } from "./tools/edit.js";
export { BrowserOpenTool, BrowserSearchTool, BrowserClickTool, browserTools } from "./tools/browser.js";
export { GlobTool, GrepTool, LsTool, BashTool, fsTools } from "./tools/fs.js";
export { WebFetchTool, WebSearchTool, webTools } from "./tools/web.js";
export type { WebToolsOptions } from "./tools/web.js";
export { BrowserUseTool } from "./tools/browser_use.js";
export type { BrowserUseOptions } from "./tools/browser_use.js";
export { DataAnalyzeTool, CsvReadTool } from "./tools/data.js";
export { TestRunTool, TestAssertTool } from "./tools/test.js";
export { ComputerUseTool } from "./tools/computer.js";

// 场景裁剪：按 profile 选工具集，可定制不是大杂烩
export { PROFILES, toolsForProfile, toolsByCategory, listProfiles, recommendProfile, generateTrimSop } from "./core/profiles.js";
export type { Profile, ToolCategory, ProfileRecommendation } from "./core/profiles.js";

// 开源集成：快速把 npm 包包装成 Tool
export { ossTool, integratePackage, integratePackages, loadOssPackage, BUILTIN_ADAPTERS } from "./tools/oss.js";
export type { OssAdapter } from "./tools/oss.js";

// 平台连接器：打通 GitHub / Slack / 任意 webhook 等外部平台
export { platformConnector, githubConnector, webhookConnector } from "./platform/index.js";
export type { PlatformConfig, PlatformAction, GitHubConnectorOptions } from "./platform/index.js";

// 统一动作定义：defineAction 一个定义暴露到 agent/http/cli/mcp/a2a
export { defineAction, ActionRegistry, actionToTool, getGlobalRegistry } from "./action/index.js";
export type { ActionDefinition, ActionContext, ActionCaller } from "./action/index.js";

// A2A 协议：Agent 间发现与通信
export { A2ARegistry, A2ACallTool, A2AListTool, getA2ARegistry } from "./a2a/index.js";
export type { A2AAgent, AgentCard, A2ATask, A2AMessage, A2AArtifact, TaskState, AgentSkill } from "./a2a/index.js";

// 实时状态同步：EventBus + SSE
export { EventBus, SSEServer, syncPlugin, getEventBus, sseHeaders } from "./sync/index.js";
export type { SyncEvent, EventType, SSEClient } from "./sync/index.js";

// Per-user Workspace：多租户隔离
export { WorkspaceManager, InMemoryStore, defaultMemoryFactory, readonlyWorkspace, workspaceScope, filterToolsForWorkspace } from "./workspace/index.js";
export type { Workspace, WorkspaceConfig, MemoryFactory } from "./workspace/index.js";

// multi provider
export { AnthropicProvider, GeminiProvider, OllamaProvider, MultiProvider, consumeSSE } from "./provider/multi.js";
export type { AnthropicProviderOptions, GeminiProviderOptions, OllamaProviderOptions, MultiProviderOptions, SSEParser } from "./provider/multi.js";

// plugin system
export { PluginRegistry } from "./plugin/registry.js";
export type { PluginRegistryOptions } from "./plugin/registry.js";
export { logPlugin, metricPlugin, loopGuardPlugin, feedbackPlugin } from "./plugin/builtin.js";

// mcp
export { mcpPlugin } from "./mcp/client.js";
export type { McpServerConfig } from "./mcp/client.js";

// hub
export { clawHubPlugin } from "./hub/index.js";
export type { ClawHubOptions, HubSkillManifest } from "./hub/index.js";

// skills discover + score
export { SkillDiscoverer } from "./skills/discover.js";
export type { RunObservation } from "./skills/discover.js";
export { scoreSkill, shouldSediment, SEDIMENT_THRESHOLD } from "./skills/score.js";
export type { ScoreInput } from "./skills/score.js";

// core extensions
export { SubAgentTool } from "./core/subagent.js";
export type { SubAgentToolOptions } from "./core/subagent.js";
export { Planner, createPlannerTool } from "./core/planner.js";
export type { PlannerOptions } from "./core/planner.js";
export { Imitator } from "./core/imitate.js";
export type { ImitateSession } from "./core/imitate.js";
export { SelfHealer, diagnoseError } from "./core/healer.js";
export type { ErrorKind, HealResult } from "./core/healer.js";

// slash commands
export { handleSlash, registerSlash, listSlash } from "./channel/slash.js";
export type { SlashContext, SlashHandler } from "./channel/slash.js";

// ============================================================================
// 微内核分层架构（v0.1 引入）
//
// 使用方式（按需引入，不影响旧 API）：
//   import { createAgent, defineTool, EventBus } from "micro-agent/kernel";
//   import { a2aPlugin, ssePlugin } from "micro-agent/plugins";
// ============================================================================

// kernel（零依赖核心，<10KB）
export * as Kernel from "../packages/core/src/index.js";
// plugins（官方插件集：A2A/SSE/Workspace/defineAction/InMemory）
export * as Plugins from "../packages/plugins/src/index.js";
// extensions（高阶扩展：sessions/healer/skills）
export * as Extensions from "../packages/extensions/src/index.js";

// 便捷工厂
import Database from "better-sqlite3";
import { OpenAIProvider } from "./provider/openai.js";
import { SqliteMemory } from "./memory/sqlite.js";
import { VmSandbox } from "./sandbox/vm.js";
import { InMemoryTracer } from "./observe/tracing.js";
import { SqliteSkillStore } from "./skills/store.js";
import { SoulStore, createSoul } from "./soul/index.js";
import type { SoulSpec } from "./soul/index.js";
import { SqliteSessionManager } from "./session/manager.js";
import { Agent } from "./core/agent.js";
import { toolsForProfile } from "./core/profiles.js";
import { integratePackage } from "./tools/oss.js";
import type { AgentConfig, AgentDeps, Provider, Soul, Tool } from "./core/types.js";

export interface CreateAgentOptions {
  config: AgentConfig;
  apiKey: string;
  baseURL?: string;
  modelName?: string;
  /** SQLite 路径，默认 ./.data/micro-agent.sqlite */
  dbPath?: string;
  /** 是否启用技能沉淀 */
  enableSkills?: boolean;
  /** 是否启用多 session 管理（默认开） */
  enableSessions?: boolean;
  /** 人格 spec，不传用默认 soul */
  soulSpec?: SoulSpec;
  /** provider 实例（覆盖 apiKey/baseURL） */
  provider?: Provider;
  /** 场景裁剪 profile：minimal/coding/data/qa/research/full。默认 minimal */
  profile?: string;
  /** 在 profile 基础上追加的工具类别 */
  extraCategories?: import("./core/profiles.js").ToolCategory[];
  /** 从 profile 中排除的工具类别 */
  excludeCategories?: import("./core/profiles.js").ToolCategory[];
  /** 额外集成的开源包名列表（自动包装为 Tool） */
  ossPackages?: string[];
}

/**
 * 一行创建可运行的 Agent：
 * 自动装配 provider / memory(L0-L3) / sandbox / tracer / tools / skills / soul / sessions
 */
export async function createAgent(opts: CreateAgentOptions): Promise<{
  agent: Agent;
  deps: AgentDeps;
  soul: Soul;
  close: () => Promise<void>;
}> {
  const provider =
    opts.provider ??
    new OpenAIProvider({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL ?? "https://api.openai.com/v1",
      defaultModel: opts.modelName ?? opts.config.model,
    });

  const dbPath = opts.dbPath ?? "./.data/micro-agent.sqlite";
  const db = new Database(dbPath);

  const memory = new SqliteMemory(
    db,
    { path: dbPath },
    provider.embed ? (t) => provider.embed!(t) : undefined,
  );
  const sandbox = new VmSandbox();
  const tracer = new InMemoryTracer();
  const skills = opts.enableSkills === false ? undefined : new SqliteSkillStore(db);
  const soulStore = new SoulStore(db);
  if (opts.soulSpec) {
    const s = createSoul(opts.soulSpec);
    await soulStore.save(s);
  }
  const soul = await soulStore.current("default");
  const sessions =
    opts.enableSessions === false
      ? undefined
      : new SqliteSessionManager(db, memory, provider, { model: opts.modelName ?? opts.config.model });

  // 场景裁剪：按 profile 装配工具集，可定制不是大杂烩
  const profileName = opts.profile ?? "minimal";
  const profileTools = toolsForProfile(profileName, {
    memory,
    extraCategories: opts.extraCategories,
    excludeCategories: opts.excludeCategories,
  });
  // 集成开源包为 Tool
  const ossTools = opts.ossPackages ? opts.ossPackages.map((p) => integratePackage(p)) : [];
  const tools = new Map<string, Tool>();
  for (const t of [...profileTools, ...ossTools]) tools.set(t.name, t);

  const deps: AgentDeps = { provider, memory, sandbox, tracer, soul, tools, skills, sessions };
  const agent = new Agent(opts.config, deps);

  return {
    agent,
    deps,
    soul,
    close: async () => {
      await memory.close();
      await sandbox.dispose();
    },
  };
}
