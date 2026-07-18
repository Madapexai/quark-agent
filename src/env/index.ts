/**
 * Env 收集器：运行环境信息
 *
 * 组装上下文第 2 层。包含时间/时区/平台/身份/权限/scope。
 * 跨轮稳定（除时间），利于 prefix caching。
 */

import type { EnvInfo, Identity, Scope } from "../core/types.js";

export interface CollectEnvOptions {
  /** 自定义环境变量 */
  custom?: Record<string, unknown>;
  /** 时区覆盖 */
  timezone?: string;
}

/** 默认全权 scope（开发态兜底，生产应按用户注入） */
export function fullScope(): Scope {
  return {
    tools: "*",
    sandboxTier: "full",
    sandboxGlobals: ["Math", "JSON", "Date", "Array", "Object", "String", "Number", "Boolean", "Map", "Set", "RegExp", "Error", "Promise"],
    models: ["*"],
    memoryDomains: "*",
  };
}

/** 轻量 scope：仅计算工具，沙箱 lightweight，无 http_get */
export function lightweightScope(): Scope {
  return {
    tools: ["code_exec", "memory_recall"],
    sandboxTier: "lightweight",
    sandboxGlobals: ["Math", "JSON", "Date", "Array", "Object", "String", "Number", "Boolean"],
    models: ["*"],
    memoryDomains: "*",
  };
}

/** 只读 scope：无沙箱、无写工具 */
export function readOnlyScope(): Scope {
  return {
    tools: ["memory_recall"],
    sandboxTier: "none",
    sandboxGlobals: [],
    models: ["*"],
    memoryDomains: "*",
  };
}

/** 收集当前运行环境信息 */
export function collectEnv(
  identity: Identity,
  scope: Scope,
  opts: CollectEnvOptions = {},
): EnvInfo {
  return {
    now: new Date().toISOString(),
    timezone: opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    platform: typeof process !== "undefined" ? process.platform : "unknown",
    nodeVersion: typeof process !== "undefined" ? process.version : "unknown",
    cwd: typeof process !== "undefined" ? process.cwd() : "/",
    userId: identity.userId,
    sessionId: identity.sessionId,
    channel: identity.channel,
    scope,
    custom: opts.custom ?? {},
  };
}

/** 把 EnvInfo 渲染成上下文片段 */
export function renderEnv(env: EnvInfo): string {
  const lines = [
    `[环境]`,
    `时间: ${env.now} (${env.timezone})`,
    `平台: ${env.platform} / ${env.nodeVersion}`,
    `用户: ${env.userId} | 会话: ${env.sessionId}${env.channel ? ` | 通道: ${env.channel}` : ""}`,
    `权限: tools=${Array.isArray(env.scope.tools) ? env.scope.tools.join(",") : env.scope.tools} sandbox=${env.scope.sandboxTier}`,
  ];
  for (const [k, v] of Object.entries(env.custom)) {
    lines.push(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  return lines.join("\n");
}
