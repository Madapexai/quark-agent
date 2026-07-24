import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type NodeType = "input" | "llm" | "tool" | "condition" | "output" | "delay" | "code";

export interface WorkflowNode {
  id: string;
  type: NodeType;
  name: string;
  config: {
    prompt?: string;           // for llm nodes
    toolName?: string;         // for tool nodes
    toolArgs?: Record<string, unknown>;
    condition?: string;        // for condition nodes (JS expression)
    trueBranch?: string;       // next node id if true
    falseBranch?: string;      // next node id if false
    code?: string;             // for code nodes (sandboxed JS)
    delayMs?: number;          // for delay nodes
    model?: string;            // model override for llm nodes
    outputFormat?: "text" | "json" | "markdown";
  };
  position: { x: number; y: number };  // for visual editor
}

export interface WorkflowEdge {
  from: string;
  to: string;
  label?: string;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  input: string;  // default input variable name
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowRunResult {
  workflowId: string;
  success: boolean;
  outputs: Record<string, unknown>;
  steps: { nodeId: string; nodeName: string; output: unknown; duration: number; success: boolean }[];
  error?: string;
  totalDuration: number;
}

export class WorkflowEngine {
  private workflows: Map<string, Workflow> = new Map();
  private dbPath: string;
  private llmRunner: ((prompt: string, context: Record<string, unknown>, model?: string) => Promise<string>) | null = null;
  private toolRunner: ((name: string, args: Record<string, unknown>) => Promise<unknown>) | null = null;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? join(process.cwd(), ".data", "workflows.json");
    mkdirSync(join(this.dbPath, ".."), { recursive: true });
    this.load();
  }

  setLLMRunner(runner: (prompt: string, context: Record<string, unknown>, model?: string) => Promise<string>): void {
    this.llmRunner = runner;
  }

  setToolRunner(runner: (name: string, args: Record<string, unknown>) => Promise<unknown>): void {
    this.toolRunner = runner;
  }

  createWorkflow(name: string, description: string): Workflow {
    const wf: Workflow = {
      id: randomUUID(), name, description,
      nodes: [], edges: [], input: "input",
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    this.workflows.set(wf.id, wf);
    this.save();
    return wf;
  }

  getWorkflow(id: string): Workflow | undefined {
    return this.workflows.get(id);
  }

  listWorkflows(): { id: string; name: string; description: string; nodeCount: number; updatedAt: number }[] {
    return Array.from(this.workflows.values()).map(w => ({
      id: w.id, name: w.name, description: w.description,
      nodeCount: w.nodes.length, updatedAt: w.updatedAt,
    }));
  }

  updateWorkflow(id: string, updates: Partial<Omit<Workflow, "id" | "createdAt">>): boolean {
    const wf = this.workflows.get(id);
    if (!wf) return false;
    Object.assign(wf, updates, { updatedAt: Date.now() });
    this.save();
    return true;
  }

  deleteWorkflow(id: string): boolean {
    const deleted = this.workflows.delete(id);
    if (deleted) this.save();
    return deleted;
  }

  addNode(workflowId: string, node: Omit<WorkflowNode, "id">): WorkflowNode | null {
    const wf = this.workflows.get(workflowId);
    if (!wf) return null;
    const fullNode: WorkflowNode = { ...node, id: randomUUID() };
    wf.nodes.push(fullNode);
    wf.updatedAt = Date.now();
    this.save();
    return fullNode;
  }

  addEdge(workflowId: string, edge: WorkflowEdge): boolean {
    const wf = this.workflows.get(workflowId);
    if (!wf) return false;
    wf.edges.push(edge);
    wf.updatedAt = Date.now();
    this.save();
    return true;
  }

  /** Execute a workflow with given input */
  async run(workflowId: string, input: string): Promise<WorkflowRunResult> {
    const wf = this.workflows.get(workflowId);
    if (!wf) return { workflowId, success: false, outputs: {}, steps: [], error: "Workflow not found", totalDuration: 0 };

    const start = Date.now();
    const context: Record<string, unknown> = { [wf.input]: input };
    const steps: WorkflowRunResult["steps"] = [];

    // Find input node
    let currentNode = wf.nodes.find(n => n.type === "input");
    if (!currentNode) return { workflowId, success: false, outputs: context, steps, error: "No input node", totalDuration: 0 };

    const visited = new Set<string>();
    while (currentNode && !visited.has(currentNode.id)) {
      // Capture as const so narrowing survives await / inner try-catch in CFA
      const node: WorkflowNode = currentNode;
      visited.add(node.id);
      const stepStart = Date.now();
      let output: unknown;
      let success = true;
      let nextId: string | undefined;

      try {
        switch (node.type) {
          case "input":
            output = context[wf.input];
            break;
          case "llm":
            if (!this.llmRunner) throw new Error("No LLM runner configured");
            output = await this.llmRunner(
              node.config.prompt ?? "${input}",
              context,
              node.config.model,
            );
            break;
          case "tool":
            if (!this.toolRunner) throw new Error("No tool runner configured");
            output = await this.toolRunner(
              node.config.toolName ?? "unknown",
              node.config.toolArgs ?? {},
            );
            break;
          case "condition":
            // Simple eval — in production use sandboxed vm
            try {
              const fn = new Function("context", "return " + (node.config.condition ?? "false"));
              const result = fn(context);
              nextId = result ? node.config.trueBranch : node.config.falseBranch;
              output = result;
            } catch {
              output = false;
              nextId = node.config.falseBranch;
            }
            break;
          case "code":
            try {
              const fn = new Function("context", node.config.code ?? "return null;");
              output = fn(context);
            } catch (err) {
              output = { error: err instanceof Error ? err.message : String(err) };
              success = false;
            }
            break;
          case "delay":
            await new Promise(r => setTimeout(r, node.config.delayMs ?? 1000));
            output = null;
            break;
          case "output":
            output = node.config.outputFormat === "json"
              ? JSON.stringify(context, null, 2)
              : String(context[node.name] ?? "");
            break;
        }
        context[node.name] = output;
        steps.push({ nodeId: node.id, nodeName: node.name, output, duration: Date.now() - stepStart, success });
      } catch (err) {
        success = false;
        steps.push({ nodeId: node.id, nodeName: node.name, output: null, duration: Date.now() - stepStart, success });
        return { workflowId, success: false, outputs: context, steps, error: err instanceof Error ? err.message : String(err), totalDuration: Date.now() - start };
      }

      // Find next node
      if (!nextId) {
        const edge: WorkflowEdge | undefined = wf.edges.find(e => e.from === node.id);
        nextId = edge?.to;
      }
      currentNode = wf.nodes.find(n => n.id === nextId);
    }

    return { workflowId, success: true, outputs: context, steps, totalDuration: Date.now() - start };
  }

  private save(): void {
    writeFileSync(this.dbPath, JSON.stringify({ workflows: Array.from(this.workflows.values()) }), "utf8");
  }

  private load(): void {
    try {
      const raw = readFileSync(this.dbPath, "utf8");
      const data = JSON.parse(raw);
      for (const wf of data.workflows ?? []) {
        this.workflows.set(wf.id, wf);
      }
    } catch { /* first run */ }
  }
}

export const workflowEngine = new WorkflowEngine();
