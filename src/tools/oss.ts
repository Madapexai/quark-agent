/**
 * 开源集成适配器：快速把 npm 包包装成 Tool
 *
 * 设计（用户诉求：跟开源项目快速集成，根据诉求快速找和集成）：
 * - dynamic import npm 包，按 adapter 规则包装为 Tool
 * - 内置常见包的适配器（cheerio/papaparse/mathjs 等）
 * - 包不存在时降级返回提示，不报错
 * - 每个适配器 = 一个 Tool 工厂
 */

import type { Tool, ToolSchema } from "../core/types.js";

/** 适配器定义：包名 + 工厂（动态 import 包后构造 Tool） */
export interface OssAdapter {
  /** npm 包名 */
  package: string;
  /** 工具名 */
  toolName: string;
  /** 工具描述 */
  description: string;
  /** 工具参数 schema */
  parameters: Record<string, unknown>;
  /** 动态 import 包后的执行函数 */
  execute: (mod: unknown, args: Record<string, unknown>) => Promise<string>;
}

/** 内置适配器注册表 */
export const BUILTIN_ADAPTERS: Record<string, OssAdapter> = {
  // cheerio: HTML 解析（比 regex 强）
  cheerio: {
    package: "cheerio",
    toolName: "html_parse",
    description: "用 cheerio 解析 HTML，支持 CSS 选择器抽取。比 browser_open 的 regex 强。",
    parameters: {
      type: "object",
      properties: {
        html: { type: "string", description: "HTML 字符串" },
        selector: { type: "string", description: "CSS 选择器，如 'a.link' 或 'div.content'" },
        attr: { type: "string", description: "取属性而非文本，如 'href'" },
      },
      required: ["html", "selector"],
    },
    async execute(mod, args) {
      type CheerioEl = { text: () => string; attr: (a: string) => string | undefined; each: (fn: (i: number) => void) => void; eq: (i: number) => CheerioEl; length: number };
      const cheerio = mod as { load: (html: string) => { (sel: string): CheerioEl } };
      const $ = cheerio.load(args.html as string);
      const sel = args.selector as string;
      const attr = args.attr as string | undefined;
      const out: string[] = [];
      $(sel).each(function (this: unknown, i: number) {
        const el = $(sel).eq(i);
        const val = attr ? el.attr(attr) ?? "" : el.text().trim();
        if (val) out.push(val.slice(0, 500));
      });
      return `[ok] ${out.length} 个匹配\n${out.slice(0, 50).join("\n")}`;
    },
  },

  // papaparse: CSV 流式解析
  papaparse: {
    package: "papaparse",
    toolName: "csv_parse",
    description: "用 papaparse 解析 CSV（支持大文件流式、复杂引号）。",
    parameters: {
      type: "object",
      properties: {
        csv: { type: "string", description: "CSV 字符串" },
        header: { type: "boolean", description: "首行表头，默认 true" },
      },
      required: ["csv"],
    },
    async execute(mod, args) {
      const Papa = mod as { parse: (csv: string, opts: Record<string, unknown>) => { data: unknown[]; errors: unknown[] } };
      const result = Papa.parse(args.csv as string, { header: args.header ?? true, skipEmptyLines: true });
      return `[ok] ${result.data.length} 行${result.errors.length ? `，${result.errors.length} 个错误` : ""}\n${JSON.stringify(result.data.slice(0, 10), null, 2)}`;
    },
  },

  // mathjs: 复杂数学计算
  mathjs: {
    package: "mathjs",
    toolName: "math_eval",
    description: "用 mathjs 求值数学表达式（矩阵/微积分/单位换算等）。",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string", description: "数学表达式，如 '2+3*4' 或 'det([1,2;3,4])'" },
      },
      required: ["expression"],
    },
    async execute(mod, args) {
      const math = mod as { evaluate: (expr: string) => unknown };
      const result = math.evaluate(args.expression as string);
      return `[ok] ${typeof result === "object" ? JSON.stringify(result) : String(result)}`;
    },
  },

  // @octokit/rest: GitHub API 全能力
  octokit: {
    package: "@octokit/rest",
    toolName: "github_api",
    description: "用 @octokit/rest 调 GitHub API（比 platform/githubConnector 更全）。",
    parameters: {
      type: "object",
      properties: {
        token: { type: "string", description: "GitHub token" },
        owner: { type: "string" },
        repo: { type: "string" },
        action: { type: "string", description: "如 'listIssues'/'createIssue'/'getReadme'" },
        data: { type: "string", description: "JSON 参数" },
      },
      required: ["token", "owner", "repo", "action"],
    },
    async execute(mod, args) {
      const m = mod as { Octokit: new (opts: Record<string, unknown>) => { rest: any } };
      const octokit = new m.Octokit({ auth: args.token });
      const rest = octokit.rest;
      const parts = (args.action as string).match(/^[a-z]+|[A-Z][a-z]+/g) ?? [];
      const ns = (parts[0] ?? "issues").toLowerCase();
      const fn = parts[1] ? parts[1][0].toLowerCase() + parts[1].slice(1) : "list";
      const callArgs = args.data ? JSON.parse(args.data as string) : { owner: args.owner, repo: args.repo };
      const result = await rest[ns][fn](callArgs);
      return `[ok] ${JSON.stringify(result.data, null, 2).slice(0, 4000)}`;
    },
  },
};

