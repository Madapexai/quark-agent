/**
 * 多模态工具：text_to_image / text_to_video / make_slides
 *
 * 设计（对标 Claude Code 的多模态 + 不污染 Message 类型）：
 * - 生成能力作为 Tool，结果以 markdown URL 文本回传
 * - provider 决定实际调用哪个 API
 * - 零依赖：纯 fetch
 *
 * 行预算：~180 行
 */

import type { Tool, ToolContext, ToolSchema, MediaRef } from "../core/types.js";

export interface MultimodalProvider {
  generateImage(prompt: string, size?: string): Promise<MediaRef>;
  generateVideo?(prompt: string, duration?: number): Promise<MediaRef>;
  generateSlides?(topic: string, slides: number): Promise<MediaRef>;
}

// ============================================================================
// text_to_image
// ============================================================================

export interface ImageGenConfig {
  /** 端点，如 https://api.openai.com/v1/images/generations */
  endpoint: string;
  apiKey: string;
  model?: string;
  /** 自定义 fetch */
  fetchImpl?: typeof fetch;
}

export class TextToImageTool implements Tool {
  readonly name = "text_to_image";
  readonly description = "根据文本描述生成图片，返回 markdown 图片链接。支持指定尺寸。";
  readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: "text_to_image",
      description: this.description,
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "图片描述（建议英文）" },
          size: { type: "string", enum: ["square_hd", "square", "portrait_4_3", "landscape_16_9"], description: "尺寸" },
        },
        required: ["prompt"],
      },
    },
  };

  constructor(private readonly cfg: ImageGenConfig) {}

  async execute(args: { prompt: string; size?: string }, ctx: ToolContext): Promise<string> {
    const sizeMap: Record<string, string> = {
      square_hd: "1024x1024",
      square: "1024x1024",
      portrait_4_3: "768x1024",
      landscape_16_9: "1024x576",
    };
    const resSize = sizeMap[args.size ?? "square"] ?? "1024x1024";
    const fetchFn = this.cfg.fetchImpl ?? fetch;
    try {
      const res = await fetchFn(this.cfg.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.cfg.apiKey}` },
        body: JSON.stringify({
          model: this.cfg.model ?? "dall-e-3",
          prompt: args.prompt,
          n: 1,
          size: resSize,
        }),
        signal: AbortSignal.timeout(Math.min(60_000, ctx.deadline - Date.now())),
      });
      if (!res.ok) return `[error] image gen ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
      const data = (await res.json()) as { data?: Array<{ url?: string; b64_json?: string }> };
      const item = data.data?.[0];
      if (!item) return "[error] 无图片返回";
      const url = item.url ?? `data:image/png;base64,${item.b64_json}`;
      return `![generated](${url})`;
    } catch (e) {
      return `[error] ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}

// ============================================================================
// text_to_video（简化：调可配置端点）
// ============================================================================

export class TextToVideoTool implements Tool {
  readonly name = "text_to_video";
  readonly description = "根据文本描述生成短视频，返回视频 URL。";
  readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: "text_to_video",
      description: this.description,
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "视频描述" },
          duration: { type: "number", description: "时长秒，默认 5" },
        },
        required: ["prompt"],
      },
    },
  };

  constructor(private readonly cfg: { endpoint: string; apiKey: string; fetchImpl?: typeof fetch }) {}

  async execute(args: { prompt: string; duration?: number }, _ctx: ToolContext): Promise<string> {
    const fetchFn = this.cfg.fetchImpl ?? fetch;
    try {
      const res = await fetchFn(this.cfg.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.cfg.apiKey}` },
        body: JSON.stringify({ prompt: args.prompt, duration: args.duration ?? 5 }),
      });
      if (!res.ok) return `[error] video gen ${res.status}`;
      const data = (await res.json()) as { url?: string };
      return data.url ? `[视频](${data.url})` : "[error] 无视频返回";
    } catch (e) {
      return `[error] ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}

// ============================================================================
// make_slides：生成 PPT 大纲 + 简单 HTML 渲染
// ============================================================================

export class MakeSlidesTool implements Tool {
  readonly name = "make_slides";
  readonly description = "根据主题生成 PPT 大纲（markdown 格式），每页一个 ## 标题。";
  readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: "make_slides",
      description: this.description,
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "PPT 主题" },
          slides: { type: "number", description: "页数，默认 8" },
        },
        required: ["topic"],
      },
    },
  };

  constructor(private readonly provider?: { chat: (req: { messages: Array<{ role: string; content: string }>; model?: string; temperature?: number }) => Promise<{ content: string }> }) {}

  async execute(args: { topic: string; slides?: number }, _ctx: ToolContext): Promise<string> {
    const n = args.slides ?? 8;
    if (!this.provider) {
      // 降级：生成模板大纲
      return this.templateOutline(args.topic, n);
    }
    try {
      const resp = await this.provider.chat({
        messages: [{
          role: "user",
          content: `为主题"${args.topic}"生成 ${n} 页 PPT 大纲，每页用 ## 标题 + 3-5 个要点。只输出 markdown。`,
        }],
        temperature: 0.7,
      });
      return `# ${args.topic}\n\n${resp.content}`;
    } catch {
      return this.templateOutline(args.topic, n);
    }
  }

  private templateOutline(topic: string, n: number): string {
    const sections = ["概述", "背景", "核心要点", "详细分析", "案例", "对比", "结论", "下一步"];
    const lines = [`# ${topic}\n`];
    for (let i = 0; i < n; i++) {
      lines.push(`## ${sections[i] ?? `第${i + 1}页`}`);
      lines.push(`- 要点 1`);
      lines.push(`- 要点 2`);
      lines.push(`- 要点 3\n`);
    }
    return lines.join("\n");
  }
}

/** 多模态工具集工厂 */
export function multimodalTools(opts: {
  image?: ImageGenConfig;
  video?: { endpoint: string; apiKey: string };
  provider?: { chat: (req: { messages: Array<{ role: string; content: string }> }) => Promise<{ content: string }> };
}): Tool[] {
  const tools: Tool[] = [];
  if (opts.image) tools.push(new TextToImageTool(opts.image));
  if (opts.video) tools.push(new TextToVideoTool(opts.video));
  tools.push(new MakeSlidesTool(opts.provider as never));
  return tools;
}
