/**
 * Plugin Registry —— 唯一扩展点
 *
 * 设计（对标 Claude Code 的可插拔 + Hermes trait）：
 * - 所有扩展（MCP / Hub / 自定义工具 / Hook）都走 Plugin 接口
 * - 运行时可动态 install/uninstall（拔插）
 * - Hook 链按注册顺序执行，可修改 mutable 状态
 * - 工具表与 hook 表统一管理，避免散落
 *
 * 行预算：~140 行
 */

import type {
  Cleanup,
  HookContext,
  HookFn,
  HookPoint,
  Memory,
  Plugin,
  PluginContext,
  Provider,
  Scope,
  Tool,
  Tracer,
} from "../core/types.js";

export interface PluginRegistryOptions {
  memory: Memory;
  tracer: Tracer;
  /** 工具表（与 agent 共享） */
  tools: Map<string, Tool>;
  /** provider 列表（可被 plugin 追加） */
  providers?: Provider[];
  /** 子 agent 派发器 */
  spawn?: (opts: { tools?: string[]; scope?: Scope }) => { run(text: string): Promise<string> };
}

export class PluginRegistry {
  private plugins = new Map<string, { plugin: Plugin; cleanup?: Cleanup }>();
  private hooks = new Map<HookPoint, HookFn[]>();
  private readonly tools: Map<string, Tool>;
  private readonly providers: Provider[];
  private readonly opts: PluginRegistryOptions;

  constructor(opts: PluginRegistryOptions) {
    this.opts = opts;
    this.tools = opts.tools;
    this.providers = opts.providers ?? [];
  }

  /** 安装一个 plugin（可拔插） */
  async install(plugin: Plugin): Promise<void> {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`plugin "${plugin.name}" 已安装`);
    }
    const ctx: PluginContext = {
      registerTool: (t: Tool) => this.tools.set(t.name, t),
      unregisterTool: (name: string) => { this.tools.delete(name); },
      registerHook: (hook: HookPoint, fn: HookFn) => {
        const arr = this.hooks.get(hook) ?? [];
        arr.push(fn);
        this.hooks.set(hook, arr);
      },
      registerProvider: (p: Provider) => this.providers.push(p),
      spawn: this.opts.spawn,
      memory: this.opts.memory,
      tracer: this.opts.tracer,
    };
    const cleanup = await plugin.install(ctx);
    this.plugins.set(plugin.name, { plugin, cleanup });
  }

  /** 卸载一个 plugin */
  async uninstall(name: string): Promise<void> {
    const entry = this.plugins.get(name);
    if (!entry) return;
    if (entry.cleanup) await entry.cleanup();
    this.plugins.delete(name);
    // 移除该 plugin 注册的 hook（通过 plugin 名标记，简化实现：全清同 hook point 不现实，
    // 这里要求 plugin 在 cleanup 里自行移除，registry 不追踪 hook 归属）
  }

  list(): string[] {
    return [...this.plugins.keys()];
  }

  has(name: string): boolean {
    return this.plugins.has(name);
  }

  /** 触发某个 hook point，串行执行所有注册的 fn */
  async runHook(point: HookPoint, ctx: HookContext): Promise<void> {
    const arr = this.hooks.get(point);
    if (!arr || arr.length === 0) return;
    for (const fn of arr) {
      try {
        await fn(ctx);
      } catch {
        // hook 失败不影响主流程
      }
    }
  }

  /** 获取所有已注册工具（含 plugin 注册的） */
  getTools(): Map<string, Tool> {
    return this.tools;
  }

  getProviders(): Provider[] {
    return this.providers;
  }

  /** 卸载所有 plugin */
  async close(): Promise<void> {
    for (const [name] of [...this.plugins]) {
      await this.uninstall(name);
    }
  }
}
