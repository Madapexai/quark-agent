/**
 * A2A (Agent-to-Agent) 协议实现
 *
 * 对标 Agent-Native 的 A2A 跨应用协作能力。
 * 实现 Google A2A 协议核心：
 * - AgentCard：agent 能力描述，通过 .well-known/agent.json 暴露
 * - Task：任务生命周期（submitted/working/completed/failed/canceled）
 * - Message：agent 间消息
 * - Artifact：任务产物
 *
 * 支持本地（进程内）和远程（HTTP）两种 transport。
 */

import type { Tool, ToolContext, ToolSchema } from "../core/types.js";

// ============================================================================
// A2A 协议类型（对齐 Google A2A 规范）
// ============================================================================

export type TaskState = "submitted" | "working" | "input-required" | "completed" | "failed" | "canceled" | "unknown";

export interface A2AMessage {
  role: "user" | "agent";
  parts: Array<{ kind: "text"; text: string } | { kind: "data"; data: Record<string, unknown> }>;
}

export interface A2AArtifact {
  name?: string;
  description?: string;
  parts: Array<{ kind: "text"; text: string } | { kind: "data"; data: Record<string, unknown> }>;
}

export interface A2ATask {
  id: string;
  sessionId?: string;
  status: { state: TaskState; message?: A2AMessage };
  history?: A2AMessage[];
  artifacts?: A2AArtifact[];
  metadata?: Record<string, unknown>;
}

export interface AgentSkill {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  examples?: string[];
}

export interface AgentCard {
  name: string;
  description: string;
  url: string;
  version?: string;
  capabilities?: { streaming?: boolean; pushNotifications?: boolean; stateTransitionHistory?: boolean };
  skills: AgentSkill[];
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
}

// ============================================================================
// 本地 A2A Registry：进程内 agent 发现与调用
// ============================================================================

export interface A2AAgent {
  card: AgentCard;
  /** 处理任务：发送消息 → 返回更新后的 task */
  sendMessage(taskId: string, message: A2AMessage, context?: Record<string, unknown>): Promise<A2ATask>;
  /** 创建新任务 */
  createTask(message: A2AMessage, context?: Record<string, unknown>): Promise<A2ATask>;
  /** 查询任务状态 */
  getTask(taskId: string): Promise<A2ATask | null>;
  /** 取消任务 */
  cancelTask(taskId: string): Promise<A2ATask | null>;
}

/** 本地 A2A 注册表 */
export class A2ARegistry {
  private agents = new Map<string, A2AAgent>();
  private remoteAgents = new Map<string, { url: string; card: AgentCard }>();

  /** 注册本地 agent */
  register(agent: A2AAgent): void {
    this.agents.set(agent.card.name, agent);
  }

  /** 注销 */
  unregister(name: string): void {
    this.agents.delete(name);
    this.remoteAgents.delete(name);
  }

  /** 发现：列出所有已知 agent */
  discover(): AgentCard[] {
    const local = [...this.agents.values()].map((a) => a.card);
    const remote = [...this.remoteAgents.values()].map((r) => r.card);
    return [...local, ...remote];
  }

  /** 按 name 查找 agent */
  get(name: string): A2AAgent | null {
    return this.agents.get(name) ?? null;
  }

  /** 注册远程 agent（HTTP transport） */
  registerRemote(url: string, card: AgentCard): void {
    this.remoteAgents.set(card.name, { url, card });
  }

  /** 调用远程 agent（HTTP JSON-RPC 风格） */
  async callRemote(agentName: string, message: A2AMessage, opts?: { fetchImpl?: typeof fetch }): Promise<A2ATask> {
    const remote = this.remoteAgents.get(agentName);
    if (!remote) throw new Error(`Remote agent not found: ${agentName}`);
    const fetchFn = opts?.fetchImpl ?? fetch;
    const res = await fetchFn(`${remote.url}/a2a/tasks/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) throw new Error(`A2A call failed: HTTP ${res.status}`);
    return res.json() as Promise<A2ATask>;
  }

  /** AgentCard 暴露为 .well-known/agent.json 内容 */
  wellKnown(): AgentCard[] {
    return this.discover();
  }
}

/** 全局 A2A 注册表 */
const globalA2A = new A2ARegistry();
export function getA2ARegistry(): A2ARegistry { return globalA2A; }

// ============================================================================
// A2A Tool：把任意 agent 包装为 Tool 供 LLM 调用
// ============================================================================

export class A2ACallTool implements Tool {
  readonly name: string;
  readonly description: string;
  readonly schema: ToolSchema;

  constructor(private readonly registry: A2ARegistry) {
    this.name = "a2a_call";
    this.description = "调用另一个 Agent 处理任务。指定 agent 名和消息，返回处理结果。";
    this.schema = {
      type: "function",
      function: {
        name: "a2a_call",
        description: this.description,
        parameters: {
          type: "object",
          properties: {
            agent: { type: "string", description: "目标 agent 名称" },
            message: { type: "string", description: "发送给该 agent 的消息" },
            taskId: { type: "string", description: "已有 taskId 时继续对话，不填则新建任务" },
          },
          required: ["agent", "message"],
        },
      },
    };
  }

  async execute(args: { agent: string; message: string; taskId?: string }, _ctx: ToolContext): Promise<string> {
    const agent = this.registry.get(args.agent);
    if (!agent) {
      const available = this.registry.discover().map((c) => c.name).join(", ");
      return `[error] Agent '${args.agent}' 未找到。可用 agent: ${available || "(无)"}`;
    }
    const msg: A2AMessage = { role: "user", parts: [{ kind: "text", text: args.message }] };
    try {
      const task = args.taskId
        ? await agent.sendMessage(args.taskId, msg)
        : await agent.createTask(msg);
      return formatTaskResult(task);
    } catch (err) {
      return `[error] A2A 调用失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

/** 把 A2ATask 格式化为文本给 LLM */
function formatTaskResult(task: A2ATask): string {
  const lines = [`[ok] Task ${task.id} [${task.status.state}]`];
  if (task.status.message) {
    for (const p of task.status.message.parts) {
      if (p.kind === "text") lines.push(p.text);
      else lines.push(JSON.stringify(p.data));
    }
  }
  if (task.artifacts?.length) {
    lines.push(`\n[产物 ${task.artifacts.length}]`);
    for (const a of task.artifacts) {
      for (const p of a.parts) {
        if (p.kind === "text") lines.push(p.text.slice(0, 2000));
        else lines.push(JSON.stringify(p.data).slice(0, 2000));
      }
    }
  }
  return lines.join("\n");
}

// ============================================================================
// A2A 工具：列出可用 agent
// ============================================================================

export class A2AListTool implements Tool {
  readonly name = "a2a_list";
  readonly description = "列出所有可用的 Agent（含本地和远程）及其能力。";
  readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: "a2a_list",
      description: this.description,
      parameters: { type: "object", properties: {} },
    },
  };

  constructor(private readonly registry: A2ARegistry) {}

  async execute(): Promise<string> {
    const cards = this.registry.discover();
    if (cards.length === 0) return "[ok] 暂无可用 agent";
    const lines = ["[ok] 可用 agents:"];
    for (const c of cards) {
      const skills = c.skills.map((s) => s.name).join(", ");
      lines.push(`- ${c.name}: ${c.description}${skills ? ` [skills: ${skills}]` : ""}`);
    }
    return lines.join("\n");
  }
}
