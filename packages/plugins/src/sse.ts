import type { Plugin, PluginContext } from "@micro-agent/core";

export interface SSEClient {
  id: string;
  userId?: string;
  sessionId?: string;
  write: (data: string) => boolean | void;
  end?: () => void;
}

export interface SyncEvent {
  id: string;
  type: string;
  timestamp: number;
  userId?: string;
  sessionId?: string;
  payload: unknown;
}

let clientIdCounter = 0;

function generateClientId(): string {
  return `sse-${Date.now()}-${(++clientIdCounter).toString(36)}`;
}

function sanitizeSSEField(value: string): string {
  return value.replace(/[\r\n]/g, "");
}

function sanitizeEvent(evt: SyncEvent): SyncEvent {
  return {
    ...evt,
    id: sanitizeSSEField(String(evt.id ?? "")),
    type: sanitizeSSEField(String(evt.type ?? "message")),
  };
}

export class SSEServer {
  private clients = new Map<string, SSEClient>();
  private history: SyncEvent[] = [];
  private pingTimer?: ReturnType<typeof setInterval>;
  private unsub?: () => void;
  private seq = 0;
  private disposed = false;
  private keepHistory: number;

  constructor(ctx: PluginContext, keepHistory = 1000, pingIntervalMs = 15000) {
    this.keepHistory = keepHistory;
    this.unsub = ctx.bus.on("*", (raw: any) => {
      if (this.disposed) return;
      if (!raw || typeof raw !== "object" || !("event" in raw)) return;
      const { event, payload } = raw;
      const syncEvent: SyncEvent = sanitizeEvent({
        id: `evt-${++this.seq}`,
        type: String(event),
        timestamp: Date.now(),
        payload,
        userId: (payload as any)?.identity?.userId ?? (payload as any)?.userId,
        sessionId: (payload as any)?.identity?.sessionId ?? (payload as any)?.sessionId,
      });
      this.history.push(syncEvent);
      if (this.history.length > this.keepHistory) {
        this.history.splice(0, this.history.length - this.keepHistory);
      }
      this.broadcast(syncEvent);
    });
    if (pingIntervalMs > 0) {
      this.pingTimer = setInterval(() => this.ping(), pingIntervalMs);
    }
  }

  addClient(client: Omit<SSEClient, "id"> & { id?: string }, lastEventId?: string): SSEClient {
    const id = client.id ?? generateClientId();
    const c: SSEClient = { ...client, id };
    this.clients.set(id, c);
    let dataStr: string;
    try {
      dataStr = JSON.stringify({ clientId: id });
    } catch {
      dataStr = JSON.stringify({ error: "serialization failed" });
    }
    try {
      c.write(`event: connected\ndata: ${dataStr}\n\n`);
    } catch {
      this.clients.delete(id);
      return c;
    }
    let replayFrom = 0;
    if (lastEventId) {
      const idx = this.history.findIndex((e) => e.id === lastEventId);
      if (idx >= 0) replayFrom = idx + 1;
    } else {
      replayFrom = Math.max(0, this.history.length - 10);
    }
    for (let i = replayFrom; i < this.history.length; i++) {
      const evt = this.history[i];
      if (this.matches(c, evt)) this.send(c, evt);
    }
    return c;
  }

  removeClient(id: string): void {
    this.clients.delete(id);
  }

  broadcast(event: SyncEvent): void {
    if (this.disposed) return;
    const safe = sanitizeEvent(event);
    const toRemove: string[] = [];
    for (const [cid, c] of this.clients) {
      if (this.matches(c, safe)) {
        if (!this.send(c, safe)) toRemove.push(cid);
      }
    }
    for (const cid of toRemove) this.clients.delete(cid);
  }

  getClientCount(): number { return this.clients.size; }

  close(): void {
    this.disposed = true;
    if (this.unsub) this.unsub();
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const c of this.clients.values()) c.end?.();
    this.clients.clear();
    this.history = [];
  }

  private matches(c: SSEClient, evt: SyncEvent): boolean {
    if (c.userId) {
      if (evt.userId && c.userId !== evt.userId) return false;
    } else {
      if (evt.userId) return false;
    }
    if (c.sessionId && evt.sessionId && c.sessionId !== evt.sessionId) return false;
    return true;
  }

  private send(c: SSEClient, rawEvt: SyncEvent): boolean {
    const evt = sanitizeEvent(rawEvt);
    let dataStr: string;
    try {
      dataStr = JSON.stringify(evt);
    } catch {
      try {
        dataStr = JSON.stringify({ id: evt.id, type: "error", timestamp: evt.timestamp, payload: { error: "serialization failed" } });
      } catch {
        return true;
      }
    }
    try {
      const ok = c.write(`event: ${evt.type}\nid: ${evt.id}\ndata: ${dataStr}\n\n`);
      if (ok === false) {
        console.warn(`SSE client ${c.id} buffer full, backpressure`);
      }
      return true;
    } catch {
      return false;
    }
  }

  private ping(): void {
    if (this.disposed) return;
    let dataStr: string;
    try {
      dataStr = JSON.stringify({ ts: Date.now() });
    } catch {
      dataStr = "{}";
    }
    const msg = `event: ping\ndata: ${dataStr}\n\n`;
    const toRemove: string[] = [];
    for (const [cid, c] of this.clients) {
      try {
        const ok = c.write(msg);
        if (ok === false) {
          console.warn(`SSE client ${c.id} buffer full on ping`);
        }
      } catch {
        toRemove.push(cid);
      }
    }
    for (const cid of toRemove) this.clients.delete(cid);
  }
}

export interface SSEPluginOptions {
  keepHistory?: number;
  pingIntervalMs?: number;
}

export function ssePlugin(opts: SSEPluginOptions = {}): Plugin {
  return {
    name: "sse",
    version: "0.1.0",
    dependencies: [],
    install(ctx: PluginContext) {
      const server = new SSEServer(ctx, opts.keepHistory ?? 1000, opts.pingIntervalMs ?? 15000);
      ctx.registerService?.("sse.server", server);
      return () => server.close();
    },
  };
}

export function getSSEServer(ctx: PluginContext): SSEServer | undefined {
  return ctx.getService?.<SSEServer>("sse.server");
}
