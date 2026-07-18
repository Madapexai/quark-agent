/**
 * 微内核架构验证测试：
 * 1. @micro-agent/core 零依赖可独立使用（<10KB 核心）
 * 2. Plugin 依赖拓扑排序正确
 * 3. 插件服务注册与获取
 * 4. A2A/SSE/Workspace/defineAction 作为标准插件可按需加载
 */

import { describe, expect, test } from "bun:test";
import {
  Agent, EventBus, PluginRegistry, defineTool, VERSION,
  type Plugin, type Provider, type ChatResponse, type Tool,
} from "@micro-agent/core";
import {
  a2aPlugin, ssePlugin, workspacePlugin, defineActionPlugin, inMemoryPlugin, recommendedPlugins,
  createInMemoryMemory,
} from "@micro-agent/plugins";
import { sessionsExtension } from "@micro-agent/extensions";

function createMockProvider(text = "mock reply"): Provider {
  return {
    name: "mock",
    async chat(req) {
      const toolCalls = req.tools && req.tools.length > 0 && !req.messages.some((m) => m.role === "tool")
        ? [{ id: "c1", name: "echo", arguments: JSON.stringify({ msg: "hello" }) }]
        : undefined;
      return {
        content: text,
        toolCalls,
        model: "mock",
        usage: { prompt: 10, completion: 5, total: 15 },
        finishReason: toolCalls ? "tool_calls" : "stop",
      } as ChatResponse;
    },
  };
}

describe("微内核（@micro-agent/core）", () => {
  test("版本号与核心导出存在", () => {
    expect(VERSION).toBe("0.1.0");
    expect(Agent).toBeDefined();
    expect(EventBus).toBeDefined();
    expect(PluginRegistry).toBeDefined();
    expect(defineTool).toBeDefined();
  });

  test("EventBus 发布订阅可用", () => {
    const bus = new EventBus();
    let received: unknown;
    const off = bus.on("test", (p: any) => { received = p; });
    bus.emit("test", { hello: "world" });
    expect(received).toEqual({ hello: "world" });
    off();
    received = undefined;
    bus.emit("test", { again: true });
    expect(received).toBeUndefined();
  });

  test("极简 Agent Loop + 工具调用", async () => {
    const memory = createInMemoryMemory();
    const provider = createMockProvider();
    const echoTool = defineTool({
      name: "echo",
      description: "回显输入",
      parameters: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
      async execute(args) { return `echo:${args.msg}`; },
    });
    const tools = new Map<string, Tool>([["echo", echoTool]]);
    const agent = new Agent({ id: "a1", name: "test", model: "mock" }, { provider, memory, tools });
    const result = await agent.run("hi");
    expect(result.rounds).toBeGreaterThanOrEqual(1);
    expect(result.toolCalls).toBeGreaterThanOrEqual(1);
  });
});

describe("插件系统（PluginRegistry）", () => {
  test("依赖拓扑排序：B 依赖 A，A 先安装", async () => {
    const order: string[] = [];
    const pluginA: Plugin = {
      name: "A",
      install() { order.push("A"); return () => {}; },
    };
    const pluginB: Plugin = {
      name: "B", dependencies: ["A"],
      install() { order.push("B"); return () => {}; },
    };
    const memory = createInMemoryMemory();
    const reg = new PluginRegistry({ memory, scope: { tools: "*", sandboxTier: "full", models: "*", memoryDomains: "*" } });
    reg.register(pluginB);
    reg.register(pluginA);
    await reg.installAll();
    expect(order).toEqual(["A", "B"]);
  });

  test("循环依赖抛错", async () => {
    const memory = createInMemoryMemory();
    const reg = new PluginRegistry({ memory, scope: { tools: "*", sandboxTier: "full", models: "*", memoryDomains: "*" } });
    reg.register({ name: "X", dependencies: ["Y"], install: () => () => {} });
    reg.register({ name: "Y", dependencies: ["X"], install: () => () => {} });
    expect(reg.installAll()).rejects.toThrow("Circular");
  });

  test("服务注册与获取", async () => {
    const memory = createInMemoryMemory();
    const reg = new PluginRegistry({ memory, scope: { tools: "*", sandboxTier: "full", models: "*", memoryDomains: "*" } });
    reg.register({
      name: "svc",
      install(ctx) {
        ctx.registerService("myService", { value: 42 });
        return () => {};
      },
    });
    await reg.installAll();
    const svc = reg["services"].get("myService") as { value: number };
    expect(svc.value).toBe(42);
  });

  test("缺少依赖抛错", async () => {
    const memory = createInMemoryMemory();
    const reg = new PluginRegistry({ memory, scope: { tools: "*", sandboxTier: "full", models: "*", memoryDomains: "*" } });
    reg.register({ name: "Z", dependencies: ["Missing"], install: () => () => {} });
    expect(reg.installAll()).rejects.toThrow("depends on missing");
  });
});

describe("官方插件集（@micro-agent/plugins）", () => {
  test("recommendedPlugins() 返回5个标准插件", () => {
    const plugins = recommendedPlugins();
    expect(plugins.map((p) => p.name).sort()).toEqual(["a2a", "defineAction", "memory-inmemory", "sse", "workspace"]);
  });

  test("各插件 name 字段正确", () => {
    expect(a2aPlugin().name).toBe("a2a");
    expect(ssePlugin().name).toBe("sse");
    expect(workspacePlugin().name).toBe("workspace");
    expect(defineActionPlugin().name).toBe("defineAction");
    expect(inMemoryPlugin().name).toBe("memory-inmemory");
    expect(sessionsExtension().name).toBe("sessions");
  });

  test("defineAction 插件注册工具", async () => {
    const memory = createInMemoryMemory();
    const bus = new EventBus();
    const reg = new PluginRegistry({ bus, memory, scope: { tools: "*", sandboxTier: "full", models: "*", memoryDomains: "*" } });
    reg.register(defineActionPlugin());
    await reg.installAll();
    const tools = reg.getTools();
    expect(tools.size).toBe(0);
    const api = reg["services"].get("action.registry") as { defineAction: Function };
    api.defineAction({
      name: "greet",
      description: "打招呼",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      run: (args: any) => `Hello, ${args.name}!`,
      expose: ["tool"],
    });
    expect(reg.getTools().has("greet")).toBe(true);
  });
});

describe("核心层大小验证", () => {
  test("核心层源码行数在合理范围（<1000行）", () => {
    const { execSync } = require("child_process");
    const out = execSync("find packages/core/src -name '*.ts' -exec wc -l {} +", { cwd: "/workspace/micro-agent" }).toString();
    const lines = out.trim().split("\n");
    const totalLine = lines[lines.length - 1];
    const total = parseInt(totalLine.trim().split(/\s+/)[0] || "0", 10);
    expect(total).toBeLessThan(1000);
    expect(total).toBeGreaterThan(500);
  });
});
