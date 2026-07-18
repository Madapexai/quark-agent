/**
 * 文件系统工具：glob / grep / ls / bash
 *
 * 对标 Claude Code 的 Glob+Grep+Bash、Codex 的 list+shell。
 * 规则（学 Claude Code）：能用专用工具就别滥用 bash 读文件/搜索。
 * 零依赖：node:fs / node:child_process
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { execSync } from "node:child_process";
import { join, relative } from "node:path";
import type { Tool, ToolContext, ToolSchema } from "../core/types.js";

/** glob 模式 → 正则（支持 * ? ** 和普通字符） */
function globToRe(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += "[\\s\\S]*";
        i += 2;
        if (pattern[i] === "/") i++;
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (".+^$(){}|[]\\".includes(c)) {
      re += "\\" + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp("^" + re + "$");
}

/** 递归收集目录下匹配的文件 */
function walk(dir: string, pattern: RegExp, base: string, results: string[], limit: number): void {
  if (results.length >= limit) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && !pattern.source.includes("\\.")) continue;
    const full = join(dir, e.name);
    const rel = relative(base, full);
    if (e.isDirectory()) {
      walk(full, pattern, base, results, limit);
    } else if (pattern.test(rel) || pattern.test(e.name)) {
      results.push(full);
      if (results.length >= limit) return;
    }
  }
}

export class GlobTool implements Tool {
  readonly name = "glob";
  readonly description = "按 glob 模式查找文件（支持 ** * ?）。返回匹配的文件路径列表。";
  readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: "glob",
      description: this.description,
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "glob 模式，如 **/*.ts 或 src/*.js" },
          path: { type: "string", description: "搜索根目录，默认当前目录" },
          limit: { type: "number", description: "最多返回条数，默认 100" },
        },
        required: ["pattern"],
      },
    },
  };

  async execute(args: { pattern: string; path?: string; limit?: number }): Promise<string> {
    const root = args.path ?? ".";
    const limit = args.limit ?? 100;
    const results: string[] = [];
    walk(root, globToRe(args.pattern), root, results, limit);
    if (results.length === 0) return "[无匹配文件]";
    return results.map((p, i) => `${i + 1}. ${p}`).join("\n");
  }
}

export class GrepTool implements Tool {
  readonly name = "grep";
  readonly description = "在文件内容中搜索正则。返回匹配的文件:行号:内容。";
  readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: "grep",
      description: this.description,
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "正则表达式" },
          path: { type: "string", description: "搜索目录或单个文件，默认当前目录" },
          glob: { type: "string", description: "只搜索匹配此 glob 的文件，如 *.ts" },
          ignoreCase: { type: "boolean", description: "忽略大小写，默认 false" },
          maxResults: { type: "number", description: "最多返回匹配数，默认 50" },
        },
        required: ["pattern"],
      },
    },
  };

  async execute(args: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; maxResults?: number }): Promise<string> {
    const root = args.path ?? ".";
    const flags = args.ignoreCase ? "gi" : "g";
    let re: RegExp;
    try {
      re = new RegExp(args.pattern, flags);
    } catch {
      return `[error] 非法正则: ${args.pattern}`;
    }
    const fileFilter = args.glob ? globToRe(args.glob) : null;
    const max = args.maxResults ?? 50;
    const hits: string[] = [];
    const files: string[] = [];
    try {
      if (statSync(root).isFile()) files.push(root);
      else collect(root, fileFilter, files, 500);
    } catch {
      return `[error] 路径不存在: ${root}`;
    }
    for (const f of files) {
      if (hits.length >= max) break;
      try {
        const lines = readFileSync(f, "utf8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            hits.push(`${f}:${i + 1}:${lines[i].trim().slice(0, 200)}`);
            if (hits.length >= max) break;
          }
          re.lastIndex = 0;
        }
      } catch {
        // 跳过二进制/无权限
      }
    }
    if (hits.length === 0) return "[无匹配]";
    return hits.join("\n");
  }
}

export class LsTool implements Tool {
  readonly name = "ls";
  readonly description = "列出目录内容，标注文件/目录类型和大小。";
  readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: "ls",
      description: this.description,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "目录路径，默认当前目录" },
          all: { type: "boolean", description: "包含隐藏文件，默认 false" },
        },
      },
    },
  };

  async execute(args: { path?: string; all?: boolean }): Promise<string> {
    const dir = args.path ?? ".";
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return `[error] ${err instanceof Error ? err.message : String(err)}`;
    }
    const rows = entries
      .filter((e) => args.all || !e.name.startsWith("."))
      .map((e) => {
        let size = "";
        let type = e.isDirectory() ? "dir" : "file";
        try {
          if (e.isFile()) size = `${statSync(join(dir, e.name)).size}B`;
        } catch {
          type = "?";
        }
        return `${type.padEnd(4)} ${size.padStart(8)} ${e.name}`;
      });
    return rows.length > 0 ? rows.join("\n") : "[空目录]";
  }
}

export class BashTool implements Tool {
  readonly name = "bash";
  readonly description = "执行 shell 命令并返回 stdout/stderr。用于系统操作（git/npm/docker 等）。优先用 glob/grep/file_read 等专用工具读写文件。";
  readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: "bash",
      description: this.description,
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的 shell 命令" },
          cwd: { type: "string", description: "工作目录，默认当前目录" },
          timeoutMs: { type: "number", description: "超时毫秒，默认 30000" },
        },
        required: ["command"],
      },
    },
  };

  async execute(args: { command: string; cwd?: string; timeoutMs?: number }, ctx: ToolContext): Promise<string> {
    const timeout = Math.min(args.timeoutMs ?? 30_000, ctx.deadline - Date.now());
    if (timeout <= 0) return "[error] 已超时";
    try {
      const out = execSync(args.command, {
        cwd: args.cwd,
        timeout,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const trimmed = (out ?? "").trim();
      return trimmed || "[ok] 无输出";
    } catch (err) {
      const e = err as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string; status?: number };
      const stderr = e.stderr ? (typeof e.stderr === "string" ? e.stderr : e.stderr.toString()).trim() : "";
      const stdout = e.stdout ? (typeof e.stdout === "string" ? e.stdout : e.stdout.toString()).trim() : "";
      const tail = (stderr || e.message || "未知错误").slice(0, 1000);
      return `[exit ${e.status ?? "?"}] ${stdout ? stdout + "\n" : ""}${tail}`;
    }
  }
}

function collect(dir: string, filter: RegExp | null, out: string[], limit: number): void {
  if (out.length >= limit) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) collect(full, filter, out, limit);
    else if (!filter || filter.test(e.name)) {
      out.push(full);
      if (out.length >= limit) return;
    }
  }
}

/** 文件系统工具集工厂 */
export function fsTools(): Tool[] {
  return [new GlobTool(), new GrepTool(), new LsTool(), new BashTool()];
}
