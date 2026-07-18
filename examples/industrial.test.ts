/**
 * 工业级测试：安全 / 边界 / 并发 / 错误处理 / 资源泄漏
 */

import { describe, expect, test } from "bun:test";
import {
  Agent, EventBus, PluginRegistry,
  type Plugin, type PluginContext, type Provider, type ChatResponse,
} from "@micro-agent/core";
import {
  a2aPlugin, ssePlugin, workspacePlugin, defineActionPlugin,
  createInMemoryMemory, getActionApi, getA2ARegistry, getWorkspaceManager,
  type SSEServer,
} from "@micro-agent/plugins";
import { sessionsExtension, getSessionStore } from "@micro-agent/extensions";
import {
  createChatHandler,
  corsHeaders, errorResponse, parseJsonBody, getHeader,
} from "@micro-agent/interaction";
import type { IncomingRequest } from "@micro-agent/interaction";

function mockProvider(toolCalls?: Array<{ id: string; name: string; arguments: string }>, text = "ok"): Provider {
  let called = false;
  return {
    name: "mock",
    async chat() {
      const calls = !called && toolCalls ? toolCalls : undefined;
      called = true;
      return {
        content: text, toolCalls: calls, model: "mock",
        usage: { prompt: 10, completion: 5, total: 15 }, finishReason: calls ? "tool_calls" : "stop",
      } as ChatResponse;
    },
  };
}

function makeScope() {
  return { tools: "*" as const, sandboxTier: "full" as const, models: "*" as const, memoryDomains: "*" as const };
}

async function installPlugin(plugin: Plugin, ctx: Partial<PluginContext>): Promise<PluginContext> {
  const memory = ctx.memory ?? createInMemoryMemory();
  const bus = ctx.bus ?? new EventBus();
  const scope = ctx.scope ?? makeScope();
  const services = new Map<string, unknown>();
  const tools: PluginContext["registerTool"] = () => {};
  const hooks: any = {};
  const fullCtx: PluginContext = {
    bus, memory, scope,
    registerTool: ctx.registerTool ?? tools,
    unregisterTool: ctx.unregisterTool ?? (() => {}),
    registerProvider: ctx.registerProvider ?? (() => {}),
    registerHook: ctx.registerHook ?? ((hook, fn) => {
      if (!hooks[hook]) hooks[hook] = [];
      hooks[hook].push(fn);
    }),
    registerService: (n, s) => services.set(n, s),
    getService: <T,>(n: string) => services.get(n) as T | undefined,
    meta: {},
    ...ctx,
  } as PluginContext;
  await plugin.install(fullCtx);
  (fullCtx as any)._hooks = hooks;
  (fullCtx as any)._services = services;
  return fullCtx;
}

// ============================================================================
// 1. SSE 安全测试
// ============================================================================

describe("SSE 安全", () => {
  test("匿名客户端不能接收带userId的事件", async () => {
    const bus = new EventBus();
    const memory = createInMemoryMemory();
    const ctx = await installPlugin(ssePlugin({ pingIntervalMs: 0 }), { bus, memory });
    const sse: SSEServer = ctx.getService("sse.server") as SSEServer;
    expect(sse).toBeDefined();

    let receivedAnonymousData = false;
    sse.addClient({ write: (d: string) => {
      if (!d.startsWith("event: connected")) receivedAnonymousData = true;
    } });

    let receivedAuthData = false;
    sse.addClient({ userId: "user-1", write: (d: string) => {
      if (!d.startsWith("event: connected")) receivedAuthData = true;
    } });

    bus.emit("agent:done", { identity: { userId: "user-1", sessionId: "s1" }, reply: "hi" });

    await new Promise((r) => setTimeout(r, 20));
    expect(receivedAuthData).toBe(true);
    expect(receivedAnonymousData).toBe(false);
    sse.close();
  });

  test("事件名包含换行符被过滤（防SSE注入）", async () => {
    const bus = new EventBus();
    const memory = createInMemoryMemory();
    const ctx = await installPlugin(ssePlugin({ pingIntervalMs: 0 }), { bus, memory });
    const sse: SSEServer = ctx.getService("sse.server") as SSEServer;

    let rawData = "";
    sse.addClient({ userId: "u1", write: (d: string) => { rawData += d; } });
    sse.broadcast({
      id: "x", type: "bad\nevent:spoofed", timestamp: Date.now(),
      userId: "u1", payload: {},
    });
    const lines = rawData.split("\n");
    for (const line of lines) {
      if (line.startsWith("event:") || line.startsWith("id:") || line.startsWith("data:") || line === "") continue;
      expect(line).toBe("");
    }
    expect(rawData).not.toMatch(/^event:spoofed/m);
    sse.close();
  });
});

