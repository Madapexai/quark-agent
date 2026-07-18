/**
 * ClawHub —— 远端 skill 注册表 + 增量同步
 *
 * 设计（对标 OpenClaw ClawHub + 插件市场）：
 * - 从 registry URL 拉取 skill 清单（JSON）
 * - 每个 skill 含 manifest：id/version/trigger/promptTemplate/tools
 * - 注册为 micro-agent Tool + Skill，agent 命中 trigger 即用
 * - 后台定时增量同步 + 版本锁定
 * - 卸载时停止同步、移除注册
 *
 * 行预算：~200 行
 */

import type { Plugin, Tool, ToolContext, ToolSchema, Skill, SkillStore } from "../core/types.js";

export interface HubSkillManifest {
  id: string;
  version: string;
  name: string;
  trigger: string;
  description?: string;
  promptTemplate: string;
  /** 该 skill 调用时实际执行的工具（若提供则注册为 Tool） */
  executor?: {
    tool: string;
    description: string;
    parameters: Record<string, unknown>;
    /** 执行器：HTTP webhook 或 sandbox 代码 */
    kind: "webhook" | "code";
    endpoint?: string;
    code?: string;
  };
}

export interface ClawHubOptions {
  /** 注册表 URL，返回 { skills: HubSkillManifest[] } */
  registry: string;
  /** 同步间隔 ms，默认 1h */
  syncIntervalMs?: number;
  /** 版本锁定：固定版本的 skill 不被覆盖 */
  pinned?: Record<string, string>;
  /** 可选 SkillStore，把 skill 写入供 match() 命中 */
  skillStore?: SkillStore;
  /** 自定义 fetch（测试用） */
  fetchImpl?: typeof fetch;
}

export function clawHubPlugin(opts: ClawHubOptions): Plugin {
  return {
    name: "clawhub",
    async install(ctx) {
      const fetchFn = opts.fetchImpl ?? fetch;
      const syncInterval = opts.syncIntervalMs ?? 3_600_000;
      const registeredTools = new Set<string>();
      const registeredSkillIds = new Set<string>();

      const sync = async (): Promise<void> => {
        let manifest: HubSkillManifest[];
        try {
          const res = await fetchFn(opts.registry);
          if (!res.ok) return;
          const data = (await res.json()) as { skills?: HubSkillManifest[] };
          manifest = data.skills ?? [];
        } catch {
          return; // 网络错误，下轮重试
        }

        for (const m of manifest) {
          // 版本锁定：pinned 版本不变
          if (opts.pinned && opts.pinned[m.id] && opts.pinned[m.id] !== m.version) continue;
          if (registeredSkillIds.has(m.id)) {
            // 已注册，跳过（增量：仅新增，更新需卸载重装）
            continue;
          }

          // 注册为 Skill（供 SkillStore.match 命中）
          if (opts.skillStore) {
            const skill: Skill = {
              id: `hub.${m.id}`,
              name: m.name,
              trigger: m.trigger,
              promptTemplate: m.promptTemplate,
              score: 0.7, // hub skill 初始分
              invocations: 0,
              lastUsedAt: 0,
              createdAt: Date.now(),
              meta: { version: m.version, source: "clawhub" },
            };
            await opts.skillStore.add(skill).catch(() => undefined);
            registeredSkillIds.add(m.id);
          }

          // 若有 executor，注册为 Tool
          if (m.executor) {
            const toolName = `hub.${m.id}`;
            if (registeredTools.has(toolName)) continue;
            const tool: Tool = {
              name: toolName,
              description: m.executor.description,
              schema: {
                type: "function",
                function: { name: toolName, description: m.executor.description, parameters: m.executor.parameters },
              } as ToolSchema,
              async execute(args: Record<string, unknown>, tc: ToolContext): Promise<string> {
                if (m.executor?.kind === "webhook" && m.executor.endpoint) {
                  try {
                    const r = await fetch(m.executor.endpoint, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(args),
                      signal: AbortSignal.timeout(Math.min(30_000, tc.deadline - Date.now())),
                    });
                    return await r.text();
                  } catch (e) {
                    return `[error] ${e instanceof Error ? e.message : String(e)}`;
                  }
                }
                if (m.executor?.kind === "code" && m.executor.code) {
                  return tc.sandbox.run(m.executor.code, { globals: args }).then((r) =>
                    r.ok ? JSON.stringify(r.value) : `[error] ${r.error}`,
                  );
                }
                return `[error] unknown executor`;
              },
            };
            ctx.registerTool(tool);
            registeredTools.add(toolName);
          }
        }
      };

      await sync();
      const timer = setInterval(() => { void sync().catch(() => undefined); }, syncInterval);

      return () => {
        clearInterval(timer);
        for (const n of registeredTools) ctx.unregisterTool(n);
        // skill 不主动删（由 skillStore evict 管理）
      };
    },
  };
}
