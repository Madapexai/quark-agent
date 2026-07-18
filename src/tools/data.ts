/**
 * 数据分析工具：csv_read + data_analyze
 *
 * 对标 Codex data analyst / Code Interpreter。
 * - csv_read：解析 CSV 为 JSON，支持表头、分隔符
 * - data_analyze：对 JSON 数组做统计（count/sum/mean/min/max/median/stddev/分位数/分组聚合）
 * 零依赖：纯 TS 实现
 */

import { readFileSync } from "node:fs";
import type { Tool, ToolSchema } from "../core/types.js";

export class CsvReadTool implements Tool {
  readonly name = "csv_read";
  readonly description = "读取 CSV 文件并解析为 JSON 数组。支持自定义分隔符和表头。";
  readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: "csv_read",
      description: this.description,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "CSV 文件路径" },
          delimiter: { type: "string", description: "分隔符，默认逗号" },
          hasHeader: { type: "boolean", description: "首行是否表头，默认 true" },
          limit: { type: "number", description: "最多读取行数，默认全部" },
        },
        required: ["path"],
      },
    },
  };

  async execute(args: { path: string; delimiter?: string; hasHeader?: boolean; limit?: number }): Promise<string> {
    let content: string;
    try {
      content = readFileSync(args.path, "utf8");
    } catch (err) {
      return `[error] ${err instanceof Error ? err.message : String(err)}`;
    }
    const delim = args.delimiter ?? ",";
    const lines = content.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length === 0) return "[空文件]";
    const hasHeader = args.hasHeader ?? true;
    const limit = args.limit ?? lines.length;
    const rows = lines.slice(hasHeader ? 1 : 0, (hasHeader ? 1 : 0) + limit);
    let headers: string[];
    if (hasHeader) {
      headers = this.parseLine(lines[0], delim);
    } else {
      headers = this.parseLine(lines[0], delim).map((_, i) => `col${i}`);
    }
    const data = rows.map((line) => {
      const cells = this.parseLine(line, delim);
      const obj: Record<string, unknown> = {};
      headers.forEach((h, i) => {
        const v = cells[i] ?? "";
        // 自动转数字
        const n = Number(v);
        obj[h] = v !== "" && !isNaN(n) ? n : v;
      });
      return obj;
    });
    const preview = data.slice(0, 5);
    return `[ok] ${data.length} 行 × ${headers.length} 列\n表头: ${headers.join(", ")}\n前 5 行:\n${JSON.stringify(preview, null, 2)}`;
  }

  /** 解析一行 CSV（支持引号包裹） */
  private parseLine(line: string, delim: string): string[] {
    const out: string[] = [];
    let cur = "";
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuote) {
        if (c === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQuote = false;
        } else cur += c;
      } else {
        if (c === '"') inQuote = true;
        else if (c === delim) { out.push(cur); cur = ""; }
        else cur += c;
      }
    }
    out.push(cur);
    return out;
  }
}

export class DataAnalyzeTool implements Tool {
  readonly name = "data_analyze";
  readonly description = "对 JSON 数组数据做统计分析。支持 count/sum/mean/min/max/median/stddev/分位数/分组聚合。";
  readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: "data_analyze",
      description: this.description,
      parameters: {
        type: "object",
        properties: {
          data: { type: "string", description: "JSON 数组字符串，如 [{x:1,y:2},{x:3,y:4}]" },
          field: { type: "string", description: "要分析的数值字段名" },
          ops: { type: "array", items: { type: "string" }, description: "统计操作：count/sum/mean/min/max/median/stddev/quantile" },
          groupBy: { type: "string", description: "可选：按此字段分组后聚合" },
          quantile: { type: "number", description: "quantile 操作时分位数 0-1，默认 0.5" },
        },
        required: ["data", "field", "ops"],
      },
    },
  };

  async execute(args: { data: string; field: string; ops: string[]; groupBy?: string; quantile?: number }): Promise<string> {
    let arr: unknown[];
    try {
      arr = JSON.parse(args.data);
      if (!Array.isArray(arr)) return "[error] data 必须是 JSON 数组";
    } catch {
      return "[error] data 不是合法 JSON";
    }
    if (arr.length === 0) return "[error] 空数组";

    const field = args.field;
    const q = args.quantile ?? 0.5;

    if (args.groupBy) {
      // 分组聚合
      const groups = new Map<string, unknown[]>();
      for (const row of arr) {
        const key = String((row as Record<string, unknown>)[args.groupBy] ?? "");
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(row);
      }
      const results: Record<string, Record<string, number>> = {};
      for (const [key, rows] of groups) {
        const values = rows.map((r) => Number((r as Record<string, unknown>)[field])).filter((n) => !isNaN(n));
        results[key] = this.compute(values, args.ops, q);
      }
      return `[ok] 按 ${args.groupBy} 分组，共 ${groups.size} 组\n${JSON.stringify(results, null, 2)}`;
    }

    const values = arr.map((r) => Number((r as Record<string, unknown>)[field])).filter((n) => !isNaN(n));
    if (values.length === 0) return `[error] 字段 ${field} 无有效数值`;
    const result = this.compute(values, args.ops, q);
    return `[ok] ${values.length} 个值\n${JSON.stringify(result, null, 2)}`;
  }

  private compute(values: number[], ops: string[], q: number): Record<string, number> {
    const sorted = [...values].sort((a, b) => a - b);
    const result: Record<string, number> = {};
    for (const op of ops) {
      switch (op) {
        case "count": result.count = values.length; break;
        case "sum": result.sum = values.reduce((a, b) => a + b, 0); break;
        case "mean": result.mean = values.reduce((a, b) => a + b, 0) / values.length; break;
        case "min": result.min = sorted[0]; break;
        case "max": result.max = sorted[sorted.length - 1]; break;
        case "median": result.median = this.quantile(sorted, 0.5); break;
        case "stddev":
          const mean = values.reduce((a, b) => a + b, 0) / values.length;
          result.stddev = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
          break;
        case "quantile": result[`quantile_${q}`] = this.quantile(sorted, q); break;
        default: result[op] = NaN;
      }
    }
    return result;
  }

  private quantile(sorted: number[], q: number): number {
    const pos = (sorted.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
  }
}
