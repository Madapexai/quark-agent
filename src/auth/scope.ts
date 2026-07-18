/**
 * Scope 授权执行器
 *
 * 三层过滤：
 * 1. 工具白名单：Agent 调用工具前 check
 * 2. 沙箱 tier：lightweight 禁止 IO 类全局，full 放开
 * 3. 模型上限：requested model 不得超出 scope.models
 * 4. 记忆域：memory.search 按 scope.memoryDomains 过滤
 */

import type { Scope, ToolSchema, SandboxTier } from "../core/types.js";

/** 校验工具是否在 scope 白名单内 */
export function canUseTool(scope: Scope, toolName: string): boolean {
  if (scope.tools === "*") return true;
  return scope.tools.includes(toolName);
}

/** 过滤工具 schema 表，仅保留 scope 允许的工具 */
export function filterTools(scope: Scope, tools: ToolSchema[]): ToolSchema[] {
  if (scope.tools === "*") return tools;
  const allowed = new Set(scope.tools);
  return tools.filter((t) => allowed.has(t.function.name));
}

/** 校验模型是否在 scope 允许范围内 */
export function canUseModel(scope: Scope, model: string): boolean {
  if (scope.models.length === 0) return true;
  if (scope.models.includes("*")) return true;
  return scope.models.includes(model);
}

/** 选择允许的模型（取兜底或首个允许项） */
export function pickModel(scope: Scope, requested: string, fallback: string): string {
  if (canUseModel(scope, requested)) return requested;
  if (scope.models.length > 0 && !scope.models.includes("*")) return scope.models[0];
  return fallback;
}

/** 校验记忆域是否可读 */
export function canReadDomain(scope: Scope, domain: string | undefined): boolean {
  if (scope.memoryDomains === "*") return true;
  if (!domain) return true; // 无域标记的记忆默认可读
  return scope.memoryDomains.includes(domain);
}

/** 沙箱 tier 比较：full > lightweight > none */
const TIER_RANK: Record<SandboxTier, number> = { none: 0, lightweight: 1, full: 2 };

/** 当前 scope 的沙箱等级是否 >= 要求的 tier */
export function sandboxTierSatisfies(scope: Scope, required: SandboxTier): boolean {
  return TIER_RANK[scope.sandboxTier] >= TIER_RANK[required];
}

/** lightweight tier 下应移除的全局（IO 类） */
const IO_GLOBALS = new Set(["fetch", "XMLHttpRequest", "setTimeout"]);

/** 按 sandboxTier 过滤可注入的全局变量名 */
export function filterSandboxGlobals(scope: Scope, requested: string[]): string[] {
  if (scope.sandboxTier === "full") {
    // full 受 scope.sandboxGlobals 白名单约束
    if (scope.sandboxGlobals.length === 0) return requested;
    const allowed = new Set(scope.sandboxGlobals);
    return requested.filter((g) => allowed.has(g));
  }
  if (scope.sandboxTier === "lightweight") {
    // lightweight：移除所有 IO 类全局，再过白名单
    const base = requested.filter((g) => !IO_GLOBALS.has(g));
    if (scope.sandboxGlobals.length === 0) return base;
    const allowed = new Set(scope.sandboxGlobals);
    return base.filter((g) => allowed.has(g));
  }
  // none：不允许任何全局
  return [];
}

/** 授权失败错误 */
export class AuthError extends Error {
  constructor(
    public readonly code: "tool_denied" | "model_denied" | "sandbox_denied" | "domain_denied",
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}
