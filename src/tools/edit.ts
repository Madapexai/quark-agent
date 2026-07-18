/**
 * 文件编辑工具：str_replace / file_read / file_write
 *
 * 设计（对标 Claude Code 的 str_replace + Codex 的原子编辑）：
 * - str_replace：精确字符串替换，唯一匹配校验，失败回滚
 * - file_read：读文件（带行号）
 * - file_write：整文件写入
 * - 零依赖：node:fs
 *
 * 行预算：~120 行
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Tool, ToolSchema } from "../core/types.js";

export class StrReplaceTool implements Tool {
  readonly name = "str_replace";
  readonly description = "在文件中精确替换字符串。要求 old_str 在文件中唯一匹配，否则报错。";
  readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: "str_replace",
      description: this.description,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件绝对路径" },
          old_str: { type: "string", description: "要替换的原文（必须精确唯一匹配）" },
          new_str: { type: "string", description: "替换为的新文本" },
        },
        required: ["path", "old_str", "new_str"],
      },
    },
  };

  async execute(args: { path: string; old_str: string; new_str: string }): Promise<string> {
    if (!existsSync(args.path)) return `[error] 文件不存在: ${args.path}`;
    const content = readFileSync(args.path, "utf8");
    // 唯一性校验
    const first = content.indexOf(args.old_str);
    if (first < 0) return `[error] 未找到 old_str`;
    const second = content.indexOf(args.old_str, first + 1);
    if (second >= 0) return `[error] old_str 非唯一匹配（至少 2 处），请提供更多上下文`;
    // 原子替换
    const updated = content.slice(0, first) + args.new_str + content.slice(first + args.old_str.length);
    writeFileSync(args.path, updated, "utf8");
    return `[ok] 已替换 ${args.old_str.length} → ${args.new_str.length} 字符`;
  }
}

export class FileReadTool implements Tool {
  readonly name = "file_read";
  readonly description = "读取文件内容，返回带行号的文本。";
  readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: "file_read",
      description: this.description,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件绝对路径" },
          startLine: { type: "number", description: "起始行（1-based），默认 1" },
          endLine: { type: "number", description: "结束行，默认末尾" },
        },
        required: ["path"],
      },
    },
  };

  async execute(args: { path: string; startLine?: number; endLine?: number }): Promise<string> {
    if (!existsSync(args.path)) return `[error] 文件不存在: ${args.path}`;
    const content = readFileSync(args.path, "utf8");
    const lines = content.split("\n");
    const start = (args.startLine ?? 1) - 1;
    const end = args.endLine ?? lines.length;
    const slice = lines.slice(start, end);
    const numbered = slice.map((l, i) => `${start + i + 1}→${l}`).join("\n");
    return numbered || "[empty]";
  }
}

export class FileWriteTool implements Tool {
  readonly name = "file_write";
  readonly description = "写入文件（覆盖）。用于创建新文件或整体重写。";
  readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: "file_write",
      description: this.description,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件绝对路径" },
          content: { type: "string", description: "写入内容" },
        },
        required: ["path", "content"],
      },
    },
  };

  async execute(args: { path: string; content: string }): Promise<string> {
    writeFileSync(args.path, args.content, "utf8");
    return `[ok] 已写入 ${args.content.length} 字节到 ${args.path}`;
  }
}

/** 编辑工具集工厂 */
export function editTools(): Tool[] {
  return [new StrReplaceTool(), new FileReadTool(), new FileWriteTool()];
}
