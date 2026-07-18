/**
 * 自动化测试工具：test_run + test_assert
 *
 * 对标 Codex QA agent / Claude Code 的测试能力。
 * - test_run：跑测试命令（npm test / pytest / go test 等），解析 pass/fail/skip
 * - test_assert：运行时断言工具（供 agent 自检）
 * 零依赖：node:child_process
 */

import { execSync } from "node:child_process";
import type { Tool, ToolContext, ToolSchema } from "../core/types.js";

export class TestRunTool implements Tool {
  readonly name = "test_run";
  readonly description = "运行测试命令并解析结果（pass/fail/skip/耗时）。支持 npm test / pytest / go test / 自定义命令。";
  readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: "test_run",
      description: this.description,
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "测试命令，默认 'npm test'" },
          cwd: { type: "string", description: "工作目录，默认当前目录" },
          framework: { type: "string", enum: ["auto", "jest", "mocha", "pytest", "go", "generic"], description: "测试框架，默认 auto 自动识别" },
          timeoutMs: { type: "number", description: "超时毫秒，默认 60000" },
        },
      },
    },
  };

  async execute(args: { command?: string; cwd?: string; framework?: string; timeoutMs?: number }, ctx: ToolContext): Promise<string> {
    const cmd = args.command ?? "npm test";
    const cwd = args.cwd ?? ".";
    const timeout = Math.min(args.timeoutMs ?? 60_000, ctx.deadline - Date.now());
    if (timeout <= 0) return "[error] 已超时";
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    try {
      stdout = execSync(cmd, { cwd, timeout, maxBuffer: 4 * 1024 * 1024, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) ?? "";
    } catch (err) {
      const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; status?: number };
      stdout = typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString() ?? "");
      stderr = typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString() ?? "");
      exitCode = e.status ?? 1;
    }
    const framework = args.framework ?? "auto";
    const result = this.parse(stdout + "\n" + stderr, framework, cmd);
    const status = exitCode === 0 ? "PASS" : "FAIL";
    return `[${status}] exit=${exitCode} ${result.summary}\n\n${result.details.slice(0, 3000)}`;
  }

  private parse(output: string, framework: string, cmd: string): { summary: string; details: string } {
    const fw = framework === "auto" ? this.detect(cmd, output) : framework;
    const lines = output.split("\n");
    let pass = 0, fail = 0, skip = 0;
    switch (fw) {
      case "jest": {
        const m = output.match(/Tests:\s+(\d+)\s+passed.*?(?:(\d+)\s+failed)?.*?(?:(\d+)\s+skipped)?/s)
          ?? output.match(/(\d+)\s+passing.*?(?:(\d+)\s+failing)?/s);
        if (m) { pass = +m[1] || 0; fail = +m[2] || 0; skip = +m[3] || 0; }
        break;
      }
      case "pytest": {
        const m = output.match(/(\d+)\s+passed.*?(?:(\d+)\s+failed)?.*?(?:(\d+)\s+skipped)?/);
        if (m) { pass = +m[1] || 0; fail = +m[2] || 0; skip = +m[3] || 0; }
        break;
      }
      case "go": {
        const m = output.match(/ok\s+\S+\s+[\d.]+s/);
        if (m) pass = 1;
        const fails = output.match(/FAIL\s/g);
        if (fails) fail = fails.length;
        break;
      }
      case "mocha": {
        const m = output.match(/(\d+)\s+passing.*?(?:(\d+)\s+failing)?.*?(?:(\d+)\s+pending)?/s);
        if (m) { pass = +m[1] || 0; fail = +m[2] || 0; skip = +m[3] || 0; }
        break;
      }
      default: {
        // generic：按关键词估算
        pass = (output.match(/\b(pass|passed|passing|ok)\b/gi) ?? []).length;
        fail = (output.match(/\b(fail|failed|failing|error)\b/gi) ?? []).length;
        skip = (output.match(/\b(skip|skipped|pending|ignored)\b/gi) ?? []).length;
      }
    }
    return {
      summary: `${fw}: ${pass} pass / ${fail} fail / ${skip} skip`,
      details: lines.slice(-30).join("\n"),
    };
  }

  private detect(cmd: string, output: string): string {
    if (cmd.includes("pytest") || output.includes("======")) return "pytest";
    if (cmd.includes("go test") || output.includes("RUN  ")) return "go";
    if (output.includes("passing") || output.includes("failing")) return "mocha";
    if (output.includes("Tests:") || output.includes("✓") || output.includes("✗")) return "jest";
    return "generic";
  }
}

export class TestAssertTool implements Tool {
  readonly name = "test_assert";
  readonly description = "运行时断言：检查条件是否成立。用于 agent 自检中间结果。断言失败返回详细错误。";
  readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: "test_assert",
      description: this.description,
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "断言名称" },
          condition: { type: "string", description: "断言条件表达式，如 '1+1 === 2' 或 'result.includes(\"ok\")'" },
          actual: { type: "string", description: "实际值（JSON 字符串），用于失败时展示" },
          expected: { type: "string", description: "期望值描述" },
        },
        required: ["name", "condition"],
      },
    },
  };

  async execute(args: { name: string; condition: string; actual?: string; expected?: string }): Promise<string> {
    let result: unknown;
    try {
      result = eval(args.condition);
    } catch (err) {
      return `[FAIL] ${args.name}: 断言表达式执行出错 - ${err instanceof Error ? err.message : String(err)}`;
    }
    if (result) {
      return `[PASS] ${args.name}: 条件成立`;
    }
    const detail = [
      args.expected ? `期望: ${args.expected}` : "",
      args.actual ? `实际: ${args.actual}` : "",
    ].filter(Boolean).join("\n");
    return `[FAIL] ${args.name}: 条件不成立\n${detail}`;
  }
}
