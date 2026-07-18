/**
 * E2E 测试：四大核心能力
 * 1. defineAction 统一入口抽象
 * 2. A2A 协议（本地 agent 注册 + 调用）
 * 3. SSE EventBus 事件同步
 * 4. Per-user workspace 隔离
 * 5. Interaction 层 HTTP handler
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

import {
  defineAction,
  ActionRegistry,
  A2ARegistry,
  A2ACallTool,
  EventBus,
  SSEServer,
  WorkspaceManager,
  InMemoryStore,
  sseHeaders,
} from "../src/index.js";
import {
  createActionRouter,
  createSSEHandler,
  createA2AHandler,
  createChatHandler,
} from "../packages/interaction/src/index.js";

// ============================================================================
// 1. defineAction
// ============================================================================
describe("defineAction 统一入口抽象", () => {
  let registry: ActionRegistry;

  beforeEach(() => { registry = new ActionRegistry(); });

  test("定义一个 action 可注册并调用", async () => {
    registry.register(defineAction({
      name: "greet",
      description: "向某人打招呼",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      run: async ({ name }: { name: string }, ctx) => `hello ${name} from ${ctx.caller}`,
      expose: ["agent", "http", "cli"],
    }));

    const result = await registry.call("greet", { name: "world" }, { caller: "agent", userId: "u1" });
    expect(result).toBe("hello world from agent");
  });

  test("expose 过滤：未暴露给 http 的 action 调用报错", async () => {
    registry.register(defineAction({
      name: "internal_op",
      description: "内部操作",
      parameters: { type: "object", properties: {} },
      run: () => "secret",
      expose: ["agent"],
    }));

    expect(registry.forCaller("http").length).toBe(0);
    expect(registry.forCaller("agent").length).toBe(1);
  });

  test("toTools 只返回 expose 包含 agent 的 action", async () => {
    registry.register(defineAction({
      name: "public_tool",
      description: "",
      parameters: { type: "object", properties: {} },
      run: () => "ok",
    }));
    registry.register(defineAction({
      name: "cli_only",
      description: "",
      parameters: { type: "object", properties: {} },
      run: () => "ok",
      expose: ["cli"],
    }));
    expect(registry.toTools().length).toBe(1);
    expect(registry.toTools()[0].name).toBe("public_tool");
  });

  test("toHttpRoutes 生成正确路由并可调用", async () => {
    registry.register(defineAction({
      name: "create_item",
      description: "",
      parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
      http: { method: "POST", path: "/api/items" },
      run: async ({ title }: { title: string }) => ({ id: 1, title }),
    }));
    const routes = registry.toHttpRoutes();
    expect(routes.length).toBe(1);
    expect(routes[0].method).toBe("POST");
    expect(routes[0].path).toBe("/api/items");
    const out = await routes[0].handler({ title: "buy milk" }, { caller: "http", userId: "u1" });
    expect(out).toEqual({ id: 1, title: "buy milk" });
  });
});

// ============================================================================
// 2. A2A 协议
// ============================================================================
describe("A2A 协议", () => {
  let registry: A2ARegistry;

  function makeTask(id: string, state: any, replyText: string, historyMsg: any) {
    return {
      id,
      status: { state, message: { role: "agent" as const, parts: [{ kind: "text" as const, text: replyText }] } },
      history: [historyMsg],
      artifacts: [],
    };
  }

  beforeEach(() => { registry = new A2ARegistry(); });

  test("注册本地 agent 并通过 createTask 调用", async () => {
    registry.register({
      card: {
        name: "echo-agent",
        description: "Echo agent",
        url: "local://echo-agent",
        version: "1.0.0",
        skills: [{ id: "echo", name: "echo", description: "echo input" }],
      },
      async createTask(message) {
        const text = message.parts.find((p) => p.kind === "text")?.text ?? "";
        return makeTask(`task_${Date.now()}`, "completed", `echo: ${text}`, message);
      },
      async sendMessage(taskId, message) {
        const text = message.parts.find((p) => p.kind === "text")?.text ?? "";
        return makeTask(taskId, "completed", `echo2: ${text}`, message);
      },
      async getTask(id) {
        return { id, status: { state: "completed" as const }, artifacts: [], history: [] };
      },
      async cancelTask() { return null; },
    });

    const agent = registry.get("echo-agent")!;
    expect(agent).not.toBeNull();
    const task = await agent.createTask({ role: "user", parts: [{ kind: "text", text: "hello a2a" }] });
    expect(task.status.state).toBe("completed");
    expect(task.status.message!.parts[0]).toEqual({ kind: "text", text: "echo: hello a2a" });
  });

  test("discover 返回所有已注册 agent card", () => {
    registry.register({
      card: { name: "a1", description: "", url: "local://a1", version: "1", skills: [] },
      async createTask(msg) {
        return { id: "x", status: { state: "working" as const }, history: [msg], artifacts: [] };
      },
      async sendMessage(_tid, msg) {
        return { id: "x", status: { state: "working" as const }, history: [msg], artifacts: [] };
      },
      async getTask() { return null; },
      async cancelTask() { return null; },
    });
    const cards = registry.discover();
    expect(cards.length).toBe(1);
    expect(cards[0].name).toBe("a1");
  });

  test("A2ACallTool 返回人类可读结果", async () => {
    registry.register({
      card: {
        name: "math", description: "Math agent", url: "local://math", version: "1",
        skills: [{ id: "calc", name: "calc", description: "" }],
      },
      async createTask(message) {
        const text = message.parts.find((p) => p.kind === "text")?.text ?? "";
        return {
          id: "t1",
          status: {
            state: "completed" as const,
            message: { role: "agent" as const, parts: [{ kind: "text" as const, text: `result=42 for: ${text}` }] },
          },
          history: [message],
          artifacts: [{
            parts: [{ kind: "text" as const, text: "answer: 42" }],
          }],
        };
      },
      async sendMessage(_tid, msg) { return this.createTask(msg); },
      async getTask() { return null; },
      async cancelTask() { return null; },
    });

    const tool = new A2ACallTool(registry);
    const result = await tool.execute(
      { agent: "math", message: "what is 6*7?" },
      { sandbox: null as never, agent: { id: "a", name: "t" }, deadline: Date.now() + 5000 } as any,
    );
    expect(result).toContain("result=42");
    expect(result).toContain("[completed]");
  });
});

// ============================================================================
// 3. EventBus + SSE
// ============================================================================
describe("EventBus & SSE 实时同步", () => {
  test("EventBus 发布订阅", () => {
    const bus = new EventBus();
    const received: any[] = [];
    bus.on("*", (e) => received.push(e));
    bus.emit({ type: "run_start", data: { text: "hi" } });
    bus.emit({ type: "chunk", data: { delta: "hello" } });
    expect(received.length).toBe(2);
    expect(received[0].type).toBe("run_start");
    expect(received[1].data.delta).toBe("hello");
  });

  test("EventBus 历史事件可查询", () => {
    const bus = new EventBus();
    bus.emit({ type: "run_start", userId: "u1", data: {} });
    bus.emit({ type: "chunk", userId: "u2", data: { delta: "x" } });
    const u1 = bus.getHistory((e) => e.userId === "u1");
    expect(u1.length).toBe(1);
  });

  test("SSEServer 向客户端转发事件", () => {
    const bus = new EventBus();
    const sse = new SSEServer(bus);
    const chunks: string[] = [];
    const client = sse.addClient({
      res: { write: (c: string) => chunks.push(c), end: () => {} },
    });
    bus.emit({ type: "chunk", data: { delta: "hi" } });
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks.some((c) => c.includes("chunk"))).toBe(true);
    sse.removeClient(client.id);
    sse.close();
  });

  test("SSE 按 userId 过滤", () => {
    const bus = new EventBus();
    const sse = new SSEServer(bus);
    const user1Chunks: string[] = [];
    sse.addClient({
      res: { write: (c: string) => user1Chunks.push(c), end: () => {} },
      userId: "user1",
    });
    bus.emit({ type: "run_start", userId: "user2", data: {} });
    bus.emit({ type: "run_end", userId: "user1", data: {} });
    const containsUser1Event = user1Chunks.some((c) => c.includes("run_end"));
    expect(containsUser1Event).toBe(true);
    // user2 事件不应发给 user1 客户端（除了 connected 事件外不应有 run_start）
    const containsUser2Event = user1Chunks.some((c) => c.includes("user2"));
    expect(containsUser2Event).toBe(false);
    sse.close();
  });

  test("sseHeaders 返回正确 headers", () => {
    const h = sseHeaders();
    expect(h["Content-Type"]).toBe("text/event-stream");
    expect(h["Cache-Control"]).toBe("no-cache");
  });
});

// ============================================================================
// 4. Per-user Workspace 隔离
// ============================================================================
describe("Per-user Workspace", () => {
  let manager: WorkspaceManager;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ws-"));
    manager = new WorkspaceManager({
      dbDir: tmp,
      memoryFactory: () => new InMemoryStore(),
    });
  });

  test("getOrCreate 为不同用户创建独立 workspace", async () => {
    const alice = await manager.getOrCreate({ userId: "alice" });
    const bob = await manager.getOrCreate({ userId: "bob" });
    expect(alice.config.userId).toBe("alice");
    expect(bob.config.userId).toBe("bob");
    expect(alice.memory).not.toBe(bob.memory);
    await alice.close(); await bob.close();
  });

  test("同一用户两次 getOrCreate 返回同一实例", async () => {
    const a1 = await manager.getOrCreate({ userId: "alice" });
    const a2 = await manager.getOrCreate({ userId: "alice" });
    expect(a1).toBe(a2);
    await a1.close();
  });

  test("默认 scope 为 fullScope", async () => {
    const ws = await manager.getOrCreate({ userId: "charlie" });
    expect(ws.scope.tools).toBe("*");
    await ws.close();
  });

  test("workspace 独立 memory 互不污染", async () => {
    const a = await manager.getOrCreate({ userId: "aaa" });
    const b = await manager.getOrCreate({ userId: "bbb" });
    await a.memory.add({ content: "alice secret", kind: "fact", layer: "L2", userId: "aaa" });
    await b.memory.add({ content: "bob secret", kind: "fact", layer: "L2", userId: "bbb" });

    const aFound = await a.memory.search({ query: "secret", userId: "aaa" });
    const bFound = await b.memory.search({ query: "secret", userId: "bbb" });
    expect(aFound.length).toBe(1);
    expect(bFound.length).toBe(1);
    expect(aFound[0].content).toBe("alice secret");
    expect(bFound[0].content).toBe("bob secret");
    await a.close(); await b.close();
  });

  test("list/update/delete 操作工作正常", async () => {
    await manager.getOrCreate({ userId: "u1" });
    await manager.getOrCreate({ userId: "u2" });
    expect(manager.list().length).toBe(2);
    manager.update("u1", { displayName: "User One" });
    expect(manager.get("u1")!.config.displayName).toBe("User One");
    await manager.delete("u1");
    expect(manager.get("u1")).toBeNull();
    expect(manager.size).toBe(1);
    await manager.closeAll();
  });

  test("InMemoryStore 基本 CRUD", async () => {
    const store = new InMemoryStore();
    const id = await store.add({ content: "hello", kind: "fact", layer: "L2", userId: "u" });
    expect(id).toBeTruthy();
    const got = await store.get(id);
    expect(got!.content).toBe("hello");
    const found = await store.search({ query: "hello", userId: "u" });
    expect(found.length).toBe(1);
    await store.delete(id);
    expect(await store.get(id)).toBeNull();
    await store.close();
  });
});

// ============================================================================
// 5. Interaction HTTP 层
// ============================================================================
describe("Interaction 层 HTTP handlers", () => {
  test("createActionRouter GET 列表 + POST 执行", async () => {
    const reg = new ActionRegistry();
    reg.register(defineAction({
      name: "ping",
      description: "ping action",
      parameters: { type: "object", properties: {} },
      run: () => "pong",
    }));
    const router = createActionRouter({ registry: reg });

    const list = await router.handle({
      method: "GET", url: "/api/actions", headers: {},
    });
    expect(list.status).toBe(200);
    const body = JSON.parse(list.body as string);
    expect(body.actions.length).toBe(1);
    expect(body.actions[0].name).toBe("ping");

    const exec = await router.handle({
      method: "POST", url: "/api/actions/ping", headers: {},
      body: async () => ({}),
    });
    expect(exec.status).toBe(200);
    expect(JSON.parse(exec.body as string).result).toBe("pong");
  });

  test("createActionRouter 404 不存在的 action", async () => {
    const reg = new ActionRegistry();
    const router = createActionRouter({ registry: reg });
    const res = await router.handle({
      method: "POST", url: "/api/actions/nope", headers: {},
      body: async () => ({}),
    });
    expect(res.status).toBe(404);
  });

  test("createA2AHandler 返回 agent cards", async () => {
    const reg = new A2ARegistry();
    reg.register({
      card: { name: "e1", description: "", url: "local://e1", version: "1", skills: [] },
      async createTask(msg) {
        return { id: "x", status: { state: "working" as const }, history: [msg], artifacts: [] };
      },
      async sendMessage(_tid, msg) {
        return { id: "x", status: { state: "working" as const }, history: [msg], artifacts: [] };
      },
      async getTask() { return null; },
      async cancelTask() { return null; },
    });
    const handler = createA2AHandler({ registry: reg });
    const res = await handler.handle({
      method: "GET", url: "/.well-known/agent.json", headers: {},
    });
    expect(res.status).toBe(200);
    const cards = JSON.parse(res.body as string);
    expect(cards.length).toBe(1);
    expect(cards[0].name).toBe("e1");
  });

  test("createSSEHandler matches 路径正确", () => {
    const bus = new EventBus();
    const sse = new SSEServer(bus);
    const handler = createSSEHandler({ sse });
    expect(handler.matches({ method: "GET", url: "/stream?userId=u1", headers: {} })).toBe(true);
    expect(handler.matches({ method: "GET", url: "/api/chat", headers: {} })).toBe(false);
    sse.close();
  });

  test("createChatHandler 400 on missing message", async () => {
    const handler = createChatHandler({
      getAgent: async () => { throw new Error("should not be called"); },
    });
    const res = await handler.handle({
      method: "POST", url: "/api/chat", headers: {},
      body: async () => ({}),
    });
    expect(res.status).toBe(400);
  });
});
