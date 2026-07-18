import type { Plugin, PluginContext, Memory, Scope } from "@micro-agent/core";
import { createInMemoryMemory, InMemoryStore } from "./memory-inmemory.js";

export interface WorkspaceConfig {
  userId: string;
  memoryKind?: "inmemory" | "sqlite";
  dbDir?: string;
  defaultScope?: Scope;
  env?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  createdAt?: number;
  lastActiveAt?: number;
}

export interface Workspace {
  userId: string;
  config: WorkspaceConfig;
  memory: Memory;
  touch(): void;
}

export interface MemoryFactory {
  (config: WorkspaceConfig): Memory | Promise<Memory>;
}

export { InMemoryStore };

export class WorkspaceManager {
  private workspaces = new Map<string, Workspace>();
  private memoryFactory: MemoryFactory;
  private creationLocks = new Map<string, Promise<Workspace>>();

  constructor(opts: { memoryFactory?: MemoryFactory } = {}) {
    this.memoryFactory = opts.memoryFactory ?? (() => createInMemoryMemory());
  }

  async getOrCreate(config: Omit<WorkspaceConfig, "createdAt" | "lastActiveAt">): Promise<Workspace> {
    const existing = this.workspaces.get(config.userId);
    if (existing) {
      existing.touch();
      return existing;
    }
    const pending = this.creationLocks.get(config.userId);
    if (pending) return pending;
    const promise = (async () => {
      const fullConfig: WorkspaceConfig = {
        ...config,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      };
      const memory = await Promise.resolve(this.memoryFactory(fullConfig));
      const ws: Workspace = {
        userId: config.userId,
        config: fullConfig,
        memory,
        touch() { ws.config.lastActiveAt = Date.now(); },
      };
      this.workspaces.set(config.userId, ws);
      return ws;
    })();
    this.creationLocks.set(config.userId, promise);
    try {
      return await promise;
    } finally {
      this.creationLocks.delete(config.userId);
    }
  }

  get(userId: string): Workspace | undefined {
    return this.workspaces.get(userId);
  }

  list(): Workspace[] { return [...this.workspaces.values()]; }

  async remove(userId: string): Promise<void> {
    const ws = this.workspaces.get(userId);
    if (ws) {
      try {
        await ws.memory.close();
      } catch {
      }
      this.workspaces.delete(userId);
    }
  }

  async closeAll(): Promise<void> {
    const values = [...this.workspaces.values()];
    await Promise.allSettled(values.map((ws) => ws.memory.close()));
    this.workspaces.clear();
  }
}

export interface WorkspacePluginOptions {
  memoryFactory?: MemoryFactory;
}

export function workspacePlugin(opts: WorkspacePluginOptions = {}): Plugin {
  return {
    name: "workspace",
    version: "0.1.0",
    dependencies: [],
    install(ctx: PluginContext) {
      const manager = new WorkspaceManager({ memoryFactory: opts.memoryFactory });
      ctx.registerService?.("workspace.manager", manager);

      ctx.registerHook?.("beforeRun", async (hctx) => {
        const userId = hctx.identity?.userId;
        if (!userId) return;
        const ws = await manager.getOrCreate({ userId, defaultScope: ctx.scope });
        ws.touch();
      });

      ctx.bus.emit("workspace:ready", { manager });
      return () => manager.closeAll();
    },
  };
}

export function getWorkspaceManager(ctx: PluginContext): WorkspaceManager | undefined {
  return ctx.getService?.<WorkspaceManager>("workspace.manager");
}
