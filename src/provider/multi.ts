/** 多 Provider 实现：Anthropic / Gemini / Ollama，全部 fetch + 手写 SSE，零 SDK 依赖 */

import type { ChatRequest, ChatResponse, Provider, ToolCall } from "../core/types.js";

/** 共享：带超时的 fetch */
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// 共用 SSE 解析
// ============================================================================

/**
 * 消费 SSE 流，逐 chunk 回调。返回最终累积的 ChatResponse。
 * 兼容 OpenAI/Anthropic/Gemini 的事件流格式（data: 行）。
 */
export async function consumeSSE(
  res: Response,
  onDelta: (chunk: string) => void,
  parser: SSEParser,
): Promise<ChatResponse> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("no response body");
  const decoder = new TextDecoder();
  let buf = "";
  const acc = parser.init();
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
        const json = JSON.parse(data);
        const delta = parser.extractDelta(json, acc);
        if (delta) onDelta(delta);
      } catch {
        // 跳过非 JSON 行
      }
    }
  }
  return parser.finalize(acc);
}

export interface SSEParser {
  init(): Record<string, unknown>;
  extractDelta(json: unknown, acc: Record<string, unknown>): string | null;
  finalize(acc: Record<string, unknown>): ChatResponse;
}

// ============================================================================
// Anthropic Provider —— /v1/messages
// ============================================================================

export interface AnthropicProviderOptions {
  apiKey: string;
  baseURL?: string;
  defaultModel?: string;
  timeoutMs?: number;
  name?: string;
}

interface AnthropicAcc {
  content: string;
  toolCalls: ToolCall[];
  toolCallIndex: number;
  model: string;
}

export class AnthropicProvider implements Provider {
  readonly name: string;
  private readonly opts: Required<Omit<AnthropicProviderOptions, "name">>;

