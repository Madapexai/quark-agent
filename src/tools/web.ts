/**
 * Web 工具：web_fetch / web_search
 *
 * 对标 Claude Code 的 WebFetch + WebSearch。
 * - web_fetch：抓取 URL，转 markdown 文本（复用 browser.ts 的 htmlToText）
 * - web_search：联网搜索（默认 DuckDuckGo HTML，可配置）
 * 零依赖：fetch + 复用 htmlToText
 */

import type { Tool, ToolContext, ToolSchema } from "../core/types.js";
import { htmlToText } from "./browser.js";

export interface WebToolsOptions {
  /** web_search 的搜索端点，默认 DuckDuckGo HTML */
  searchEndpoint?: string;
  /** 自定义 fetch（测试用） */
  fetchImpl?: typeof fetch;
  /** 超时 ms，默认 20000 */
  timeoutMs?: number;
}

export class WebFetchTool implements Tool {
  readonly name = "web_fetch";
  readonly description = "抓取网页 URL 并转为可读文本，返回正文 + 链接。用于获取在线文档/页面内容。";
  readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: "web_fetch",
      description: this.description,
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "要抓取的 URL" },
          maxBytes: { type: "number", description: "最多返回字符数，默认 8000" },
        },
        required: ["url"],
      },
    },
  };

  constructor(private readonly opts: WebToolsOptions = {}) {}

  async execute(args: { url: string; maxBytes?: number }, ctx: ToolContext): Promise<string> {
    const max = args.maxBytes ?? 8000;
    const fetchFn = this.opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.opts.timeoutMs ?? 20_000, ctx.deadline - Date.now()));
    try {
      const res = await fetchFn(args.url, { signal: controller.signal, redirect: "follow" });
      if (!res.ok) return `[error] HTTP ${res.status} ${res.statusText}`;
      const html = await res.text();
      const { text, links } = htmlToText(html);
      const body = text.slice(0, max);
      const linkText = links.length > 0 ? "\n\n[链接]\n" + links.slice(0, 15).map((l) => `- ${l.text}: ${l.href}`).join("\n") : "";
      return body + linkText;
    } catch (err) {
      return `[error] ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class WebSearchTool implements Tool {
  readonly name = "web_search";
  readonly description = "联网搜索关键词，返回标题+链接+摘要列表。用于获取实时信息或查找资料。";
  readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: "web_search",
      description: this.description,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词" },
          num: { type: "number", description: "返回结果数，默认 5" },
        },
        required: ["query"],
      },
    },
  };

  constructor(private readonly opts: WebToolsOptions = {}) {}

  async execute(args: { query: string; num?: number }, ctx: ToolContext): Promise<string> {
    const num = args.num ?? 5;
    const endpoint = this.opts.searchEndpoint ?? "https://html.duckduckgo.com/html/?q=";
    const fetchFn = this.opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.opts.timeoutMs ?? 20_000, ctx.deadline - Date.now()));
    try {
      const url = endpoint + encodeURIComponent(args.query);
      const res = await fetchFn(url, { signal: controller.signal });
      if (!res.ok) return `[error] 搜索失败 HTTP ${res.status}`;
      const html = await res.text();
      const results = this.parseResults(html, num);
      if (results.length === 0) return "[无搜索结果]";
      return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
    } catch (err) {
      return `[error] ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 解析搜索结果页 HTML（DuckDuckGo/Bing 通用：抽 a 链接 + 紧邻文本） */
  private parseResults(html: string, num: number): Array<{ title: string; url: string; snippet: string }> {
    const out: Array<{ title: string; url: string; snippet: string }> = [];
    // DuckDuckGo HTML: <a class="result__a" href="...">title</a> + <a class="result__snippet">
    const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>)?/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null && out.length < num) {
      const url = m[1].startsWith("//") ? "https:" + m[1] : m[1];
      const title = m[2].replace(/<[^>]+>/g, "").trim().slice(0, 100);
      const snippet = (m[3] ?? "").replace(/<[^>]+>/g, "").trim().slice(0, 200);
      if (title) out.push({ title, url, snippet });
    }
    // 兜底：通用 a 链接抽取
    if (out.length === 0) {
      const { links } = htmlToText(html);
      for (const l of links.slice(0, num)) {
        out.push({ title: l.text, url: l.href, snippet: "" });
      }
    }
    return out;
  }
}

/** Web 工具集工厂 */
export function webTools(opts?: WebToolsOptions): Tool[] {
  return [new WebFetchTool(opts), new WebSearchTool(opts)];
}
