/**
 * 内置 Plugin：log / metric / loop-guard / skill-sediment-hook
 *
 * 设计：作为 plugin 系统的示例 + 实用功能，每个 <40 行
 */

import type { Plugin, HookContext } from "../core/types.js";

/** 日志 plugin：记录每次 run/tool 调用 */
export function logPlugin(onLog: (line: string) => void): Plugin {
  return {
    name: "log",
    async install(ctx) {
      const log = (point: string, msg: string) => onLog(`[${new Date().toISOString()}] ${point}: ${msg}`);
      ctx.registerHook("beforeRun", (c: HookContext) => log("beforeRun", `${c.identity.userId}/${c.identity.sessionId}`));
      ctx.registerHook("afterRun", (c: HookContext) => log("afterRun", `rounds=${c.run?.rounds} toolCalls=${c.run?.toolCalls}`));
      ctx.registerHook("beforeTool", (c: HookContext) => log("beforeTool", c.toolCall?.name ?? ""));
      ctx.registerHook("afterTool", (c: HookContext) => log("afterTool", `${c.toolCall?.name} → ${(c.toolResult ?? "").slice(0, 80)}`));
      return () => undefined;
    },
  };
}

/** 指标 plugin：累计 run 数、tool 数、错误数 */
export function metricPlugin(onMetric?: (m: Record<string, number>) => void): Plugin {
  return {
    name: "metric",
    async install(ctx) {
      const m = { runs: 0, toolCalls: 0, errors: 0, tokensIn: 0, tokensOut: 0 };
      ctx.registerHook("afterRun", (c: HookContext) => {
        m.runs++;
        m.toolCalls += c.run?.toolCalls ?? 0;
        onMetric?.({ ...m });
      });
      ctx.registerHook("afterTool", (c: HookContext) => {
        if ((c.toolResult ?? "").startsWith("[error]") || (c.toolResult ?? "").startsWith("[denied")) m.errors++;
      });
      return () => undefined;
    },
  };
}

/** 循环守护 plugin：单 run 内同工具调用超过阈值则注入提示 */
export function loopGuardPlugin(threshold = 5): Plugin {
  return {
    name: "loop-guard",
    async install(ctx) {
      const counts = new Map<string, number>();
      ctx.registerHook("beforeRun", () => counts.clear());
      ctx.registerHook("beforeTool", (c: HookContext) => {
        const name = c.toolCall?.name;
        if (!name) return;
        const n = (counts.get(name) ?? 0) + 1;
        counts.set(name, n);
        if (n >= threshold && c.mutable) {
          // 通过 mutable 注入提示到 toolResult（afterTool 时会被读取）
          c.mutable.toolResult = `[loop-guard] 工具 ${name} 本次已调用 ${n} 次，请考虑换方案`;
        }
      });
      return () => counts.clear();
    },
  };
}

/** 反馈收集 plugin：从消息中识别 thumbs up/down，供 skill 评分用 */
export function feedbackPlugin(onFeedback: (skillId: string, delta: number) => void): Plugin {
  return {
    name: "feedback",
    async install(ctx) {
      ctx.registerHook("onMessage", (c: HookContext) => {
        const text = c.mutable?.userText ?? "";
        const m = text.match(/\/(good|bad)\s+(\S+)/i);
        if (!m) return;
        const delta = m[1].toLowerCase() === "good" ? 1 : -1;
        onFeedback(m[2], delta);
      });
      return () => undefined;
    },
  };
}
