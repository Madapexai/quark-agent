/**
 * micro-agent 核心类型定义
 *
 * 设计哲学（来自调研报告 §四）：
 * - trait/接口驱动（学 ZeroClaw）：Provider / Channel / Tool / Memory / Sandbox 全可替换
 * - 零厂商锁定：所有 Provider 走 OpenAI 兼容协议
 * - 轻量优先：所有接口实现都应可在 <50MB RSS 下运行
 */

// ============================================================================
// 身份三级模型：user → session → turn
// ============================================================================

/**
 * 身份三级模型（学 OpenClaw 多 session + Hermes 持久画像）。
 * 所有记忆、技能、日志以 (userId, sessionId) 为复合 partition key。
 */
export interface Identity {
  /** 租户/人，授权 scope 与长期画像挂在这 */
  userId: string;
  /** 会话 ID，working memory 与 session 摘要挂在这 */
  sessionId: string;
  /** 单轮 ID，checkpoint 粒度 */
  turnId?: string;
  /** 来源通道名 */
  channel?: string;
}

// ============================================================================
// 授权 Scope
// ============================================================================

export type SandboxTier = "none" | "lightweight" | "full";

/**
 * 绑定在 userId 上的授权范围。三层过滤：工具 / 沙箱 / 模型 / 记忆域 / 限流。
 */
export interface Scope {
  /** 工具白名单，"*" 表示全部 */
  tools: string[] | "*";
  /** 沙箱等级：none 禁用 / lightweight 仅计算无 IO / full 完整 */
  sandboxTier: SandboxTier;
  /** 沙箱可注入的全局变量名 */
  sandboxGlobals: string[];
  /** 允许的模型上限列表 */
  models: string[];
  /** 可读记忆域 */
  memoryDomains: string[] | "*";
  /** 限流 */
  rateLimit?: { rpm?: number; tpm?: number };
}

// ============================================================================
// 记忆分层
// ============================================================================

/**
 * L0 working：当前 session 最近 N 轮原文
 * L1 session summary：每 K 轮压缩成的摘要
 * L2 long-term facts：跨 session 的用户事实/画像
 * L3 skills：自进化沉淀的技能
 */
export type MemoryLayer = "L0" | "L1" | "L2" | "L3";

// ============================================================================
// Soul —— 人格定义
// ============================================================================

/**
 * Soul = agent 的人格内核。可被自进化模块版本演进。
 * 渲染后产出 system prompt 的 base 部分。
 */
export interface Soul {
  id: string;
  name: string;
  /** 角色描述：你是谁 */
  persona: string;
  /** 性格特征：简洁/严谨/主动等 */
  traits: string[];
  /** 行为准则：不可违反的约束 */
  principles: string[];
  /** 说话风格 */
  speakingStyle?: string;
  /** 渲染后的 base system prompt（由 renderSoul 生成） */
  systemPrompt: string;
  /** 版本号，每次自进化 +1 */
  version: number;
  createdAt: number;
  updatedAt: number;
}

// ============================================================================
// Env —— 运行环境信息
// ============================================================================

export interface EnvInfo {
  now: string;
  timezone: string;
  locale: string;
  platform: string;
  nodeVersion: string;
  cwd: string;
  userId: string;
  sessionId: string;
  channel?: string;
  scope: Scope;
  /** 用户自定义环境变量 */
  custom: Record<string, unknown>;
}

// ============================================================================
// 消息与角色
// ============================================================================

export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  content: string;
  /** 工具调用产生时附带的工具调用 ID */
  toolCallId?: string;
  /** 工具调用名称（role=tool 时） */
  toolName?: string;
  /** assistant 发起的工具调用 */
  toolCalls?: ToolCall[];
  /** 元数据：来源通道、时间戳等 */
  meta?: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** JSON 字符串形式的参数 */
  arguments: string;
}

// ============================================================================
// Provider trait —— 模型提供方抽象
// ============================================================================

