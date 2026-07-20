/**
 * Langfuse 集成 —— 将 trace 数据发送到 Langfuse（自建或云）
 *
 * 对标 Hermes 的 Langfuse 插件：
 * - 内部队列 + 定时 flush（flushInterval）
 * - flush 时批量 POST Langfuse Ingestion API
 * - 用 crypto.randomUUID() 生成 ID
 * - Authorization: Basic base64(publicKey:secretKey)
 * - sendTracerSpans 把 InMemoryTracer 的 span 格式转为 Langfuse 格式
 * - enabled=false 时所有方法为 no-op
 *
 * 不引入 npm 依赖，用 fetch 直接调 API。
 */

import { randomUUID } from "node:crypto";

// ============================================================================
// 类型定义
// ============================================================================

export interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  /** 默认 https://cloud.langfuse.com，自建则改 */
  baseUrl?: string;
  enabled: boolean;
  /** 批量发送间隔 ms，默认 5000 */
  flushInterval?: number;
  /** 批量最大条数，默认 50 */
  batchSize?: number;
}

export interface LangfuseTrace {
  id: string;
  name: string;
  userId?: string;
  sessionId?: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface LangfuseSpan {
  id: string;
  traceId: string;
  parentId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
  statusMessage?: string;
}

export interface LangfuseGeneration {
  id: string;
  traceId: string;
  parentId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  model?: string;
  modelParameters?: Record<string, unknown>;
  input?: unknown;
  output?: unknown;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  costDetails?: Record<string, number>;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// 内部队列条目
// ============================================================================

/** 队列中的待发送事件，区分类型 */
interface QueuedEvent {
  type: "trace" | "span" | "span-update" | "generation" | "generation-update";
  payload: Record<string, unknown>;
}

// ============================================================================
// LangfuseClient 实现
// ============================================================================

export class LangfuseClient {
  private readonly config: LangfuseConfig;
  private readonly baseUrl: string;
  private readonly flushInterval: number;
  private readonly batchSize: number;
  /** 待发送事件队列 */
  private queue: QueuedEvent[] = [];
  /** 定时 flush 句柄 */
  private timer?: ReturnType<typeof setInterval>;
  /** 本地缓存：id → type，用于 update 时补全 payload */
  private readonly entityMap = new Map<string, { type: "span" | "generation"; traceId: string }>();

  constructor(config: LangfuseConfig) {
    this.config = config;
    this.baseUrl = (config.baseUrl ?? "https://cloud.langfuse.com").replace(/\/+$/, "");
    this.flushInterval = config.flushInterval ?? 5000;
    this.batchSize = config.batchSize ?? 50;

    // 启用状态下启动定时 flush
    if (config.enabled) {
      this.timer = setInterval(() => {
        // 不 await：定时器回调不关心 flush 结果
        void this.flush();
      }, this.flushInterval);
    }
  }

  // --------------------------------------------------------------------------
  // 创建 trace
  // --------------------------------------------------------------------------

  createTrace(trace: LangfuseTrace): string {
    if (!this.config.enabled) return trace.id;

    const id = trace.id || randomUUID();
    this.queue.push({
      type: "trace",
      payload: {
        id,
        name: trace.name,
        userId: trace.userId,
        sessionId: trace.sessionId,
        input: trace.input,
        output: trace.output,
        metadata: trace.metadata,
        tags: trace.tags,
        timestamp: new Date().toISOString(),
      },
    });
    this.checkFlush();
    return id;
  }

  // --------------------------------------------------------------------------
  // 创建 span
  // --------------------------------------------------------------------------

  createSpan(span: LangfuseSpan): string {
    if (!this.config.enabled) return span.id;

    const id = span.id || randomUUID();
    this.entityMap.set(id, { type: "span", traceId: span.traceId });

    this.queue.push({
      type: "span",
      payload: {
        id,
        traceId: span.traceId,
        parentId: span.parentId,
        name: span.name,
        startTime: new Date(span.startTime).toISOString(),
        endTime: span.endTime ? new Date(span.endTime).toISOString() : undefined,
        input: span.input,
        output: span.output,
        metadata: span.metadata,
        level: span.level ?? "DEFAULT",
        statusMessage: span.statusMessage,
      },
    });
    this.checkFlush();
    return id;
  }

  // --------------------------------------------------------------------------
  // 创建 generation（LLM 调用）
  // --------------------------------------------------------------------------

  createGeneration(gen: LangfuseGeneration): string {
    if (!this.config.enabled) return gen.id;

    const id = gen.id || randomUUID();
    this.entityMap.set(id, { type: "generation", traceId: gen.traceId });

    this.queue.push({
      type: "generation",
      payload: {
        id,
        traceId: gen.traceId,
        parentId: gen.parentId,
        name: gen.name,
        startTime: new Date(gen.startTime).toISOString(),
        endTime: gen.endTime ? new Date(gen.endTime).toISOString() : undefined,
        model: gen.model,
        modelParameters: gen.modelParameters,
        input: gen.input,
        output: gen.output,
        usage: gen.usage,
        costDetails: gen.costDetails,
        metadata: gen.metadata,
      },
    });
    this.checkFlush();
    return id;
  }

