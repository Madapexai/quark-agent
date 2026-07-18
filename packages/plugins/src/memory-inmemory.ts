import type { Plugin, PluginContext, Memory, MemoryEntry, MemoryQuery } from "@micro-agent/core";

export class InMemoryStore implements Memory {
  private entries = new Map<string, MemoryEntry>();
  private seq = 0;
  constructor(private userId?: string) {}

  async add(entry: Omit<MemoryEntry, "id" | "createdAt">): Promise<string> {
    const id = `mem-${Date.now().toString(36)}-${(++this.seq).toString(36)}`;
    const full: MemoryEntry = { ...entry, id, createdAt: Date.now() };
    this.entries.set(id, full);
    return id;
  }

  async search(query: MemoryQuery): Promise<MemoryEntry[]> {
    const results: MemoryEntry[] = [];
    for (const e of this.entries.values()) {
      if (this.userId && e.userId !== this.userId) continue;
      if (query.userId && e.userId !== query.userId) continue;
      if (query.sessionId && e.sessionId !== query.sessionId) continue;
      if (query.kind && e.kind !== query.kind) continue;
      if (query.layer && e.layer !== query.layer) continue;
      if (query.domain && e.domain !== query.domain) continue;
      if (query.query) {
        if (typeof e.content !== "string") continue;
        if (!e.content.toLowerCase().includes(query.query.toLowerCase())) continue;
      }
      results.push(e);
    }
    results.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));
    return results.slice(0, query.topK ?? 10);
  }

  async get(id: string): Promise<MemoryEntry | null> { return this.entries.get(id) ?? null; }
  async delete(id: string): Promise<void> { this.entries.delete(id); }
  async list(filter: { userId?: string; sessionId?: string; layer?: MemoryEntry["layer"]; kind?: MemoryEntry["kind"] }): Promise<MemoryEntry[]> {
    return this.search({ query: "", ...filter, topK: 1000 });
  }
  async close(): Promise<void> { this.entries.clear(); }
}

export interface InMemoryPluginOptions {
  asDefault?: boolean;
}

export function inMemoryPlugin(opts: InMemoryPluginOptions = {}): Plugin {
  return {
    name: "memory-inmemory",
    version: "0.1.0",
    dependencies: [],
    install(ctx: PluginContext) {
      if (opts.asDefault) {
        ctx.registerService("memory", createInMemoryMemory());
      }
      return () => {};
    },
  };
}

export function createInMemoryMemory(userId?: string): Memory {
  return new InMemoryStore(userId);
}
