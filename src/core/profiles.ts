/**
 * 场景裁剪（Profiles）：按业务场景选工具集，不是大杂烩
 *
 * 设计（对标 Codex agents 配置 + Claude Code subagent 专用工具列表）：
 * - 每个 profile 声明需要的工具类别，createAgent 按需装配
 * - 默认 minimal：只有 code_exec + memory_recall，最小基座
 * - 可组合：profile + 额外 tools + plugins = 定制化 agent
 * - profile 不是封闭集合：用户可自定义 profile
 *
 * 核心理念：基座 + 可选能力，按场景裁剪，好用且不臃肿
 */

import type { Tool } from "./types.js";
import { CodeExecTool, MemoryRecallTool, HttpGetTool } from "../tools/builtin.js";
import { StrReplaceTool, FileReadTool, FileWriteTool } from "../tools/edit.js";
import { GlobTool, GrepTool, LsTool, BashTool } from "../tools/fs.js";
import { WebFetchTool, WebSearchTool } from "../tools/web.js";
import { BrowserOpenTool, BrowserClickTool } from "../tools/browser.js";
import { BrowserUseTool } from "../tools/browser_use.js";
import { DataAnalyzeTool, CsvReadTool } from "../tools/data.js";
import { TestRunTool, TestAssertTool } from "../tools/test.js";
import { ComputerUseTool } from "../tools/computer.js";
import { TextToImageTool, MakeSlidesTool } from "../tools/multimodal.js";
// SubAgentTool 需要父 agent 实例，不在 profile 内构造，由 createAgent 按需注入

/** 工具类别标识，profile 用这些名字声明需要的能力 */
export type ToolCategory =
  | "core" // code_exec + memory_recall（基座，所有 profile 都有）
  | "fs" // glob + grep + ls + bash + file_edit
  | "web" // web_fetch + web_search
  | "browser" // 轻量 browser_open/click
  | "browser_use" // 真浏览器自动化（puppeteer 可选）
  | "data" // data_analyze + csv_read
  | "test" // test_run + test_assert
  | "computer" // computer use（截屏+鼠标）
  | "multimodal" // text_to_image + make_slides
  | "subagent"; // 子 agent 派发

/** Profile 定义：一组工具类别 + 描述 */
export interface Profile {
  name: string;
  description: string;
  categories: ToolCategory[];
}

/** 内置 profiles */
export const PROFILES: Record<string, Profile> = {
  /** 最小基座：只能跑代码 + 召回记忆。所有场景的起点 */
  minimal: {
    name: "minimal",
    description: "最小基座：code_exec + memory_recall。适合嵌入其他应用",
    categories: ["core"],
  },
  /** 编码助手：读写文件 + 搜索 + shell + 子agent，对标 Claude Code */
  coding: {
    name: "coding",
    description: "编码助手：fs + 编辑 + shell + 子agent，对标 Claude Code",
    categories: ["core", "fs", "subagent"],
  },
  /** 数据分析师：数据分析 + CSV + 代码执行，对标 Codex data analyst */
  data: {
    name: "data",
    description: "数据分析师：CSV/JSON 分析 + 统计 + 可视化代码",
    categories: ["core", "data", "fs"],
  },
  /** QA 测试：自动化测试 + 浏览器 + 断言，对标 Codex QA agent */
  qa: {
    name: "qa",
    description: "QA 测试：跑测试 + 断言 + browser_use + shell",
    categories: ["core", "test", "browser_use", "fs"],
  },
  /** 研究员：联网搜索 + 浏览器 + 抓取，对标 deep research */
  research: {
    name: "research",
    description: "研究员：web_search + web_fetch + browser + browser_use",
    categories: ["core", "web", "browser", "browser_use"],
  },
  /** 全能：所有工具。仅用于需要全能力的场景，默认不推荐 */
  full: {
    name: "full",
    description: "全能：所有工具类别。大杂烩，仅演示用",
    categories: ["core", "fs", "web", "browser", "browser_use", "data", "test", "computer", "multimodal", "subagent"],
  },
};