export interface ChatRequest {
  messages: Message[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** 可用工具声明（function calling） */
  tools?: ToolSchema[];
  /** 是否流式返回 */
  stream?: boolean;
  /** 透传字段 */
  extra?: Record<string, unknown>;
}

export interface ChatResponse {
  content: string;
  toolCalls?: ToolCall[];
  /** 本次调用 token 用量 */
  usage?: { prompt: number; completion: number; total: number };
  /** 原始模型 ID */
  model: string;
  finishReason?: "stop" | "length" | "tool_calls" | "content_filter";
}

export interface Provider {
  readonly name: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
  /** 流式增量回调 */
  chatStream?(req: ChatRequest, onDelta: (delta: string) => void): Promise<ChatResponse>;
  /** 嵌入向量（用于记忆检索），可选 */
  embed?(text: string): Promise<Float32Array>;
}

// ============================================================================
// Tool trait —— 工具 / 技能原子
// ============================================================================

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    /** JSON Schema 形式的参数声明 */
    parameters: Record<string, unknown>;
  };
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  schema: ToolSchema;
  /** 执行工具，返回字符串结果给模型 */
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export interface ToolContext {
  /** 沙箱实例，工具可在其中运行不可信代码 */
  sandbox: Sandbox;
  /** 调用方 agent */
  agent: { id: string; name: string };
  /** 截止时间（ms 时间戳），超时应中止 */
  deadline: number;
  /** 透传 */
  meta?: Record<string, unknown>;
}

// ============================================================================
// Memory trait —— 持久化记忆
// ============================================================================

export interface MemoryEntry {
  id: string;
  content: string;
  /** 记忆类型：对话片段 / 事实 / 技能沉淀 / 反思 */
  kind: "chat" | "fact" | "skill" | "reflection";
  /** 记忆分层：L0 working / L1 session summary / L2 long-term / L3 skill */
  layer: MemoryLayer;
  /** 归属用户（L2/L3 可为 "shared"） */
  userId: string;
  /** 归属 session（仅 L0/L1 有效，L2/L3 为空） */
  sessionId?: string;
  /** 记忆域，用于 scope 过滤 */
  domain?: string;
  /** 关联向量，可选 */
  embedding?: Float32Array;
  /** 重要度 0-1，影响召回权重 */
  importance?: number;
  createdAt: number;
  meta?: Record<string, unknown>;
}

export interface MemoryQuery {
  query: string;
  /** 期望返回条数 */
  topK?: number;
  /** 仅检索某类记忆 */
  kind?: MemoryEntry["kind"];
  /** 仅检索某层 */
  layer?: MemoryLayer;
  /** 用户隔离过滤 */
  userId?: string;
  /** session 隔离过滤（L0/L1） */
  sessionId?: string;
  /** 记忆域过滤 */
  domain?: string;
  /** 关键词过滤（FTS5 MATCH 语法） */
  filter?: string;
}

export interface Memory {
  /** 写入一条记忆 */
  add(entry: Omit<MemoryEntry, "id" | "createdAt">): Promise<string>;
  /** 混合检索：FTS5 + 向量 + LRU */
  search(query: MemoryQuery): Promise<MemoryEntry[]>;
  /** 按 ID 取 */
  get(id: string): Promise<MemoryEntry | null>;
  /** 删除 */
  delete(id: string): Promise<void>;
  /** 按用户/session 批量取（用于 session 摘要、压缩） */
  list(filter: { userId?: string; sessionId?: string; layer?: MemoryLayer; kind?: MemoryEntry["kind"] }): Promise<MemoryEntry[]>;
  /** 关闭底层资源 */
  close(): Promise<void>;
}

// ============================================================================
// Sandbox trait —— 不可信代码执行沙箱
// ============================================================================

export interface SandboxRunOptions {
  /** ms */
  timeoutMs?: number;
  /** 注入的全局变量 */
  globals?: Record<string, unknown>;
  /** 内存上限（字节），尽力而为 */
  memoryLimitBytes?: number;
  /** 沙箱等级：lightweight 仅计算无 IO，full 完整 */
  tier?: SandboxTier;
}

export interface SandboxResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  /** 实际执行 ms */
  durationMs: number;
  stdout: string;
}

export interface Sandbox {
  readonly name: string;
  /**
   * 执行一段 TS/JS 子集代码。
   * 设计目标（学 Zapcode）：10KB/次、µs-ms 级冷启动，无 Docker 依赖。
   */
  run(code: string, options?: SandboxRunOptions): Promise<SandboxResult>;
  /** 销毁沙箱实例，释放资源 */
  dispose(): Promise<void>;
}

// ============================================================================
// Channel trait —— 消息通道
// ============================================================================

