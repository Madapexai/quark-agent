/**
 * Tracer 实现：内置轻量 tracing，可导出为 OpenTelemetry 兼容 span
 *
 * 设计（调研 §四 Voltagent）：
 * - 默认开，零配置
 * - 进程内 span 树，树形结构记录 parent
 * - export() 返回 OTel 风格 span，便于对接外部 collector
 */

import type { Span, SpanKind, Tracer } from "../core/types.js";

export class InMemoryTracer implements Tracer {
  private spans: Span[] = [];
  private counter = 0;

  startSpan(
    name: string,
    kind: SpanKind,
    attributes: Record<string, unknown> = {},
  ): Span {
    const span: Span = {
      traceId: this.genId(16),
      spanId: this.genId(8),
      name,
      kind,
      startedAt: Date.now(),
      attributes,
      status: "unset",
    };
    this.spans.push(span);
    return span;
  }

  endSpan(span: Span, status: Span["status"] = "ok", error?: string): void {
    span.endedAt = Date.now();
    span.status = status;
    if (error) span.error = error;
  }

  export(): Span[] {
    return [...this.spans];
  }

  /** 清空已结束的 span，控制内存占用 */
  flush(): Span[] {
    const done = this.spans.filter((s) => s.endedAt !== undefined);
    this.spans = this.spans.filter((s) => s.endedAt === undefined);
    return done;
  }

  /** 简要统计：各 kind 的 span 数与平均耗时 */
  stats(): Record<string, { count: number; avgMs: number; errors: number }> {
    const acc: Record<string, { count: number; totalMs: number; errors: number }> = {};
    for (const s of this.spans) {
      if (s.endedAt === undefined) continue;
      const k = s.kind;
      acc[k] ??= { count: 0, totalMs: 0, errors: 0 };
      acc[k].count++;
      acc[k].totalMs += (s.endedAt - s.startedAt);
      if (s.status === "error") acc[k].errors++;
    }
    const out: Record<string, { count: number; avgMs: number; errors: number }> = {};
    for (const [k, v] of Object.entries(acc)) {
      out[k] = { count: v.count, avgMs: v.count > 0 ? Math.round(v.totalMs / v.count) : 0, errors: v.errors };
    }
    return out;
  }

  private genId(len: number): string {
    this.counter = (this.counter + 1) % 0x10000;
    const rand = Math.random().toString(16).slice(2);
    return (Date.now().toString(16) + this.counter.toString(16) + rand).slice(0, len);
  }
}

/**
 * 简易 console 输出器：把 span 树打印为缩进列表，便于本地调试。
 * 对接外部 OTel collector 时可不用它。
 */
export function printSpanTree(spans: Span[]): string {
  const ended = spans.filter((s) => s.endedAt !== undefined);
  ended.sort((a, b) => a.startedAt - b.startedAt);
  const lines: string[] = [];
  for (const s of ended) {
    const dur = (s.endedAt! - s.startedAt).toString().padStart(5);
    const status = s.status === "ok" ? "✓" : s.status === "error" ? "✗" : "·";
    lines.push(`  ${status} [${dur}ms] ${s.kind}/${s.name}${s.error ? ` — ${s.error}` : ""}`);
  }
  return lines.join("\n");
}