/** 按类别构造工具实例。memory 用于 MemoryRecallTool */
export function toolsByCategory(category: ToolCategory, memory?: { search: (q: { query: string; topK?: number }) => Promise<Array<{ content: string; kind: string }>> }): Tool[] {
  const recall = () => (memory ? [new MemoryRecallTool(memory)] : []);
  switch (category) {
    case "core":
      return [new CodeExecTool(), ...recall(), new HttpGetTool()];
    case "fs":
      return [new GlobTool(), new GrepTool(), new LsTool(), new BashTool(), new StrReplaceTool(), new FileReadTool(), new FileWriteTool()];
    case "web":
      return [new WebFetchTool(), new WebSearchTool()];
    case "browser":
      return [new BrowserOpenTool(), new BrowserClickTool()];
    case "browser_use":
      return [new BrowserUseTool()];
    case "data":
      return [new DataAnalyzeTool(), new CsvReadTool()];
    case "test":
      return [new TestRunTool(), new TestAssertTool()];
    case "computer":
      return [new ComputerUseTool()];
    case "multimodal":
      // TextToImageTool 需要 endpoint/apiKey 配置，profile 内用占位构造
      // 真实配置由 createAgent 调用方覆盖（替换 tools map 里的同名工具）
      return [new TextToImageTool({ endpoint: "", apiKey: "" }), new MakeSlidesTool()];
    case "subagent":
      // SubAgentTool 需父 agent，profile 内返回空，由 createAgent 注入
      return [];
    default:
      return [];
  }
}

/** 按 profile 名装配工具集。可追加额外类别或排除某些类别 */
export function toolsForProfile(
  profileName: string,
  opts: {
    memory?: { search: (q: { query: string; topK?: number }) => Promise<Array<{ content: string; kind: string }>> };
    /** 追加额外工具类别（在 profile 基础上加） */
    extraCategories?: ToolCategory[];
    /** 排除某些类别（从 profile 中去掉） */
    excludeCategories?: ToolCategory[];
    /** 额外的自定义工具实例 */
    extraTools?: Tool[];
  } = {},
): Tool[] {
  const profile = PROFILES[profileName] ?? PROFILES.minimal;
  let cats = new Set<ToolCategory>(profile.categories);
  if (opts.extraCategories) for (const c of opts.extraCategories) cats.add(c);
  if (opts.excludeCategories) for (const c of opts.excludeCategories) cats.delete(c);
  const tools: Tool[] = [];
  const seen = new Set<string>();
  for (const cat of cats) {
    for (const t of toolsByCategory(cat, opts.memory)) {
      if (!seen.has(t.name)) {
        seen.add(t.name);
        tools.push(t);
      }
    }
  }
  if (opts.extraTools) for (const t of opts.extraTools) if (!seen.has(t.name)) tools.push(t);
  return tools;
}

/** 列出所有内置 profile 名 + 描述 */
export function listProfiles(): Array<{ name: string; description: string; categories: string[] }> {
  return Object.values(PROFILES).map((p) => ({ name: p.name, description: p.description, categories: p.categories }));
}

// ============================================================================
// 裁剪 SOP：给定场景自动推荐 profile + 工具 + 开源集成建议
// ============================================================================

export interface ProfileRecommendation {
  /** 推荐的 profile 名 */
  profile: string;
  /** 推荐理由 */
  reason: string;
  /** 建议追加的类别（在 profile 基础上） */
  extraCategories: ToolCategory[];
  /** 建议排除的类别 */
  excludeCategories: ToolCategory[];
  /** 建议集成的开源包 */
  suggestOssPackages: Array<{ name: string; reason: string; asTool?: string }>;
  /** 最终工具数估算 */
  estimatedTools: number;
}

/** 场景关键词 → profile 映射规则 */
const SCENE_RULES: Array<{ keywords: string[]; profile: string; extras?: ToolCategory[]; excludes?: ToolCategory[]; oss?: Array<{ name: string; reason: string; asTool?: string }> }> = [
  {
    keywords: ["代码", "编程", "coding", "开发", "重构", "bug", "修", "写代码", "refactor", "implement"],
    profile: "coding",
    extras: ["subagent"],
    oss: [{ name: "typescript", reason: "TS 项目原生支持" }],
  },
  {
    keywords: ["数据", "分析", "csv", "excel", "统计", "报表", "data", "analyze", "可视化", "chart"],
    profile: "data",
    extras: ["fs"],
    oss: [
      { name: "papaparse", reason: "大 CSV 流式解析", asTool: "csv_parse" },
      { name: "mathjs", reason: "复杂数学计算", asTool: "math_eval" },
      { name: "echarts", reason: "生成图表", asTool: "make_chart" },
    ],
  },
  {
    keywords: ["测试", "qa", "test", "断言", "回归", "e2e", "自动化测试", "pytest", "jest"],
    profile: "qa",
    oss: [{ name: "playwright", reason: "比 puppeteer 更强的 e2e", asTool: "browser_use" }],
  },
  {
    keywords: ["研究", "搜索", "调研", "research", "联网", "查资料", "web", "爬取", "crawl"],
    profile: "research",
    oss: [{ name: "cheerio", reason: "HTML 解析比 regex 强", asTool: "html_parse" }],
  },
  {
    keywords: ["浏览器", "browser", "网页", "点击", "填表", "截图", "selenium", "puppeteer"],
    profile: "research",
    extras: ["browser_use"],
    oss: [{ name: "puppeteer-core", reason: "真浏览器自动化", asTool: "browser_use" }],
  },
  {
    keywords: ["屏幕", "computer use", "鼠标", "键盘", "截屏", "桌面", "控制电脑"],
    profile: "qa",
    extras: ["computer"],
  },
  {
    keywords: ["图片", "生图", "画", "image", "视频", "ppt", "幻灯片", "多模态"],
    profile: "minimal",
    extras: ["multimodal"],
  },
  {
    keywords: ["github", "slack", "jira", "webhook", "平台", "集成", "打通", "通知"],
    profile: "minimal",
    extras: ["web"],
    oss: [{ name: "@octokit/rest", reason: "GitHub API 全能力", asTool: "github" }],
  },
];