export interface ChannelEvent {
  /** 用户 ID（多租户隔离） */
  userId: string;
  /** 通道内唯一会话 ID */
  sessionId: string;
  /** 入站文本 */
  text: string;
  /** 发送者标识 */
  from: string;
  /** 接收时间戳 */
  receivedAt: number;
  /** 该用户的授权 scope */
  scope?: Scope;
  /** 通道特有元数据（如 GitHub issue number） */
  meta?: Record<string, unknown>;
}

export type ChannelReply = {
  text: string;
  /** 是否结束本会话 */
  done?: boolean;
};

export interface Channel {
  readonly name: string;
  /** 启动通道，开始监听入站事件 */
  start(emit: (event: ChannelEvent) => void): Promise<void>;
  /** 向某会话回复 */
  reply(sessionId: string, reply: ChannelReply): Promise<void>;
  /** 关闭通道 */
  stop(): Promise<void>;
}

// ============================================================================
// Skill —— 技能沉淀（自进化产物）
// ============================================================================

export interface Skill {
  /** 唯一标识，如 "web.search.v3" */
  id: string;
  /** 人类可读名称 */
  name: string;
  /** 触发该技能的自然语言描述 / 正则 */
  trigger: string;
  /** prompt 模板，支持 {{var}} 占位 */
  promptTemplate: string;
  /** 该技能沉淀时的平均得分（GEPA 评估） */
  score: number;
  /** 调用次数 */
  invocations: number;
  /** 最近一次调用时间 */
  lastUsedAt: number;
  createdAt: number;
  meta?: Record<string, unknown>;
}

// ============================================================================
// Observability —— 内置 tracing
// ============================================================================

export type SpanKind = "provider" | "tool" | "memory" | "sandbox" | "channel" | "evolve" | "agent";

export interface Span {
  traceId: string;
  spanId: string;
  parentId?: string;
  name: string;
  kind: SpanKind;
  startedAt: number;
  endedAt?: number;
  attributes: Record<string, unknown>;
  status: "ok" | "error" | "unset";
  error?: string;
}

export interface Tracer {
  startSpan(name: string, kind: SpanKind, attributes?: Record<string, unknown>): Span;
  endSpan(span: Span, status?: Span["status"], error?: string): void;
  /** 导出全部 span（用于 OpenTelemetry 对接） */
  export(): Span[];
}

// ============================================================================
// Agent 配置与上下文
// ============================================================================

export interface AgentConfig {
  id: string;
  name: string;
  /** 默认模型 */
  model: string;
  /** 默认授权 scope（无 Channel scope 时兜底） */
  defaultScope?: Scope;
  temperature?: number;
  maxTokens?: number;
  /** 上下文 token 预算上限 */
  contextTokenBudget?: number;
  /** L0 working memory 最大轮数 */
  workingMemoryRounds?: number;
  /** 工具调用最大轮数（防死循环） */
  maxToolRounds?: number;
  /** 单轮超时 ms */
  timeoutMs?: number;
  /** 死循环检测阈值：相同 tool_call 连续次数 */
  loopDetectionThreshold?: number;
}

export interface AgentDeps {
  provider: Provider;
  memory: Memory;
  sandbox: Sandbox;
  tracer: Tracer;
  /** 人格内核，渲染 system prompt */
  soul: Soul;
  /** 工具表，name -> Tool */
  tools?: Map<string, Tool>;
  /** 技能仓库，可空 */
  skills?: SkillStore;
  /** 会话管理器，可空（单 session 模式） */
  sessions?: SessionManager;
}

/** 会话管理器 trait：多 session 并发 + checkpoint + 死循环检测 + 恢复 */
export interface SessionManager {
  /** 获取或创建 session 的 L0 working memory */
  getMessages(identity: Identity): Promise<Message[]>;
  /** 追加一条消息到 working memory */
  append(identity: Identity, message: Message): Promise<void>;
  /** 写入 checkpoint */
  checkpoint(identity: Identity, messages: Message[]): Promise<void>;
  /** 从最近 checkpoint 恢复 */
  recover(identity: Identity): Promise<Message[]>;
  /** 关闭 session：触发 L0→L1 摘要 */
  close(identity: Identity): Promise<void>;
  /** 死循环检测：记录并判断 tool_call 是否重复 */
  checkLoop(sessionId: string, toolCall: ToolCall): boolean;
}

