import type {
  Plugin, PluginContext, Tool, ToolSchema, ToolContext,
} from "@micro-agent/core";

export type ActionCaller = "tool" | "http" | "cli" | "mcp" | "a2a" | "internal";

export interface ActionContext {
  caller: ActionCaller;
  userId?: string;
  sessionId?: string;
  meta?: Record<string, unknown>;
  tool: ToolContext;
}

export interface ActionDefinition<TInput = Record<string, unknown>, TOutput = unknown> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (input: TInput, ctx: ActionContext) => Promise<TOutput> | TOutput;
  expose?: ActionCaller[];
  http?: { method?: "GET" | "POST" | "PUT" | "DELETE"; path?: string };
  cli?: { command?: string; aliases?: string[] };
}

export interface RegisteredAction {
  def: ActionDefinition;
  tool: Tool;
  invoke(input: Record<string, unknown>, ctx: Omit<ActionContext, "tool">, toolCtx: ToolContext): Promise<string>;
}

const ACTION_NAME_RE = /^[a-zA-Z0-9_.\/-]+$/;

function validateActionName(name: string): void {
  if (!ACTION_NAME_RE.test(name)) {
    throw new Error(`Invalid action name: ${name} (allowed: a-zA-Z0-9_./-)`);
  }
}

async function runAction<TInput, TOutput>(
  def: ActionDefinition<TInput, TOutput>,
  input: TInput,
  actionCtx: ActionContext,
): Promise<string> {
  try {
    const result = await Promise.resolve(def.run(input, actionCtx));
    if (typeof result === "string") return result;
    try {
      return JSON.stringify(result);
    } catch {
      return "[error: failed to serialize result]";
    }
  } catch (err) {
    return `[error] Action '${def.name}' failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export class ActionRegistry {
  private actions = new Map<string, RegisteredAction>();

  register<TInput, TOutput>(def: ActionDefinition<TInput, TOutput>): RegisteredAction {
    validateActionName(def.name);
    if (this.actions.has(def.name)) {
      throw new Error(`Action already registered: ${def.name}`);
    }
    const baseDef = def as ActionDefinition;
    const tool = actionToTool(def, (input, actionCtx) => runAction(def, input, actionCtx));
    const registered: RegisteredAction = {
      def: baseDef,
      tool,
      invoke: async (input, ctx, toolCtx) => {
        const actionCtx: ActionContext = {
          caller: ctx.caller,
          userId: ctx.userId,
          sessionId: ctx.sessionId,
          meta: ctx.meta,
          tool: toolCtx,
        };
        return runAction(def, input as TInput, actionCtx);
      },
    };
    this.actions.set(def.name, registered);
    return registered;
  }

  get(name: string): RegisteredAction | undefined {
    return this.actions.get(name);
  }

  list(): RegisteredAction[] {
    return [...this.actions.values()];
  }

  listFor(caller: ActionCaller): RegisteredAction[] {
    return this.list().filter((a) => !a.def.expose || a.def.expose.includes(caller));
  }

  unregister(name: string): boolean {
    return this.actions.delete(name);
  }

  getHttpRoutes(): Array<{ method: string; path: string; action: RegisteredAction }> {
    return this.listFor("http").map((a) => ({
      method: a.def.http?.method ?? "POST",
      path: a.def.http?.path ?? `/api/actions/${a.def.name}`,
      action: a,
    }));
  }

  getCliCommands(): Array<{ command: string; aliases: string[]; action: RegisteredAction }> {
    return this.listFor("cli").map((a) => ({
      command: a.def.cli?.command ?? a.def.name,
      aliases: a.def.cli?.aliases ?? [],
      action: a,
    }));
  }
}

function actionToTool<TInput, TOutput>(
  def: ActionDefinition<TInput, TOutput>,
  run: (input: TInput, ctx: ActionContext) => Promise<string>,
): Tool {
  const schema: ToolSchema = {
    type: "function",
    function: { name: def.name, description: def.description, parameters: def.parameters },
  };
  return {
    name: def.name,
    description: def.description,
    schema,
    async execute(args: Record<string, unknown>, toolCtx: ToolContext): Promise<string> {
      const identity = (toolCtx.meta as Record<string, unknown> | undefined)?.identity as
        | { userId?: string; sessionId?: string }
        | undefined;
      const actionCtx: ActionContext = {
        caller: "tool",
        userId: identity?.userId,
        sessionId: identity?.sessionId,
        meta: toolCtx.meta,
        tool: toolCtx,
      };
      return run(args as TInput, actionCtx);
    },
  };
}

export interface DefineActionPluginApi {
  defineAction<TInput, TOutput>(def: ActionDefinition<TInput, TOutput>): RegisteredAction;
  getRegistry(): ActionRegistry;
}

export function defineActionPlugin(): Plugin {
  return {
    name: "defineAction",
    version: "0.1.0",
    dependencies: [],
    install(ctx: PluginContext) {
      const registry = new ActionRegistry();
      const registeredToolNames: string[] = [];

      const api: DefineActionPluginApi = {
        defineAction<TInput, TOutput>(def: ActionDefinition<TInput, TOutput>): RegisteredAction {
          const registered = registry.register(def);
          const exposedCallers = def.expose ?? ["tool"];
          if (exposedCallers.includes("tool")) {
            ctx.registerTool?.(registered.tool);
            registeredToolNames.push(def.name);
          }
          ctx.bus.emit("action:registered", { name: def.name, expose: exposedCallers });
          ctx.bus.emit("action:expose", {
            name: def.name,
            expose: exposedCallers,
            http: def.http,
            cli: def.cli,
          });
          return registered;
        },
        getRegistry: () => registry,
      };

      ctx.registerService?.("action.registry", api);
      ctx.bus.emit("defineAction:ready", { api });

      return () => {
        for (const name of registeredToolNames) {
          ctx.unregisterTool?.(name);
        }
        registeredToolNames.length = 0;
      };
    },
  };
}

export function getActionApi(ctx: PluginContext): DefineActionPluginApi | undefined {
  return ctx.getService?.<DefineActionPluginApi>("action.registry");
}

export function defineAction<TInput = Record<string, unknown>, TOutput = unknown>(
  def: ActionDefinition<TInput, TOutput>,
): ActionDefinition<TInput, TOutput> {
  return def;
}