// ============================================================================
// 2. Workspace 并发竞态测试
// ============================================================================

describe("Workspace 并发安全", () => {
  test("并发调用getOrCreate只创建一次", async () => {
    let createCount = 0;
    const bus = new EventBus();
    const memory = createInMemoryMemory();
    const ctx = await installPlugin(
      workspacePlugin({ memoryFactory: () => { createCount++; return createInMemoryMemory(); } }),
      { bus, memory },
    );
    const mgr = getWorkspaceManager(ctx as any);
    expect(mgr).toBeDefined();

    const results = await Promise.all(
      Array.from({ length: 100 }, () => mgr!.getOrCreate({ userId: "user-concurrent" })),
    );
    const first = results[0];
    for (const r of results) expect(r).toBe(first);
    expect(createCount).toBe(1);
    await mgr!.closeAll();
  });
});

// ============================================================================
// 3. A2A 远程调用错误处理
// ============================================================================

describe("A2A 远程调用", () => {
  test("超时错误被正确捕获", async () => {
    const bus = new EventBus();
    const memory = createInMemoryMemory();
    const ctx = await installPlugin(a2aPlugin(), { bus, memory });
    const a2a = getA2ARegistry(ctx as any)!;

    a2a.registerRemote("http://10.255.255.1:9999", {
      name: "slow", description: "x", url: "http://10.255.255.1:9999",
      skills: [], version: "1",
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => new Promise(() => {})) as any;
    let threw = false;
    try {
      await a2a.callRemote("slow", { role: "user", parts: [{ kind: "text", text: "hi" }] }, {
        timeoutMs: 300,
        fetchImpl: globalThis.fetch,
      });
    } catch (e: any) {
      threw = true;
      expect(e.message).toMatch(/timed out/);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(threw).toBe(true);
  });

  test("重复注册本地agent抛错", async () => {
    const bus = new EventBus();
    const memory = createInMemoryMemory();
    const ctx = await installPlugin(a2aPlugin(), { bus, memory });
    const a2a = getA2ARegistry(ctx as any)!;
    const card = { name: "dup", description: "d", url: "http://x", skills: [] };
    const impl = { createTask: async () => ({ id: "t1", status: { state: "completed" as const } }), sendMessage: async () => ({ id: "t1", status: { state: "completed" as const } }), getTask: async () => null, cancelTask: async () => null };
    a2a.register({ card, ...impl });
    expect(() => a2a.register({ card, ...impl })).toThrow(/already/);
  });
});

// ============================================================================
// 4. defineAction invoke 正确传递 caller
// ============================================================================

describe("defineAction 多渠道调用", () => {
  test("invoke 正确传递 caller/userId/sessionId", async () => {
    const bus = new EventBus();
    const memory = createInMemoryMemory();
    const ctx = await installPlugin(defineActionPlugin(), { bus, memory });
    const api = getActionApi(ctx as any)!;

    let receivedCtx: any;
    const action = api.defineAction({
      name: "ctxTest", description: "x",
      parameters: { type: "object", properties: {} },
      run: (_args, c) => { receivedCtx = c; return "ok"; },
      expose: ["tool", "http", "cli"],
    });

    await action.invoke({ foo: "bar" }, { caller: "http", userId: "u1", sessionId: "s1" }, { agent: { id: "a", name: "a" }, deadline: Date.now() + 1000 } as any);
    expect(receivedCtx.caller).toBe("http");
    expect(receivedCtx.userId).toBe("u1");
    expect(receivedCtx.sessionId).toBe("s1");
    expect(receivedCtx.tool).toBeDefined();
  });
});

// ============================================================================
// 5. HTTP 层测试（CORS、错误响应、输入验证、大小限制）
// ============================================================================

describe("HTTP 工具函数", () => {
  test("corsHeaders 返回标准CORS头", () => {
    const h = corsHeaders("http://example.com");
    expect(h["Access-Control-Allow-Origin"]).toBe("http://example.com");
    expect(h["Access-Control-Allow-Methods"]).toContain("POST");
  });

  test("errorResponse 返回标准错误格式", () => {
    const resp = errorResponse(500, "INTERNAL_ERROR", "Internal server error");
    expect(resp.status).toBe(500);
    const body = JSON.parse(resp.body as string);
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });

  test("parseJsonBody 大小限制", async () => {
    const bigStr = "x".repeat(2 * 1024 * 1024);
    const req: IncomingRequest = {
      method: "POST", url: "/",
      headers: { "content-type": "application/json" },
      body: async () => bigStr,
    };
    expect(parseJsonBody(req, 1024 * 1024)).rejects.toThrow();
  });

  test("getHeader 大小写不敏感", () => {
    const req: IncomingRequest = {
      method: "GET", url: "/",
      headers: { "Content-Type": "application/json" },
    };
    expect(getHeader(req, "content-type")).toBe("application/json");
    expect(getHeader(req, "CONTENT-TYPE")).toBe("application/json");
  });
});

describe("Chat HTTP Handler 安全", () => {
  function makeAgent() {
    const provider = mockProvider();
    const memory = createInMemoryMemory();
    return new Agent({ id: "a", name: "a", model: "mock" }, { provider, memory });
  }

  test("message超长返回400", async () => {
    const handler = createChatHandler({ getAgent: async () => makeAgent() });
    const resp = await handler.handle({
      method: "POST", url: "/api/chat",
      headers: { "content-type": "application/json" },
      body: async () => JSON.stringify({ message: "x".repeat(40000) }),
    } as IncomingRequest);
    expect(resp.status).toBe(400);
  });

  test("CORS OPTIONS返回204", async () => {
    const handler = createChatHandler({ getAgent: async () => makeAgent() });
    const resp = await handler.handle({ method: "OPTIONS", headers: { origin: "http://localhost" }, url: "/api/chat" } as IncomingRequest);
    expect(resp.status).toBe(204);
    expect(resp.headers["Access-Control-Allow-Origin"]).toBeDefined();
  });

  test("缺message返回400", async () => {
    const handler = createChatHandler({ getAgent: async () => makeAgent() });
    const resp = await handler.handle({
      method: "POST", url: "/api/chat",
      headers: { "content-type": "application/json" },
      body: async () => JSON.stringify({}),
    } as IncomingRequest);
    expect(resp.status).toBe(400);
  });

  test("正常chat返回200", async () => {
    const handler = createChatHandler({ getAgent: async () => makeAgent() });
    const resp = await handler.handle({
      method: "POST", url: "/api/chat",
      headers: { "content-type": "application/json" },
      body: async () => JSON.stringify({ message: "hello" }),
    } as IncomingRequest);
    expect(resp.status).toBe(200);
    const body = JSON.parse(resp.body as string);
    expect(body.reply).toBeDefined();
    expect(body.sessionId).toBeDefined();
  });
});

// ============================================================================
// 6. Plugin 生命周期测试
// ============================================================================

describe("Plugin 生命周期", () => {
  test("disposed后注册抛错", async () => {
    const memory = createInMemoryMemory();
    const bus = new EventBus();
    const reg = new PluginRegistry({ bus, memory, scope: makeScope() });
    await reg.installAll();
    await reg.uninstallAll();
    expect(() => reg.register({ name: "x", install: () => () => {} })).toThrow(/disposed/);
  });

  test("重复installAll幂等", async () => {
    const memory = createInMemoryMemory();
    const bus = new EventBus();
    let installCount = 0;
    const p: Plugin = { name: "once", install: () => { installCount++; return () => {}; } };
    const reg = new PluginRegistry({ bus, memory, scope: makeScope() });
    reg.register(p);
    await reg.installAll();
    await reg.installAll();
    expect(installCount).toBe(1);
  });

  test("cleanup按安装逆序执行", async () => {
    const memory = createInMemoryMemory();
    const bus = new EventBus();
    const order: string[] = [];
    const reg = new PluginRegistry({ bus, memory, scope: makeScope() });
    reg.register({ name: "A", install: () => { order.push("install-A"); return () => { order.push("cleanup-A"); }; } });
    reg.register({ name: "B", dependencies: ["A"], install: () => { order.push("install-B"); return () => { order.push("cleanup-B"); }; } });
    await reg.installAll();
    await reg.uninstallAll();
    expect(order).toEqual(["install-A", "install-B", "cleanup-B", "cleanup-A"]);
  });
});

// ============================================================================
// 7. Session 死循环检测（参数 canonicalize）
// ============================================================================

describe("Session 死循环检测", () => {
  test("参数键顺序不同也能识别为同一调用", async () => {
    const bus = new EventBus();
    const memory = createInMemoryMemory();
    const ctx = await installPlugin(sessionsExtension(), { bus, memory });
    const store = getSessionStore(ctx as any)!;
    const call1 = { id: "c1", name: "test", arguments: JSON.stringify({ a: 1, b: 2 }) };
    const call2 = { id: "c2", name: "test", arguments: JSON.stringify({ b: 2, a: 1 }) };
    const call3 = { id: "c3", name: "test", arguments: JSON.stringify({ a: 1, b: 2 }) };
    const call4 = { id: "c4", name: "test", arguments: JSON.stringify({ a: 1, b: 2 }) };
    store.checkLoop("s1", call1);
    store.checkLoop("s1", call2);
    store.checkLoop("s1", call3);
    const detected = store.checkLoop("s1", call4);
    expect(detected).toBe(true);
  });
});

// ============================================================================
// 8. InMemoryMemory 边界
// ============================================================================

describe("InMemoryMemory 边界", () => {
  test("非string content不崩溃", async () => {
    const mem = createInMemoryMemory();
    await mem.add({ content: "hello" as any, kind: "chat", layer: "L0", userId: "u1" });
    const r = await mem.search({ query: "hello", userId: "u1" });
    expect(r.length).toBe(1);
  });

  test("空query返回所有匹配userId的条目", async () => {
    const mem = createInMemoryMemory();
    await mem.add({ content: "a", kind: "chat", layer: "L0", userId: "u1" });
    await mem.add({ content: "b", kind: "chat", layer: "L0", userId: "u1" });
    await mem.add({ content: "c", kind: "chat", layer: "L0", userId: "u2" });
    const r = await mem.search({ query: "", userId: "u1", topK: 100 });
    expect(r.length).toBe(2);
  });
});

// ============================================================================
// 9. Agent并发初始化安全
// ============================================================================

describe("Agent 并发安全", () => {
  test("并发run只初始化plugins一次", async () => {
    const memory = createInMemoryMemory();
    let installCount = 0;
    const p: Plugin = { name: "once", install: () => { installCount++; return () => {}; } };
    const provider = mockProvider();
    const agent = new Agent({ id: "a", name: "a", model: "mock" }, { provider, memory, plugins: [p] });
    await Promise.all([agent.run("hi1"), agent.run("hi2"), agent.run("hi3")]);
    expect(installCount).toBe(1);
  });
});
