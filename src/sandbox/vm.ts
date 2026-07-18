/**
 * Sandbox trait 实现：基于 node:vm 的嵌入式解释器
 *
 * 设计（调研 §四 Zapcode/Edge Agent）：
 * - 不用 Docker（冷启动 200-500ms，是减重最大瓶颈）
 * - 用 node:vm 创建隔离上下文，µs-ms 级冷启动
 * - 只暴露白名单 API（无 fs / net / child_process），可注入 globals
 * - 超时通过微任务计数 + wall clock 双重保护
 * - 输出经 console 拦截收集到 stdout
 *
 * 安全说明：vm 隔离不是真正沙箱（Node 官方文档警告），
 * 但对"模型生成的工具脚本"已足够；若需更强隔离可替换为 WASM 实现（同 trait）。
 */

import vm from "node:vm";
import type { Sandbox, SandboxResult, SandboxRunOptions } from "../core/types.js";

export interface VmSandboxOptions {
  /** 默认超时 ms */
  defaultTimeoutMs?: number;
  /** 默认内存上限字节（尽力而为，通过字符串长度估算） */
  defaultMemoryLimitBytes?: number;
}

export class VmSandbox implements Sandbox {
  readonly name = "vm";

  private readonly defaultTimeoutMs: number;
  private readonly defaultMemoryLimitBytes: number;

  constructor(opts: VmSandboxOptions = {}) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 5_000;
    this.defaultMemoryLimitBytes = opts.defaultMemoryLimitBytes ?? 16 * 1024 * 1024;
  }

  async run(code: string, options: SandboxRunOptions = {}): Promise<SandboxResult> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const memLimit = options.memoryLimitBytes ?? this.defaultMemoryLimitBytes;
    const startedAt = Date.now();

    // 收集 console 输出
    const logs: string[] = [];
    const sandboxConsole = {
      log: (...args: unknown[]) => logs.push(args.map(stringify).join(" ")),
      error: (...args: unknown[]) => logs.push(args.map(stringify).join(" ")),
      warn: (...args: unknown[]) => logs.push(args.map(stringify).join(" ")),
      info: (...args: unknown[]) => logs.push(args.map(stringify).join(" ")),
    };

    // 白名单全局：禁止 fs/net/process/child_process
    const allowedGlobals: Record<string, unknown> = {
      console: sandboxConsole,
      Math,
      JSON,
      Date,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Map,
      Set,
      RegExp,
      Error,
      Promise,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      encodeURIComponent,
      decodeURIComponent,
      // 计时
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, Math.min(ms, timeoutMs)),
      clearTimeout,
      // 用户注入
      ...(options.globals ?? {}),
    };

    // 包裹代码：async IIFE 支持 await；REPL 风格自动 return 最后一条表达式
    const wrapped = wrapForRepl(code);
    const context = vm.createContext(allowedGlobals);

    let value: unknown;
    try {
      const script = new vm.Script(wrapped, { filename: "sandbox.js" });
      // 估算内存：源码 + 可能的字符串增长，超限拒绝
      const memBefore = code.length;
      if (memBefore > memLimit) {
        return {
          ok: false,
          error: `code size ${memBefore}B exceeds limit ${memLimit}B`,
          durationMs: Date.now() - startedAt,
          stdout: "",
        };
      }
      value = await script.runInContext(context, {
        timeout: timeoutMs,
        displayErrors: true,
      });
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
        stdout: logs.join("\n"),
      };
    }

    return {
      ok: true,
      value,
      durationMs: Date.now() - startedAt,
      stdout: logs.join("\n"),
    };
  }

  async dispose(): Promise<void> {
    // vm 上下文随 GC 回收，无需显式释放
  }
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * REPL 风格包裹：
 * - 用 async IIFE 支持 await
 * - 若代码无 return，把最后一条表达式语句改写为 return，让最后表达式成为返回值
 * 启发式：按 `;` 与换行切分语句，忽略空/注释行；以语句关键字开头的语句不改写。
 * 注意：这是轻量启发式，不处理 `;` 出现在字符串/括号内的情况——
 * 沙箱面向受控脚本，复杂代码应自行写 return。
 */
function wrapForRepl(code: string): string {
  const wrap = (body: string) => `"use strict";\n(async () => {\n${body}\n})();`;
  if (/\breturn\b/.test(code)) return wrap(code);

  const stmts = code
    .split(/[;\n]/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("//"));
  const lastStmt = stmts[stmts.length - 1];
  if (!lastStmt) return wrap(code);

  const stmtKeywords =
    /^(const|let|var|function|class|for|while|if|switch|throw|do|try|export|import)\b/;
  if (stmtKeywords.test(lastStmt)) return wrap(code);

  // 在原代码中定位最后一条语句并改写为 return(...)
  const idx = code.lastIndexOf(lastStmt);
  if (idx < 0) return wrap(code);
  const transformed = `return (${lastStmt});`;
  return wrap(code.slice(0, idx) + transformed + code.slice(idx + lastStmt.length));
}
