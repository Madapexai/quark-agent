import type { Plugin, PluginContext, Tool, ToolContext, ToolSchema } from "@micro-agent/core";

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

export interface A2AAgent {
  card: AgentCard;
  sendMessage(taskId: string, message: A2AMessage, ctx?: Record<string, unknown>): Promise<A2ATask>;
  createTask(message: A2AMessage, ctx?: Record<string, unknown>): Promise<A2ATask>;
  getTask(taskId: string): Promise<A2ATask | null>;
  cancelTask(taskId: string): Promise<A2ATask | null>;
}

export interface CallRemoteOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  taskId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export class A2ARegistry {
  private agents = new Map<string, A2AAgent>();
  private remoteAgents = new Map<string, { url: string; card: AgentCard }>();

  register(agent: A2AAgent): void {
    if (this.agents.has(agent.card.name)) {
      throw new Error(`A2A agent already registered: ${agent.card.name}`);
    }
    this.agents.set(agent.card.name, agent);
  }
  unregister(name: string): void { this.agents.delete(name); this.remoteAgents.delete(name); }

  discover(): AgentCard[] {
    return [
      ...[...this.agents.values()].map((a) => a.card),
      ...[...this.remoteAgents.values()].map((r) => r.card),
    ];
  }

  get(name: string): A2AAgent | null { return this.agents.get(name) ?? null; }

  registerRemote(url: string, card: AgentCard): void { this.remoteAgents.set(card.name, { url, card }); }

  async callRemote(agentName: string, message: A2AMessage, opts?: CallRemoteOptions): Promise<A2ATask> {
    const remote = this.remoteAgents.get(agentName);
    if (!remote) throw new Error(`Remote agent not found: ${agentName}`);
    const fetchFn = opts?.fetchImpl ?? fetch;
    const timeoutMs = opts?.timeoutMs ?? 30000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => reject(new Error(`A2A call timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      const body: Record<string, unknown> = { message };
      if (opts?.taskId) body.taskId = opts.taskId;
      if (opts?.sessionId) body.sessionId = opts.sessionId;
      if (opts?.metadata) body.metadata = opts.metadata;
      let res: Response;
      try {
        res = await Promise.race([
          fetchFn(`${remote.url}/a2a/tasks/send`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
          }),
          timeoutPromise,
        ]);
      } catch (err) {
        if ((err as Error).name === "AbortError" || /timed out/.test((err as Error).message)) {
          throw new Error(`A2A call timed out after ${timeoutMs}ms`);
        }
        throw new Error(`A2A network error: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!res.ok) {
        throw new Error(`A2A call failed: HTTP ${res.status} ${res.statusText}`);
      }
      let task: any;
      try {
        task = await res.json();
      } catch (err) {
        throw new Error(`A2A response JSON parse error: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!task || typeof task !== "object") {
        throw new Error("A2A response is not a valid object");
      }
      if (typeof task.id !== "string") {
        throw new Error("A2A response missing required field: id");
      }
      if (!task.status || typeof task.status !== "object") {
        throw new Error("A2A response missing required field: status");
      }
      if (typeof task.status.state !== "string") {
        throw new Error("A2A response missing required field: status.state");
      }
      return task as A2ATask;
    } finally {
      clearTimeout(timer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }
  }
}

class A2ACallTool implements Tool {
  readonly name = "a2a_call";
  readonly description = "调用另一个 Agent 处理任务。指定 agent 名和消息，返回处理结果。";
  readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: "a2a_call", description: this.description,
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
  constructor(private readonly registry: A2ARegistry) {}
  async execute(args: { agent: string; message: string; taskId?: string }, _ctx: ToolContext): Promise<string> {
    const agent = this.registry.get(args.agent);
    if (!agent) {
      const available = this.registry.discover().map((c) => c.name).join(", ");
      return `[error] Agent '${args.agent}' 未找到。可用 agent: ${available || "(无)"}`;
    }
    const msg: A2AMessage = { role: "user", parts: [{ kind: "text", text: args.message }] };
    try {
      const task = args.taskId ? await agent.sendMessage(args.taskId, msg) : await agent.createTask(msg);
      return formatTask(task);
    } catch (err) {
      return `[error] A2A 调用失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

class A2AListTool implements Tool {
  readonly name = "a2a_list";
  readonly description = "列出所有可用的 Agent（含本地和远程）及其能力。";
  readonly schema: ToolSchema = {
    type: "function", function: { name: "a2a_list", description: this.description, parameters: { type: "object", properties: {} } },
  };
  constructor(private readonly registry: A2ARegistry) {}
  async execute(): Promise<string> {
    const cards = this.registry.discover();
    if (cards.length === 0) return "[ok] 暂无可用 agent";
    return "[ok] 可用 agents:\n" + cards.map((c) => {
      const skills = c.skills.map((s) => s.name).join(", ");
      return `- ${c.name}: ${c.description}${skills ? ` [skills: ${skills}]` : ""}`;
    }).join("\n");
  }
}

function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return "[circular]";
  }
}

function formatTask(task: A2ATask): string {
  const lines: string[] = [`[ok] Task ${task.id} [${task.status.state}]`];
  if (task.status.message) {
    for (const p of task.status.message.parts) {
      lines.push(p.kind === "text" ? p.text : safeStringify(p.data));
    }
  }
  if (task.artifacts?.length) {
    lines.push(`\n[产物 ${task.artifacts.length}]`);
    for (const a of task.artifacts) {
      for (const p of a.parts) {
        lines.push((p.kind === "text" ? p.text : safeStringify(p.data)).slice(0, 2000));
      }
    }
  }
  return lines.join("\n");
}

export interface A2APluginOptions {
  remoteAgents?: Array<{ url: string; card: AgentCard }>;
  localAgents?: A2AAgent[];
}

export function a2aPlugin(opts: A2APluginOptions = {}): Plugin {
  return {
    name: "a2a",
    version: "0.1.0",
    dependencies: [],
    install(ctx: PluginContext) {
      const registry = new A2ARegistry();
      if (opts.localAgents) for (const a of opts.localAgents) registry.register(a);
      if (opts.remoteAgents) for (const r of opts.remoteAgents) registry.registerRemote(r.url, r.card);

      const callTool = new A2ACallTool(registry);
      const listTool = new A2AListTool(registry);
      ctx.registerTool?.(callTool);
      ctx.registerTool?.(listTool);
      ctx.registerService?.("a2a.registry", registry);
      ctx.bus.emit("a2a:ready", { agents: registry.discover().length });
      return () => {
        ctx.unregisterTool?.(callTool.name);
        ctx.unregisterTool?.(listTool.name);
      };
    },
  };
}

export function getA2ARegistry(ctx: PluginContext): A2ARegistry | undefined {
  return ctx.getService?.<A2ARegistry>("a2a.registry");
}