  constructor(opts: AnthropicProviderOptions) {
    this.name = opts.name ?? "anthropic";
    this.opts = {
      apiKey: opts.apiKey,
      baseURL: (opts.baseURL ?? "https://api.anthropic.com/v1").replace(/\/$/, ""),
      defaultModel: opts.defaultModel ?? "claude-sonnet-4-5-20250929",
      timeoutMs: opts.timeoutMs ?? 60_000,
    };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body = this.buildBody(req);
    const res = await fetchWithTimeout(`${this.opts.baseURL}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.opts.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    }, this.opts.timeoutMs);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`anthropic ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
      model?: string;
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    let content = "";
    const toolCalls: ToolCall[] = [];
    for (const block of data.content ?? []) {
      if (block.type === "text") content += block.text ?? "";
      else if (block.type === "tool_use") {
        toolCalls.push({
          id: `tu_${Date.now().toString(36)}_${toolCalls.length}`,
          name: block.name ?? "",
          arguments: JSON.stringify(block.input ?? {}),
        });
      }
    }
    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      model: data.model ?? req.model,
      finishReason: data.stop_reason === "tool_use" ? "tool_calls" : "stop",
      usage: data.usage
        ? { prompt: data.usage.input_tokens ?? 0, completion: data.usage.output_tokens ?? 0, total: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0) }
        : undefined,
    };
  }

  async chatStream(req: ChatRequest, onDelta: (delta: string) => void): Promise<ChatResponse> {
    const body = { ...this.buildBody(req), stream: true };
    const res = await fetchWithTimeout(`${this.opts.baseURL}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.opts.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    }, this.opts.timeoutMs);
    if (!res.ok) throw new Error(`anthropic stream ${res.status}`);
    return consumeSSE(res, onDelta, {
      init: () => ({ content: "", toolCalls: [] as ToolCall[], model: req.model } as unknown as Record<string, unknown>),
      extractDelta(json, acc) {
        const ev = json as { type?: string; delta?: { text?: string; type?: string }; content_block?: { type?: string; name?: string }; index?: number };
        const a = acc as unknown as AnthropicAcc;
        if (ev.type === "content_block_delta" && ev.delta?.text) {
          a.content += ev.delta.text;
          return ev.delta.text;
        }
        if (ev.type === "message_start" && (json as { message?: { model?: string } }).message?.model) {
          a.model = (json as { message: { model: string } }).message.model;
        }
        return null;
      },
      finalize(acc) {
        const a = acc as unknown as AnthropicAcc;
        return {
          content: a.content,
          model: a.model,
          finishReason: "stop" as const,
        };
      },
    });
  }

  private buildBody(req: ChatRequest): Record<string, unknown> {
    const system = req.messages.find((m) => m.role === "system")?.content ?? "";
    const others = req.messages.filter((m) => m.role !== "system");
    const body: Record<string, unknown> = {
      model: req.model || this.opts.defaultModel,
      max_tokens: req.maxTokens ?? 4096,
      messages: others.map((m) => {
        if (m.role === "tool") {
          return { role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }] };
        }
        if (m.role === "assistant" && m.toolCalls?.length) {
          return {
            role: "assistant",
            content: m.toolCalls.map((t) => ({ type: "tool_use", id: t.id, name: t.name, input: JSON.parse(t.arguments) })),
          };
        }
        return { role: m.role === "assistant" ? "assistant" : "user", content: m.content };
      }),
    };
    if (system) body.system = system;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
    }
    return body;
  }

}

// ============================================================================
// Gemini Provider —— /v1beta/models/{model}:generateContent
// ============================================================================

export interface GeminiProviderOptions {
  apiKey: string;
  baseURL?: string;
  defaultModel?: string;
  timeoutMs?: number;
  name?: string;
}

export class GeminiProvider implements Provider {
  readonly name: string;
  private readonly opts: Required<Omit<GeminiProviderOptions, "name">>;

  constructor(opts: GeminiProviderOptions) {
    this.name = opts.name ?? "gemini";
    this.opts = {
      apiKey: opts.apiKey,
      baseURL: (opts.baseURL ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, ""),
      defaultModel: opts.defaultModel ?? "gemini-1.5-flash",
      timeoutMs: opts.timeoutMs ?? 60_000,
    };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const model = req.model || this.opts.defaultModel;
    const url = `${this.opts.baseURL}/models/${model}:generateContent?key=${this.opts.apiKey}`;
    const body = this.buildBody(req);
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, this.opts.timeoutMs);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`gemini ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
      }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
    };
    const cand = data.candidates?.[0];
    const content = cand?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    return {
      content,
      model,
      finishReason: cand?.finishReason === "STOP" ? "stop" : undefined,
      usage: data.usageMetadata
        ? {
            prompt: data.usageMetadata.promptTokenCount ?? 0,
            completion: data.usageMetadata.candidatesTokenCount ?? 0,
            total: data.usageMetadata.totalTokenCount ?? 0,
          }
        : undefined,
    };
  }

  async chatStream(req: ChatRequest, onDelta: (delta: string) => void): Promise<ChatResponse> {
    const model = req.model || this.opts.defaultModel;
    const url = `${this.opts.baseURL}/models/${model}:streamGenerateContent?alt=sse&key=${this.opts.apiKey}`;
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(this.buildBody(req)),
    }, this.opts.timeoutMs);
    if (!res.ok) throw new Error(`gemini stream ${res.status}`);
    return consumeSSE(res, onDelta, {
      init: () => ({ content: "" } as unknown as Record<string, unknown>),
      extractDelta(json) {
        const parts = (json as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }).candidates?.[0]?.content?.parts ?? [];
        const text = parts.map((p) => p.text ?? "").join("");
        return text || null;
      },
      finalize(acc) {
        return { content: (acc as unknown as { content: string }).content, model, finishReason: "stop" as const };
      },
    });
  }

  private buildBody(req: ChatRequest): Record<string, unknown> {
    const system = req.messages.find((m) => m.role === "system")?.content;
    const contents = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));
    const body: Record<string, unknown> = { contents };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (req.temperature !== undefined) body.generationConfig = { temperature: req.temperature, maxOutputTokens: req.maxTokens ?? 4096 };
    return body;
  }

}