/** 裁剪 SOP：输入场景描述，自动推荐 profile + 工具 + 开源集成 */
export function recommendProfile(scenario: string): ProfileRecommendation {
  const lower = scenario.toLowerCase();
  const matched: typeof SCENE_RULES = [];
  for (const rule of SCENE_RULES) {
    if (rule.keywords.some((k) => lower.includes(k.toLowerCase()))) matched.push(rule);
  }

  if (matched.length === 0) {
    return {
      profile: "minimal",
      reason: "未识别明确场景，用最小基座。按需手动加类别或开源包",
      extraCategories: [],
      excludeCategories: [],
      suggestOssPackages: [],
      estimatedTools: 3,
    };
  }

  // 多规则命中时合并，取第一个作为主 profile
  const primary = matched[0];
  const extraSet = new Set<ToolCategory>();
  const ossMap = new Map<string, { name: string; reason: string; asTool?: string }>();
  for (const m of matched) {
    if (m.extras) for (const e of m.extras) extraSet.add(e);
    if (m.oss) for (const o of m.oss) ossMap.set(o.name, o);
  }

  const profile = PROFILES[primary.profile] ?? PROFILES.minimal;
  const allCats = new Set<ToolCategory>([...profile.categories, ...extraSet]);
  const toolCount = [...allCats].reduce((sum, c) => sum + toolsByCategory(c).length, 0);

  return {
    profile: primary.profile,
    reason: `场景命中关键词 → 推荐 ${primary.profile} profile。${profile.description}`,
    extraCategories: [...extraSet],
    excludeCategories: [],
    suggestOssPackages: [...ossMap.values()],
    estimatedTools: toolCount,
  };
}

/** 生成裁剪方案 SOP 文本（给人看）：场景 → 推荐 → 装配命令 */
export function generateTrimSop(scenario: string): string {
  const rec = recommendProfile(scenario);
  const lines: string[] = [
    `# 裁剪方案 SOP`,
    ``,
    `## 场景`,
    `${scenario}`,
    ``,
    `## 推荐 profile: ${rec.profile}`,
    `${rec.reason}`,
    ``,
    `## 工具集（预计 ${rec.estimatedTools} 个工具）`,
  ];
  const profile = PROFILES[rec.profile];
  const allCats = [...new Set<ToolCategory>([...profile.categories, ...rec.extraCategories])];
  for (const cat of allCats) {
    const tools = toolsByCategory(cat).map((t) => t.name);
    lines.push(`- ${cat}: ${tools.join(", ") || "(由 createAgent 注入)"}`);
  }
  if (rec.suggestOssPackages.length > 0) {
    lines.push(``, `## 建议集成的开源包`);
    for (const pkg of rec.suggestOssPackages) {
      lines.push(`- ${pkg.name}: ${pkg.reason}${pkg.asTool ? ` (作为 ${pkg.asTool} 工具)` : ""}`);
    }
    lines.push(``, `## 安装命令`);
    lines.push(`\`\`\`bash`);
    lines.push(`npm i ${rec.suggestOssPackages.map((p) => p.name).join(" ")}`);
    lines.push(`\`\`\``);
  }
  lines.push(``, `## 装配代码`);
  lines.push("```typescript");
  lines.push(`const { agent } = await createAgent({`);
  lines.push(`  config, apiKey: "sk-...",`);
  lines.push(`  profile: "${rec.profile}",`);
  if (rec.extraCategories.length > 0) lines.push(`  extraCategories: ${JSON.stringify(rec.extraCategories)},`);
  lines.push(`});`);
  lines.push("```");
  return lines.join("\n");
}

