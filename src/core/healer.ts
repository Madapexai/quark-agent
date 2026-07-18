/**
 * SelfHealer —— 自主问题解决：tool 失败时像人一样诊断+修复，不问 LLM/用户
 *
 * 像人解决问题的流程：
 * 1. 看错误信息 → 判断错误类型（网络/超时/参数/权限/未知）
 * 2. 按类型尝试常见修复（重试/补协议/修语法/换参数）
 * 3. 修不了才返回错误并附诊断，不反复问用户
 */

import type { ToolCall } from "./types.js";

export type ErrorKind = "timeout" | "network" | "auth" | "args" | "unknown";

/** 诊断错误类型：关键词匹配，像人扫一眼错误信息 */
export function diagnoseError(msg: string): ErrorKind {
  const m = msg.toLowerCase();
  if (/timeout|timed out|abort/.test(m)) return "timeout";
  if (/econnrefused|enotfound|fetch failed|socket|network|hang up/.test(m)) return "network";
  if (/denied|forbidden|unauthorized|401|403/.test(m)) return "auth";
  if (/invalid|bad|参数|json|parse|syntax|type|undefined|nan/.test(m)) return "args";
  return "unknown";
}

export interface HealResult {
  /** 修复后的 call，null 表示无法自动修复 */
  retryCall: ToolCall | null;
  /** 诊断说明（供 tracer 记录） */
  diagnosis: string;
}

export class SelfHealer {
  /** 同一 call 签名的累计重试次数，防死循环 */
  private tries = new Map<string, number>();

  constructor(private readonly maxRetries = 2) {}

  /** 每次 agent run 开始时重置 */
  reset(): void {
    this.tries.clear();
  }

  /** 诊断 + 尝试修复，返回修复后的 call 或 null */
  heal(call: ToolCall, lastResult: string): HealResult {
    const sig = `${call.name}:${call.arguments}`;
    const n = this.tries.get(sig) ?? 0;
    if (n >= this.maxRetries) {
      return { retryCall: null, diagnosis: `已重试 ${n} 次仍失败，放弃` };
    }
    this.tries.set(sig, n + 1);
    const kind = diagnoseError(lastResult);
    const fixed = this.fix(call, kind, lastResult);
    return {
      retryCall: fixed,
      diagnosis: fixed ? `诊断:${kind} 已自修复重试` : `诊断:${kind} 无法自动修复`,
    };
  }

  private fix(call: ToolCall, kind: ErrorKind, result: string): ToolCall | null {
    // 瞬态错误（网络/超时）直接重试一次，像人刷新页面
    if (kind === "timeout" || kind === "network") return call;
    // 权限错无法自动修，让上层降级
    if (kind === "auth") return null;
    if (kind !== "args") return null;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.arguments || "{}");
    } catch {
      return null;
    }
    // http_get：URL 缺协议 → 补 https://
    if (call.name === "http_get" && typeof args.url === "string" && !/^https?:/i.test(args.url)) {
      args.url = "https://" + args.url.replace(/^\/+/, "");
      return this.rebuild(call, args);
    }
    // code_exec：语法错 → 去 trailing comma、去报错行注释
    if (call.name === "code_exec" && typeof args.code === "string") {
      const code = this.fixCode(args.code, result);
      if (code !== args.code) {
        args.code = code;
        return this.rebuild(call, args);
      }
    }
    return null;
  }

  private fixCode(code: string, error: string): string {
    let fixed = code.replace(/,(\s*[}\]])/g, "$1"); // 去 trailing comma
    const lm = error.match(/line (\d+)/i);
    if (lm) {
      const lines = fixed.split("\n");
      const ln = parseInt(lm[1]) - 1;
      if (ln >= 0 && ln < lines.length) lines[ln] = lines[ln].replace(/\/\/.*$/, "");
      fixed = lines.join("\n");
    }
    return fixed;
  }

  private rebuild(call: ToolCall, args: Record<string, unknown>): ToolCall {
    return { id: `heal-${Date.now().toString(36)}`, name: call.name, arguments: JSON.stringify(args) };
  }
}
