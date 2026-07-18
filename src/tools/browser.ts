/**
 * 浏览器工具：browser_open / browser_click / browser_scroll / browser_extract
 *
 * 设计（学 Claude Code 的 computer use + 决策力）：
 * - 轻量方案：纯 fetch + 简单 HTML 解析（不引 puppeteer，保持零依赖）
 * - 进阶方案：可选注入 puppeteer-core（用户自行安装）作为 headful 模式
 * - 默认 headless：fetch HTML → 抽取正文/链接/表单
 * - 决策力：browser_click 模拟点击（提交表单/翻页）
 *
 * 行预算：~150 行
 */

import type { Tool, ToolContext, ToolSchema } from "../core/types.js";

/** 简单 HTML → 纯文本 + 链接抽取（零依赖） */
export function htmlToText(html: string): { text: string; links: Array<{ text: string; href: string }> } {
  // 去 script/style
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
  // 抽链接
  const links: Array<{ text: string; href: string }> = [];
  const linkRe = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(cleaned)) !== null) {
    const text = m[2].replace(/<[^>]+>/g, "").trim().slice(0, 60);
    if (text && m[1].startsWith("http")) links.push({ text, href: m[1] });
  }
  // 抽表单
  const formRe = /<form[\s\S]*?<\/form>/gi;
  const forms = cleaned.match(formRe) ?? [];
  // 去 HTML 标签
  const text = cleaned
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  const formText = forms.length > 0 ? `\n\n[表单 ${forms.length} 个]` : "";
  return { text: text.slice(0, 8000) + formText, links: links.slice(0, 30) };
}

export class BrowserOpenTool implements Tool {
  readonly name = "browser_open";
  readonly description = "打开网页，返回正文文本和前 30 个链接。headless 模式（纯 fetch）。";
  readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: "browser_open",
      description: this.description,
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "要打开的 URL" },
          selector: { type: "string", description: "可选：只提取匹配选择器的内容（简化：按标签名）" },
        },
        required: ["url"],
      },
    },
  };

  async execute(args: { url: string; selector?: string }, ctx: ToolContext): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(30_000, ctx.deadline - Date.now()));
    try {
      const res = await fetch(args.url, {
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0 micro-agent" },
        redirect: "follow",
      });
      if (!res.ok) return `[error] HTTP ${res.status}`;
      const html = await res.text();
      const { text, links } = htmlToText(html);
      let result = text;
      if (links.length > 0) {
        result += "\n\n[链接]\n" + links.map((l, i) => `${i + 1}. ${l.text} → ${l.href}`).join("\n");
      }
      return result.slice(0, 12000);
    } catch (e) {
      return `[error] ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class BrowserSearchTool implements Tool {
  readonly name = "browser_search";
  readonly description = "用搜索引擎搜索关键词，返回前 10 条结果标题+链接+摘要。";
  readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: "browser_search",
      description: this.description,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词" },
          engine: { type: "string", enum: ["duckduckgo", "bing"], description: "搜索引擎，默认 duckduckgo" },
        },
        required: ["query"],
      },
    },
  };

  async execute(args: { query: string; engine?: string }, ctx: ToolContext): Promise<string> {
    const engine = args.engine ?? "duckduckgo";
    const url = engine === "bing"
      ? `https://www.bing.com/search?q=${encodeURIComponent(args.query)}`
      : `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(20_000, ctx.deadline - Date.now()));
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0 micro-agent" },
      });
      if (!res.ok) return `[error] search ${res.status}`;
      const html = await res.text();
      const { links } = htmlToText(html);
      if (links.length === 0) return "[无结果]";
      return links.slice(0, 10).map((l, i) => `${i + 1}. ${l.text}\n   ${l.href}`).join("\n");
    } catch (e) {
      return `[error] ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class BrowserClickTool implements Tool {
  readonly name = "browser_click";
  readonly description = "模拟点击：向指定 URL 发起 POST/GET（用于表单提交、翻页）。返回响应正文。";
  readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: "browser_click",
      description: this.description,
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "目标 URL" },
          method: { type: "string", enum: ["GET", "POST"], description: "HTTP 方法，默认 GET" },
          body: { type: "string", description: "POST body（JSON 字符串）" },
        },
        required: ["url"],
      },
    },
  };

  async execute(args: { url: string; method?: string; body?: string }, ctx: ToolContext): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(20_000, ctx.deadline - Date.now()));
    try {
      const init: RequestInit = {
        method: args.method ?? "GET",
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0 micro-agent" },
      };
      if (args.method === "POST" && args.body) {
        init.headers = { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 micro-agent" };
        init.body = args.body;
      }
      const res = await fetch(args.url, init);
      if (!res.ok) return `[error] HTTP ${res.status}`;
      const text = await res.text();
      const { text: clean } = htmlToText(text);
      return clean.slice(0, 8000);
    } catch (e) {
      return `[error] ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 浏览器工具集工厂 */
export function browserTools(): Tool[] {
  return [new BrowserOpenTool(), new BrowserSearchTool(), new BrowserClickTool()];
}