  // --------------------------------------------------------------------------
  // 更新 span
  // --------------------------------------------------------------------------

  updateSpan(id: string, update: Partial<LangfuseSpan>): void {
    if (!this.config.enabled) return;

    const payload: Record<string, unknown> = { id };
    if (update.endTime !== undefined) payload.endTime = new Date(update.endTime).toISOString();
    if (update.output !== undefined) payload.output = update.output;
    if (update.metadata !== undefined) payload.metadata = update.metadata;
    if (update.level !== undefined) payload.level = update.level;
    if (update.statusMessage !== undefined) payload.statusMessage = update.statusMessage;

    this.queue.push({ type: "span-update", payload });
    this.checkFlush();
  }

  // --------------------------------------------------------------------------
  // 更新 generation
  // --------------------------------------------------------------------------

  updateGeneration(id: string, update: Partial<LangfuseGeneration>): void {
    if (!this.config.enabled) return;

    const payload: Record<string, unknown> = { id };
    if (update.endTime !== undefined) payload.endTime = new Date(update.endTime).toISOString();
    if (update.output !== undefined) payload.output = update.output;
    if (update.usage !== undefined) payload.usage = update.usage;
    if (update.model !== undefined) payload.model = update.model;
    if (update.modelParameters !== undefined) payload.modelParameters = update.modelParameters;
    if (update.costDetails !== undefined) payload.costDetails = update.costDetails;
    if (update.metadata !== undefined) payload.metadata = update.metadata;

    this.queue.push({ type: "generation-update", payload });
    this.checkFlush();
  }

  // --------------------------------------------------------------------------
  // 手动 flush
  // --------------------------------------------------------------------------

  async flush(): Promise<void> {
    if (!this.config.enabled || this.queue.length === 0) return;

    // 取出待发送条目（最多 batchSize）
    const batch = this.queue.splice(0, this.batchSize);
    if (batch.length === 0) return;

    // Langfuse Ingestion API：POST /api/public/traces
    // 把所有事件包装为 ingestion 批量格式
    const body = {
      batch: batch.map((evt) => ({
        id: randomUUID(),
        type: evt.type,
        body: evt.payload,
        timestamp: new Date().toISOString(),
      })),
    };

    const authHeader =
      "Basic " +
      Buffer.from(`${this.config.publicKey}:${this.config.secretKey}`).toString("base64");

    try {
      const resp = await fetch(`${this.baseUrl}/api/public/traces`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        // 发送失败：把 batch 放回队列头部，下次重试
        this.queue.unshift(...batch);
      }
    } catch {
      // 网络错误：放回队列头部，下次重试
      this.queue.unshift(...batch);
    }
  }

  // --------------------------------------------------------------------------
  // 关闭（flush + 停止定时器）
  // --------------------------------------------------------------------------

  async shutdown(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.flush();
  }

  // --------------------------------------------------------------------------
  // 从 InMemoryTracer 的 spans 转换并发送
  // --------------------------------------------------------------------------

  sendTracerSpans(
    spans: Array<{
      traceId: string;
      spanId: string;
      name: string;
      kind: string;
      startedAt: number;
      endedAt?: number;
      status: string;
      attributes?: Record<string, unknown>;
      error?: string;
    }>,
  ): void {
    if (!this.config.enabled) return;

    // 按 traceId 分组：每个 traceId 创建一个 LangfuseTrace，其下挂 span
    const traceGroups = new Map<string, Array<(typeof spans)[0]>>();
    for (const s of spans) {
      const group = traceGroups.get(s.traceId) ?? [];
      group.push(s);
      traceGroups.set(s.traceId, group);
    }

    for (const [traceId, group] of traceGroups) {
      // 创建 trace
      this.createTrace({
        id: traceId,
        name: group[0]?.name ?? "tracer-session",
      });

      // 每个 tracer span 转为 Langfuse span
      for (const s of group) {
        // 根据属性判断是否为 LLM generation
        const isGeneration =
          s.kind === "provider" ||
          (s.attributes?.["type"] === "generation");

        const level = s.status === "error" ? "ERROR" : s.status === "ok" ? "DEFAULT" : "DEFAULT";

        if (isGeneration) {
          this.createGeneration({
            id: s.spanId,
            traceId: s.traceId,
            name: s.name,
            startTime: s.startedAt,
            endTime: s.endedAt,
            model: s.attributes?.["model"] as string | undefined,
            input: s.attributes?.["input"],
            output: s.attributes?.["output"],
            usage: s.attributes?.["usage"] as LangfuseGeneration["usage"],
            metadata: s.attributes,
          });
        } else {
          this.createSpan({
            id: s.spanId,
            traceId: s.traceId,
            name: s.name,
            startTime: s.startedAt,
            endTime: s.endedAt,
            input: s.attributes?.["input"],
            output: s.attributes?.["output"],
            metadata: s.attributes,
            level,
            statusMessage: s.error,
          });
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // 内部：队列达到 batchSize 时自动 flush
  // --------------------------------------------------------------------------

  private checkFlush(): void {
    if (this.queue.length >= this.batchSize) {
      void this.flush();
    }
  }
}
