/**
 * @micro-agent/core —— 核心类型定义
 *
 * 零依赖。所有 trait 都在这里，具体实现在 plugins/ 中。
 */

// ============================================================================
// 身份：user → session → turn 三级
// ============================================================================

export interface Identity {
  userId: string;
  sessionId: string;
  turnId?: string;
  channel?: string;
}

// ============================================================================
// 消息
// ============================================================================

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface Message {
  role: Role;
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: ToolCall[];
  meta?: Record<string, unknown>;
}

// ============================================================================
// Provider —— LLM 接入
// ============================================================================

export interface ChatRequest {
  messages: Message[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  tools?: ToolSchema[];
  stream?: boolean;
  signal?: AbortSignal;
}

export interface ChatResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: { prompt: number; completion: number; total: number };
  model: string;
  finishReason?: "stop" | "length" | "tool_calls" | "content_filter";
}

export interface Provider {
  readonly name: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
  chatStream?(req: ChatRequest, onDelta: (delta: string) => void): Promise<ChatResponse>;
  embed?(text: string): Promise<Float32Array>;
}

// ============================================================================
// Tool —— 能力原子
// ============================================================================

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolContext {
  agent: { id: string; name: string };
  deadline: number;
  meta?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  schema: ToolSchema;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

// ============================================================================
// Memory —— 持久化记忆
// ============================================================================

export type MemoryLayer = "L0" | "L1" | "L2" | "L3";

export interface MemoryEntry {
  id: string;
  content: string;
  kind: "chat" | "fact" | "skill" | "reflection";
  layer: MemoryLayer;
  userId: string;
  sessionId?: string;
  domain?: string;
  embedding?: Float32Array;
  importance?: number;
  createdAt: number;
  meta?: Record<string, unknown>;
}

export interface MemoryQuery {
  query: string;
  topK?: number;
  kind?: MemoryEntry["kind"];
  layer?: MemoryLayer;
  userId?: string;
  sessionId?: string;
  domain?: string;
}

export interface Memory {
  add(entry: Omit<MemoryEntry, "id" | "createdAt">): Promise<string>;
  search(query: MemoryQuery): Promise<MemoryEntry[]>;
  get(id: string): Promise<MemoryEntry | null>;
  delete(id: string): Promise<void>;
  list(filter: { userId?: string; sessionId?: string; layer?: MemoryLayer; kind?: MemoryEntry["kind"] }): Promise<MemoryEntry[]>;
  close(): Promise<void>;
}

// ============================================================================
// Scope —— 授权
// ============================================================================

export type SandboxTier = "none" | "lightweight" | "full";

export interface Scope {
  tools: string[] | "*";
  sandboxTier: SandboxTier;
  models: string[] | "*";
  memoryDomains: string[] | "*";
  rateLimit?: { rpm?: number; tpm?: number };
}

// ============================================================================
// Soul —— Agent 人格
// ============================================================================

export interface Soul {
  id: string;
  name: string;
  persona: string;
  traits: string[];
  principles: string[];
  speakingStyle?: string;
  systemPrompt: string;
  version: number;
}

// ============================================================================
// EventBus —— 插件间解耦通信（极简实现）
// ============================================================================

export type EventHandler<T = unknown> = (payload: T) => void | Promise<void>;

export interface EventBusLike {
  on<T = unknown>(event: string, handler: EventHandler<T>): () => void;
  emit<T = unknown>(event: string, payload: T): void;
}

// ============================================================================
// Run 选项/结果（提前定义，供 PluginContext.spawn 引用）
// ============================================================================

export interface RunOptions {
  userId?: string;
  sessionId?: string;
  channel?: string;
  scope?: Scope;
  meta?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface RunResult {
  reply: string;
  rounds: number;
  toolCalls: number;
  aborted?: boolean;
}

// ============================================================================
// Plugin —— 统一扩展点（增强版，支持依赖声明与事件）
// ============================================================================

export type HookPoint =
  | "beforeRun"
  | "afterRun"
  | "beforeTool"
  | "afterTool"
  | "onMessage"
  | "onStream"
  | "onChunk"
  | "onError";

export interface HookContext {
  identity: Identity;
  mutable?: { messages?: Message[]; userText?: string; toolResult?: string };
  run?: { reply?: string; rounds?: number; toolCalls?: number };
  toolCall?: ToolCall;
  toolResult?: string;
  chunk?: string;
  error?: Error;
  meta?: Record<string, unknown>;
}

export type HookFn = (ctx: HookContext) => void | Promise<void>;

export interface SubAgent {
  run(text: string, opts?: RunOptions): Promise<RunResult>;
}

export interface PluginContext {
  registerTool(t: Tool): void;
  unregisterTool(name: string): void;
  registerProvider(p: Provider): void;
  registerHook(hook: HookPoint, fn: HookFn): void;
  bus: EventBusLike;
  memory: Memory;
  scope: Scope;
  spawn?: (opts: { tools?: string[]; scope?: Scope; systemPrompt?: string }) => SubAgent;
  getService<T = unknown>(name: string): T | undefined;
  registerService(name: string, service: unknown): void;
  meta?: Record<string, unknown>;
}

export type Cleanup = () => void | Promise<void>;

export interface Plugin {
  readonly name: string;
  readonly version?: string;
  dependencies?: string[];
  install(ctx: PluginContext): Promise<Cleanup> | Cleanup;
}

// ============================================================================
// Agent 配置
// ============================================================================

export interface AgentConfig {
  id: string;
  name: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  maxToolRounds?: number;
  timeoutMs?: number;
  systemPrompt?: string;
}

export interface AgentDeps {
  provider: Provider;
  memory: Memory;
  tools?: Map<string, Tool>;
  plugins?: Plugin[];
  soul?: Soul;
  scope?: Scope;
  bus?: EventBusLike;
}