// ============================================================================
// Ollama Provider —— /api/chat（本地）
// ============================================================================

export interface OllamaProviderOptions {
  baseURL?: string;
  defaultModel?: string;
  timeoutMs?: number;
  name?: string;
}

export class OllamaProvider implements Provider {
  readonly name: string;
  private readonly opts: Required<OllamaProviderOptions>;

  constructor(opts: OllamaProviderOptions = {}) {
    this.name = opts.name ?? "ollama";
    this.opts = {
      name: this.name,
      baseURL: (opts.baseURL ?? "http://127.0.0.1:11434").replace(/\/$/, ""),
      defaultModel: opts.defaultModel ?? "llama3.1",
      timeoutMs: opts.timeoutMs ?? 120_000,
    };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const res = await fetchWithTimeout(`${this.opts.baseURL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(this.buildBody(req, false)),
    }, this.opts.timeoutMs);
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const data = (await res.json()) as {
      message?: { content?: string };
      model?: string;
      done_reason?: string;
      eval_count?: number;
      prompt_eval_count?: number;
    };
    return {
      content: data.message?.content ?? "",
      model: data.model ?? req.model,
      finishReason: data.done_reason === "stop" ? "stop" : undefined,
      usage: data.eval_count !== undefined
        ? { prompt: data.prompt_eval_count ?? 0, completion: data.eval_count, total: (data.prompt_eval_count ?? 0) + data.eval_count }
        : undefined,
    };
  }

  async chatStream(req: ChatRequest, onDelta: (delta: string) => void): Promise<ChatResponse> {
    const res = await fetchWithTimeout(`${this.opts.baseURL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(this.buildBody(req, true)),
    }, this.opts.timeoutMs);
    if (!res.ok) throw new Error(`ollama stream ${res.status}`);
    // Ollama 流式：每行一个 JSON（非 SSE）
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const decoder = new TextDecoder();
    let buf = "";
    let content = "";
    let model = req.model;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as { message?: { content?: string }; model?: string; done?: boolean };
          if (ev.message?.content) {
            content += ev.message.content;
            onDelta(ev.message.content);
          }
          if (ev.model) model = ev.model;
        } catch {
          // 跳过
        }
      }
    }
    return { content, model, finishReason: "stop" };
  }

  private buildBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
    return {
      model: req.model || this.opts.defaultModel,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      stream,
      options: req.temperature !== undefined ? { temperature: req.temperature } : undefined,
    };
  }

}

// ============================================================================
// 多 Provider 路由：按模型名前缀分发
// ============================================================================

export interface MultiProviderOptions {
  providers: Provider[];
  /** 默认 provider 名 */
  default?: string;
  /** 模型 → provider 映射函数 */
  resolve?: (model: string) => Provider;
}

export class MultiProvider implements Provider {
  readonly name = "multi";
  private readonly providers: Map<string, Provider>;
  private readonly defaultName: string;
  private readonly resolve?: (model: string) => Provider;

  constructor(opts: MultiProviderOptions) {
    this.providers = new Map(opts.providers.map((p) => [p.name, p]));
    this.defaultName = opts.default ?? opts.providers[0]?.name ?? "";
    this.resolve = opts.resolve;
  }

  private pick(model: string): Provider {
    if (this.resolve) {
      const p = this.resolve(model);
      if (p) return p;
    }
    // 按 name 前缀匹配
    for (const [name, p] of this.providers) {
      if (model.startsWith(name) || model.includes(name)) return p;
    }
    return this.providers.get(this.defaultName) ?? [...this.providers.values()][0];
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    return this.pick(req.model).chat(req);
  }

  async chatStream(req: ChatRequest, onDelta: (delta: string) => void): Promise<ChatResponse> {
    const p = this.pick(req.model);
    if (!p.chatStream) {
      // 不支持流式则降级为一次性
      const resp = await p.chat(req);
      if (resp.content) onDelta(resp.content);
      return resp;
    }
    return p.chatStream(req, onDelta);
  }
}