/** 缓存已加载的模块 */
const moduleCache = new Map<string, unknown>();

/** 动态加载 npm 包（带缓存） */
export async function loadOssPackage(name: string): Promise<unknown | null> {
  if (moduleCache.has(name)) return moduleCache.get(name);
  try {
    const mod = await import(name);
    moduleCache.set(name, mod);
    return mod;
  } catch {
    return null;
  }
}

/** 把适配器包装成 Tool（动态 import，包不存在时降级提示） */
export function ossTool(adapter: OssAdapter): Tool {
  const schema: ToolSchema = {
    type: "function",
    function: { name: adapter.toolName, description: adapter.description, parameters: adapter.parameters },
  };
  return {
    name: adapter.toolName,
    description: adapter.description,
    schema,
    async execute(args: Record<string, unknown>) {
      const mod = await loadOssPackage(adapter.package);
      if (!mod) {
        return `[error] 包 ${adapter.package} 未安装。安装: npm i ${adapter.package}`;
      }
      try {
        return await adapter.execute(mod, args);
      } catch (err) {
        return `[error] ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/** 按包名快速集成：传入包名，返回对应 Tool（内置适配器或通用包装） */
export function integratePackage(packageName: string, opts?: { toolName?: string; description?: string }): Tool {
  const adapter = BUILTIN_ADAPTERS[packageName];
  if (adapter) return ossTool(adapter);
  // 通用包装：把整个包作为 code_exec 的可用模块
  const toolName = opts?.toolName ?? packageName.replace(/[^a-zA-Z0-9]/g, "_");
  return {
    name: toolName,
    description: opts?.description ?? `调用 ${packageName} 包（需先 npm i ${packageName}）`,
    schema: {
      type: "function",
      function: {
        name: toolName,
        description: opts?.description ?? `调用 ${packageName}`,
        parameters: {
          type: "object",
          properties: {
            code: { type: "string", description: `调用 ${packageName} 的代码，最后一条表达式作为返回值` },
          },
          required: ["code"],
        },
      },
    },
    async execute(args: Record<string, unknown>) {
      const mod = await loadOssPackage(packageName);
      if (!mod) return `[error] 包 ${packageName} 未安装。安装: npm i ${packageName}`;
      // 通过 eval 在有 mod 的作用域执行
      try {
        const fn = new Function("mod", "args", `with(mod){ return (async()=>{ ${args.code} })() }`);
        const result = await fn(mod, args);
        return `[ok] ${typeof result === "string" ? result : JSON.stringify(result, null, 2).slice(0, 4000)}`;
      } catch (err) {
        return `[error] ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/** 批量集成多个包为 Tool 数组 */
export function integratePackages(packages: string[]): Tool[] {
  return packages.map((p) => integratePackage(p));
}