export interface SkillStore {
  list(): Promise<Skill[]>;
  add(skill: Skill): Promise<void>;
  remove(id: string): Promise<void>;
  /** 按触发条件匹配技能 */
  match(text: string): Promise<Skill[]>;
}

// ============================================================================
// Plugin —— 统一扩展点（MCP / Hub / 自定义能力都走这个）
// ============================================================================

export type HookPoint =
  | "beforeRun"
  | "afterRun"
  | "beforeTool"
  | "afterTool"
  | "onMessage"
  | "onStream"
  | "onSkillSediment";

/** Hook 上下文，携带可变状态供后续链路读取 */
export interface HookContext {
  /** 当前 agent run 的身份 */
  identity: Identity;
  /** 可修改的运行参数（beforeRun 可改 messages 等） */
  mutable?: { messages?: Message[]; userText?: string; toolResult?: string };
  /** 只快照 */
  run?: { reply?: string; rounds?: number; toolCalls?: number; chunks?: string[] };
  /** 工具调用细节（beforeTool/afterTool） */
  toolCall?: ToolCall;
  toolResult?: string;
  /** 流式 chunk（onStream） */
  chunk?: string;
  /** 沉淀的技能（onSkillSediment） */
  skill?: Skill;
  /** 透传 */
  meta?: Record<string, unknown>;
}

export type HookFn = (ctx: HookContext) => void | Promise<void>;

export interface PluginContext {
  registerTool(t: Tool): void;
  unregisterTool(name: string): void;
  registerHook(hook: HookPoint, fn: HookFn): void;
  registerProvider(p: Provider): void;
  /** 派生子 agent（学 Claude Code sub-agent） */
  spawn?: (opts: { tools?: string[]; scope?: Scope }) => { run(text: string): Promise<string> };
  memory: Memory;
  tracer: Tracer;
}

/** Plugin 卸载函数 */
export type Cleanup = () => void | Promise<void>;

export interface Plugin {
  readonly name: string;
  readonly version?: string;
  /** 装载时注册 tools/hooks/providers，返回卸载函数 */
  install(ctx: PluginContext): Promise<Cleanup>;
}

// ============================================================================
// 决策力 / 任务规划
// ============================================================================

export interface PlanStep {
  id: string;
  /** 自然语言描述这一步要做什么 */
  description: string;
  /** 预期使用的工具名，可空 */
  tool?: string;
  /** 状态 */
  status: "pending" | "running" | "done" | "skipped" | "failed";
  /** 完成后填入结果摘要 */
  result?: string;
}

export interface Plan {
  goal: string;
  steps: PlanStep[];
  /** 当前执行到第几步 */
  cursor: number;
}

// ============================================================================
// 模仿人干活 —— 录制 + 重放
// ============================================================================

export interface RecordedAction {
  /** 步骤序号 */
  index: number;
  /** 动作类型：tool_call / message / observation */
  kind: "tool_call" | "message" | "observation";
  /** 工具名（kind=tool_call 时） */
  tool?: string;
  /** 参数 JSON */
  args?: string;
  /** 文本内容（message/observation） */
  text?: string;
  /** 时间戳 */
  ts: number;
}

export interface Recipe {
  id: string;
  name: string;
  /** 触发该 recipe 的自然语言描述 */
  trigger: string;
  /** 录制到的动作序列 */
  actions: RecordedAction[];
  /** 沉淀分数 */
  score: number;
  invocations: number;
  createdAt: number;
  meta?: Record<string, unknown>;
}

// ============================================================================
// Skill 评分维度（用于自动发现 + 入库）
// ============================================================================

export interface SkillScore {
  /** 成功率 0-1 */
  successRate: number;
  /** 节省 token 比例 0-1（vs 不用技能的 baseline） */
  tokenSaving: number;
  /** 用户反馈：+1 / -1 累计 */
  feedback: number;
  /** 调用频次（归一化 log） */
  frequency: number;
  /** 综合分 0-1 */
  overall: number;
}

// ============================================================================
// 多模态产物引用（文本回传，不污染 Message 类型）
// ============================================================================

export interface MediaRef {
  kind: "image" | "video" | "slides" | "audio";
  url: string;
  /** markdown 渲染（如 ![](url)） */
  markdown: string;
  meta?: Record<string, unknown>;
}
