/**
 * @micro-agent/core —— 极简 EventBus（进程内发布订阅）
 *
 * 核心职责：插件间解耦通信。不做 SSE/远程，那是 plugins/sse 的事。
 */

import type { EventBusLike, EventHandler } from "./types.js";

type Handler = EventHandler<any>;

export class EventBus implements EventBusLike {
  private handlers = new Map<string, Set<Handler>>();
  private onError?: (error: unknown, event: string) => void;

  setErrorHandler(handler: (error: unknown, event: string) => void): void {
    this.onError = handler;
  }

  on<T = unknown>(event: string, handler: EventHandler<T>): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler as Handler);
    return () => this.off(event, handler as Handler);
  }

  off(event: string, handler: Handler): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit<T = unknown>(event: string, payload: T): void {
    const report = (err: unknown) => {
      if (this.onError) {
        try { this.onError(err, event); } catch { /* swallow */ }
      }
    };
    const set = this.handlers.get(event);
    if (set) {
      for (const h of set) {
        try {
          const ret = h(payload);
          if (ret && typeof (ret as Promise<unknown>).then === "function") {
            (ret as Promise<unknown>).catch(report);
          }
        } catch (err) {
          report(err);
        }
      }
    }
    const star = this.handlers.get("*");
    if (star && event !== "*") {
      const wrapped = { event, payload };
      for (const h of star) {
        try {
          const ret = h(wrapped);
          if (ret && typeof (ret as Promise<unknown>).then === "function") {
            (ret as Promise<unknown>).catch(report);
          }
        } catch (err) {
          report(err);
        }
      }
    }
  }

  once<T = unknown>(event: string, handler: EventHandler<T>): () => void {
    const wrapped: Handler = (p: any) => { off(); (handler as Handler)(p); };
    const off = () => this.off(event, wrapped);
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(wrapped);
    return off;
  }

  removeAllListeners(event?: string): void {
    if (event) this.handlers.delete(event);
    else this.handlers.clear();
  }
}

export function createEventBus(): EventBus {
  return new EventBus();
}
