/**
 * @micro-agent/core —— Plugin 注册表
 *
 * 增强特性：
 * 1. 依赖声明：插件可声明依赖其他插件，按拓扑序安装
 * 2. 服务注册：插件可 registerService 供其他插件 getService 取用
 * 3. Hook 批量分发：runHook 等待所有 hook 完成
 * 4. 优雅卸载：cleanup 按安装逆序执行
 */

import type { Plugin, PluginContext, HookPoint, HookFn, HookContext, Tool, Provider, Cleanup, EventBusLike, Memory, Scope } from "./types.js";
import { EventBus } from "./event-bus.js";

export interface PluginRegistryOptions {
  bus?: EventBusLike;
  memory: Memory;
  scope: Scope;
  spawn?: PluginContext["spawn"];
}

export class PluginRegistry {
  private plugins = new Map<string, Plugin>();
  private cleanups = new Map<string, Cleanup>();
  private hooks = new Map<HookPoint, Set<HookFn>>();
  private tools = new Map<string, Tool>();
  private providers = new Map<string, Provider>();
  private services = new Map<string, unknown>();
  private installed = false;
  private disposed = false;
  private bus: EventBusLike;
  private memory: Memory;
  private scope: Scope;
  private spawn?: PluginContext["spawn"];

  constructor(opts: PluginRegistryOptions) {
    this.bus = opts.bus ?? new EventBus();
    this.memory = opts.memory;
    this.scope = opts.scope;
    this.spawn = opts.spawn;
  }

  /** 注册插件（延迟到 installAll 时执行安装） */
  register(plugin: Plugin): void {
    if (this.disposed) {
      throw new Error("PluginRegistry has been disposed");
    }
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin already registered: ${plugin.name}`);
    }
    if (this.installed) {
      throw new Error(`Cannot register plugin ${plugin.name} after installAll() has been called`);
    }
    this.plugins.set(plugin.name, plugin);
  }

  /** 批量注册 */
  registerAll(plugins: Plugin[]): void {
    for (const p of plugins) this.register(p);
  }

  /** 按拓扑序安装所有插件 */
  async installAll(): Promise<void> {
    if (this.installed) return;
    this.installed = true;

    const order = this.topologicalSort();
    for (const name of order) {
      const plugin = this.plugins.get(name)!;
      const ctx = this.createContext(plugin);
      const cleanup = await plugin.install(ctx);
      if (cleanup) this.cleanups.set(name, cleanup);
    }
  }

  /** 运行某个 hook 点，等待所有监听器 */
  async runHook(point: HookPoint, ctx: HookContext): Promise<void> {
    const set = this.hooks.get(point);
    if (!set) return;
    for (const fn of set) {
      try { await fn(ctx); } catch (err) { this.bus.emit("plugin:hookError", { point, error: err }); }
    }
  }

  /** 同步运行 hook（不等待） */
  runHookSync(point: HookPoint, ctx: HookContext): void {
    const set = this.hooks.get(point);
    if (!set) return;
    for (const fn of set) {
      try {
        Promise.resolve(fn(ctx)).catch((err) => {
          this.bus.emit("plugin:hookError", { point, error: err });
        });
      } catch (err) {
        this.bus.emit("plugin:hookError", { point, error: err });
      }
    }
  }

  /** 获取所有已注册工具 */
  getTools(): Map<string, Tool> {
    return new Map(this.tools);
  }

  /** 获取所有已注册 Provider */
  getProviders(): Map<string, Provider> {
    return new Map(this.providers);
  }

  /** 获取事件总线 */
  getBus(): EventBusLike {
    return this.bus;
  }

  /** 获取已注册服务（插件间通信） */
  getService<T = unknown>(name: string): T | undefined {
    return this.services.get(name) as T | undefined;
  }

  /** 卸载所有插件（逆序） */
  async uninstallAll(): Promise<void> {
    const names = [...this.cleanups.keys()].reverse();
    for (const name of names) {
      const cleanup = this.cleanups.get(name);
      if (cleanup) {
        try { await cleanup(); } catch { /* ignore */ }
      }
      this.cleanups.delete(name);
    }
    this.tools.clear();
    this.providers.clear();
    this.hooks.clear();
    this.services.clear();
    this.plugins.clear();
    this.installed = false;
    this.disposed = true;
  }

  // ---- 内部 ----

  private createContext(plugin: Plugin): PluginContext {
    const self = this;
    return {
      bus: this.bus,
      memory: this.memory,
      scope: this.scope,
      spawn: this.spawn,
      registerTool(t: Tool) {
        self.tools.set(t.name, t);
        self.bus.emit("tool:registered", { name: t.name, plugin: plugin.name });
      },
      unregisterTool(name: string) {
        self.tools.delete(name);
      },
      registerProvider(p: Provider) {
        self.providers.set(p.name, p);
      },
      registerHook(hook: HookPoint, fn: HookFn) {
        if (!self.hooks.has(hook)) self.hooks.set(hook, new Set());
        self.hooks.get(hook)!.add(fn);
      },
      registerService(name: string, service: unknown) {
        self.services.set(name, service);
      },
      getService<T = unknown>(name: string): T | undefined {
        return self.services.get(name) as T | undefined;
      },
      meta: { pluginName: plugin.name },
    };
  }

  private topologicalSort(): string[] {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const order: string[] = [];

    const visit = (name: string) => {
      if (visited.has(name)) return;
      if (visiting.has(name)) throw new Error(`Circular plugin dependency: ${name}`);
      visiting.add(name);
      const plugin = this.plugins.get(name);
      if (plugin?.dependencies) {
        for (const dep of plugin.dependencies) {
          if (!this.plugins.has(dep)) {
            throw new Error(`Plugin ${name} depends on missing plugin: ${dep}`);
          }
          visit(dep);
        }
      }
      visiting.delete(name);
      visited.add(name);
      order.push(name);
    };

    for (const name of this.plugins.keys()) visit(name);
    return order;
  }
}
