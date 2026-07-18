/**
 * Provider trait —— 模型提供方抽象
 *
 * 实现策略（调研 §四）：
 * - 走 OpenAI 兼容 /v1/chat/completions 协议，零厂商锁定
 * - OpenRouter 只是换了 baseURL，复用同一实现
 * - 仅用 Node 内置 fetch，无 SDK 依赖（减重）
 */

import type { ChatRequest, ChatResponse, Provider, ToolCall } from "../core/types.js";

export interface OpenAIProviderOptions {
  apiKey: string;
  /** 如 https://api.openai.com/v1 */
  baseURL: string;
  /** 默认模型，可被 ChatRequest.model 覆盖 */
  defaultModel?: string;
  /** 请求超时 ms */
  timeoutMs?: number;
  /** 自定义 name，便于 tracing 区分 */
  name?: string;
  /** 嵌入端点（可选），用于记忆向量 */
  embedModel?: string;
  embedDimensions?: number;
}

interface OpenAIChoice {
  message?: {
    content?: string | null;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  };
  finish_reason?: string;
}

interface OpenAIResponse {
  choices?: OpenAIChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  model?: string;
}

export class OpenAIProvider implements Provider {
  readonly name: string;
  private readonly opts: Required<
    Omit<OpenAIProviderOptions, "embedModel" | "embedDimensions">
  >;
  private readonly embedModel?: string;
  private readonly embedDimensions?: number;

  constructor(opts: OpenAIProviderOptions) {
    this.name = opts.name ?? "openai";
    this.opts = {
      apiKey: opts.apiKey,
      baseURL: opts.baseURL.replace(/\/$/, ""),
      defaultModel: opts.defaultModel ?? "gpt-4o-mini",
      timeoutMs: opts.timeoutMs ?? 60_000,
      name: this.name,
    };
    this.embedModel = opts.embedModel;
    this.embedDimensions = opts.embedDimensions;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const model = req.model || this.opts.defaultModel;
    const body = this.buildBody(req, model);

    const res = await this.fetchWithTimeout(
      `${this.opts.baseURL}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      this.opts.timeoutMs,
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`provider ${this.name} ${res.status}: ${text.slice(0, 500)}`);
    }

    const data = (await res.json()) as OpenAIResponse;
    const choice = data.choices?.[0];
    const toolCalls = this.parseToolCalls(choice);

    return {
      content: choice?.message?.content ?? "",
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: data.usage
        ? {
            prompt: data.usage.prompt_tokens ?? 0,
            completion: data.usage.completion_tokens ?? 0,
            total: data.usage.total_tokens ?? 0,
          }
        : undefined,
      model: data.model ?? model,
      finishReason: this.parseFinish(choice?.finish_reason),
    };
  }

  async chatStream(req: ChatRequest, onDelta: (delta: string) => void): Promise<ChatResponse> {
    const model = req.model || this.opts.defaultModel;
    const body = { ...this.buildBody(req, model), stream: true };
    const res = await this.fetchWithTimeout(
      `${this.opts.baseURL}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      this.opts.timeoutMs,
    );
    if (!res.ok) throw new Error(`provider ${this.name} stream ${res.status}`);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const decoder = new TextDecoder();
    let buf = "";
    let content = "";
    let respModel = model;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line || !line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const ev = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
            model?: string;
          };
          const delta = ev.choices?.[0]?.delta?.content;
          if (delta) {
            content += delta;
            onDelta(delta);
          }
          if (ev.model) respModel = ev.model;
        } catch {
          // 跳过
        }
      }
    }
    return { content, model: respModel, finishReason: "stop" };
  }

  async embed(text: string): Promise<Float32Array> {
    if (!this.embedModel) {
      // 退化：用一个确定性的廉价 hash 作为伪向量，保证无嵌入端点时记忆仍可工作
      return pseudoEmbed(text, this.embedDimensions ?? 64);
    }
    const res = await this.fetchWithTimeout(
      `${this.opts.baseURL}/embeddings`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify({ model: this.embedModel, input: text }),
      },
      this.opts.timeoutMs,
    );
    if (!res.ok) return pseudoEmbed(text, this.embedDimensions ?? 64);
    const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const vec = data.data?.[0]?.embedding;
    return vec ? Float32Array.from(vec) : pseudoEmbed(text, this.embedDimensions ?? 64);
  }

  private buildBody(req: ChatRequest, model: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
        ...(m.toolCalls
          ? { tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.arguments } })) }
          : {}),
      })),
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools;
    }
    if (req.extra) Object.assign(body, req.extra);
    return body;
  }

  private parseToolCalls(choice: OpenAIChoice | undefined): ToolCall[] {
    const raw = choice?.message?.tool_calls;
    if (!raw || raw.length === 0) return [];
    return raw.map((t) => ({
      id: t.id,
      name: t.function.name,
      arguments: t.function.arguments ?? "{}",
    }));
  }

  private parseFinish(reason?: string): ChatResponse["finishReason"] {
    switch (reason) {
      case "stop":
        return "stop";
      case "length":
        return "length";
      case "tool_calls":
        return "tool_calls";
      case "content_filter":
        return "content_filter";
      default:
        return undefined;
    }
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * OpenRouter：只是 baseURL + 多一层 referer 头，复用 OpenAI 实现
 * 端点：https://openrouter.ai/api/v1
 */
export class OpenRouterProvider extends OpenAIProvider {
  constructor(opts: Omit<OpenAIProviderOptions, "baseURL"> & { baseURL?: string }) {
    super({
      ...opts,
      baseURL: opts.baseURL ?? "https://openrouter.ai/api/v1",
      name: opts.name ?? "openrouter",
    });
  }
}

/**
 * 确定性伪嵌入：基于字符 n-gram 哈希。
 * 仅在没有真实 embedding 端点时兜底，让向量召回仍可降级工作。
 */
export function pseudoEmbed(text: string, dims: number): Float32Array {
  const vec = new Float32Array(dims);
  const norm = 1 + text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // 字符 + 位置 + 双字符组合三个特征分散到不同维度
    vec[(c * 31 + i) % dims] += 1 / norm;
    if (i > 0) {
      const big = (text.charCodeAt(i - 1) * 257 + c) % dims;
      vec[big] += 0.8 / norm;
    }
  }
  // L2 归一化
  let sum = 0;
  for (let i = 0; i < dims; i++) sum += vec[i] * vec[i];
  const inv = sum > 0 ? 1 / Math.sqrt(sum) : 1;
  for (let i = 0; i < dims; i++) vec[i] *= inv;
  return vec;
}
