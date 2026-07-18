/**
 * Browser Use：真浏览器自动化（puppeteer-core 可选依赖）
 *
 * 对标 Codex/Orca 的 browser use：能点击、填表、截图、执行 JS。
 * - 有 puppeteer-core 时：headful 浏览器，完整交互能力
 * - 无 puppeteer-core 时：降级到 fetch 模式（只读，不能交互）
 * 动态 import，没装不报错，保持零依赖原则
 */

import type { Tool, ToolContext, ToolSchema } from "../core/types.js";
import { htmlToText } from "./browser.js";

export interface BrowserUseOptions {
  /** puppeteer 连接配置，如 { browserWSEndpoint } 或 { executablePath } */
  connect?: Record<string, unknown>;
  /** 自定义 puppeteer 模块路径（测试用） */
  puppeteerModule?: unknown;
}

interface PageLike {
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  content(): Promise<string>;
  click(selector: string): Promise<unknown>;
  type(selector: string, text: string): Promise<unknown>;
  screenshot(opts?: Record<string, unknown>): Promise<Buffer>;
  evaluate(fn: string): Promise<unknown>;
  waitForSelector(selector: string, opts?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}
interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

/** 动态加载 puppeteer-core，失败返回 null */
async function loadPuppeteer(mod?: unknown): Promise<{ launch: (opts?: Record<string, unknown>) => Promise<BrowserLike> } | null> {
  if (mod) return mod as { launch: (opts?: Record<string, unknown>) => Promise<BrowserLike> };
  try {
    // @ts-ignore - puppeteer-core 是可选依赖，未安装时 import 会抛错
    return await import("puppeteer-core");
  } catch {
    return null;
  }
}

export class BrowserUseTool implements Tool {
  readonly name = "browser_use";
  readonly description = "浏览器自动化：导航/点击/输入/截图/执行JS。需安装 puppeteer-core，未装则降级为只读 fetch。";
  readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: "browser_use",
      description: this.description,
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["navigate", "click", "type", "screenshot", "evaluate", "extract"], description: "操作类型" },
          url: { type: "string", description: "navigate 时的目标 URL" },
          selector: { type: "string", description: "click/type 时的 CSS 选择器" },
          text: { type: "string", description: "type 时输入的文本" },
          script: { type: "string", description: "evaluate 时执行的 JS 代码" },
        },
        required: ["action"],
      },
    },
  };

  private browser: BrowserLike | null = null;
  private puppeteer: { launch: (opts?: Record<string, unknown>) => Promise<BrowserLike> } | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(private readonly opts: BrowserUseOptions = {}) {}

  private async ensureBrowser(): Promise<boolean> {
    if (this.browser) return true;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        this.puppeteer = await loadPuppeteer(this.opts.puppeteerModule);
        if (this.puppeteer) {
          try {
            this.browser = await this.puppeteer.launch({ headless: true, ...this.opts.connect });
          } catch {
            this.puppeteer = null;
          }
        }
      })();
    }
    await this.initPromise;
    return this.browser !== null;
  }

  async execute(args: { action: string; url?: string; selector?: string; text?: string; script?: string }, ctx: ToolContext): Promise<string> {
    const hasBrowser = await this.ensureBrowser();

    // 降级模式：只支持 navigate/extract，用 fetch
    if (!hasBrowser) {
      if (args.action === "navigate" || args.action === "extract") {
        if (!args.url) return "[error] navigate 需要 url";
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.min(20_000, ctx.deadline - Date.now()));
        try {
          const res = await fetch(args.url, { signal: controller.signal });
          if (!res.ok) return `[error] HTTP ${res.status}`;
          const html = await res.text();
          const { text: t, links } = htmlToText(html);
          return `[降级 fetch 模式，puppeteer 未安装]\n${t.slice(0, 4000)}\n\n[链接]\n${links.slice(0, 10).map((l) => l.href).join("\n")}`;
        } catch (err) {
          return `[error] ${err instanceof Error ? err.message : String(err)}`;
        } finally {
          clearTimeout(timer);
        }
      }
      return `[error] puppeteer-core 未安装，${args.action} 操作不可用。降级模式只支持 navigate/extract。安装：npm i puppeteer-core`;
    }

    // 真浏览器模式
    try {
      const page = await this.browser!.newPage();
      try {
        switch (args.action) {
          case "navigate": {
            if (!args.url) return "[error] navigate 需要 url";
            await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
            const html = await page.content();
            const { text: t, links } = htmlToText(html);
            return `[ok] 已导航到 ${args.url}\n${t.slice(0, 4000)}\n\n[链接 ${links.length}]\n${links.slice(0, 15).map((l) => `- ${l.text}: ${l.href}`).join("\n")}`;
          }
          case "click": {
            if (!args.selector) return "[error] click 需要 selector";
            await page.click(args.selector).catch(() => Promise.reject(new Error(`选择器未找到: ${args.selector}`)));
            return `[ok] 已点击 ${args.selector}`;
          }
          case "type": {
            if (!args.selector || !args.text) return "[error] type 需要 selector 和 text";
            await page.type(args.selector, args.text);
            return `[ok] 已在 ${args.selector} 输入 ${args.text.length} 字符`;
          }
          case "screenshot": {
            const buf = await page.screenshot({ type: "png" });
            return `[ok] 截图 ${buf.length} 字节（base64 前 200）: ${buf.toString("base64").slice(0, 200)}`;
          }
          case "evaluate": {
            if (!args.script) return "[error] evaluate 需要 script";
            const result = await page.evaluate(args.script);
            return `[ok] ${typeof result === "string" ? result : JSON.stringify(result, null, 2).slice(0, 4000)}`;
          }
          case "extract": {
            const html = await page.content();
            const { text: t, links } = htmlToText(html);
            return `${t.slice(0, 4000)}\n\n[链接 ${links.length}]\n${links.slice(0, 15).map((l) => `- ${l.text}: ${l.href}`).join("\n")}`;
          }
          default:
            return `[error] 未知 action: ${args.action}`;
        }
      } finally {
        await page.close().catch(() => undefined);
      }
    } catch (err) {
      return `[error] ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  async close(): Promise<void> {
    if (this.browser) await this.browser.close().catch(() => undefined);
    this.browser = null;
  }
}
