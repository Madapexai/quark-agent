<div align="center">

# Quark Agent

**5KB 的 Agent 内核，拼出你要的一切。**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178c6?style=flat-square)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](https://opensource.org/licenses/MIT)
[![npm](https://img.shields.io/badge/npm-quark--agent-cb3837?style=flat-square&logo=npm)](https://www.npmjs.com/)

[English](#) · [简体中文](#)

像夸克组合成质子一样，用最小的内核拼出你需要的 Agent。

不是又一个全家桶框架。核心不到 5KB gzip，工具、通道、模型——全是即插即用的 Skill。

</div>

---

## 30 秒跑起来

```bash
git clone https://github.com/Madapexai/quark-agent.git
cd quark-agent && npm install
cp e2e/.env.example e2e/.env   # 填上你的 API Key
npx tsx e2e/demo-server.ts
# → http://localhost:3456
```

三行代码创建一个 Agent：

```ts
import { createAgent } from "quark-agent";

const { agent } = await createAgent({
  apiKey: process.env.ARK_API_KEY!,
  profile: "coding",          // 只要编码类工具
  extraCategories: ["web"],   // 再加一组 Web 工具
});
```

---

## 有什么不一样

**别家**：给你一个固定工具集，爱用不用。

**Quark Agent**：16 个工具按 7 类分，6 种 Profile 预设，随你挑随你组，写一个 `defineAction` 就能加新的。

| | Quark Agent | Claude Code | Codex CLI |
|---|:---:|:---:|:---:|
| 内核体积 | **<5KB** | — | — |
| 工具自由组合 | ✅ | ❌ 固定 | ❌ 固定 |
| 自进化 (GEPA) | ✅ | ❌ | ❌ |
| 多通道接入 | 7 种 | CLI | CLI |
| A2A 协议 | 内置 | — | — |
| Profile 裁剪 | 6 档 | — | — |

---

## 16 个工具，7 个类别

不需要全装。`profile` 参数决定你加载哪些：

| 类别 | 工具 | minimal | coding | research | full |
|---|---|:---:|:---:|:---:|:---:|
| 文件 | `read_file` `write_file` `edit_file` `list_dir` | | ✅ | | ✅ |
| 搜索 | `search_files` `find_files` | | ✅ | | ✅ |
| Shell | `shell` | | ✅ | | ✅ |
| Web | `web_search` `web_fetch` | | | ✅ | ✅ |
| 代码 | `run_code` | ✅ | ✅ | | ✅ |
| 图像 | `generate_image` | | | | ✅ |
| 任务 | `todo_write` `task_list` | | | ✅ | ✅ |
| 记忆 | `memory_save` `memory_search` | | | ✅ | ✅ |

写一个 Skill 只需一个 `defineAction`——定义一次，自动暴露到 Agent / HTTP / CLI / MCP / A2A：

```ts
import { defineAction } from "quark-agent";

export const sendEmail = defineAction({
  name: "send_email",
  description: "Send an email to someone",
  parameters: {
    to: { type: "string" },
    subject: { type: "string" },
    body: { type: "string" },
  },
  handler: async ({ to, subject, body }) => {
    // 你的逻辑
    return { sent: true };
  },
});
```

---

## 一个 Agent，七个入口

同一个 Agent 实例，换个 Channel 就能跑在不同平台上：

```ts
// 终端
import { CliChannel } from "quark-agent";
new CliChannel({ agent }).start();

// HTTP + SSE 流式
import { HttpChannel } from "quark-agent";
new HttpChannel({ agent, port: 3456 }).start();

// 飞书 / 企微 / Telegram / GitHub / Webhook
// 全部支持，接入方式一致
```

---

## 架构

```
┌──────────────────────────────────────────┐
│              Channels (7)                │
│  CLI · HTTP · 飞书 · 企微 · Tg · GH · Hook│
├──────────────────────────────────────────┤
│            Agent Runtime                 │
│  ReAct · Planner · Sub-Agent · Healer   │
├───────┬───────┬───────┬─────────────────┤
│ Tools │ Skills│Provider│    Plugins      │
│  16   │ Store │ Multi  │ A2A·SSE·MCP·Hub │
├───────┴───────┴───────┴─────────────────┤
│          Kernel (<5KB gzip)              │
│      Agent · Context · Runtime · Types   │
└──────────────────────────────────────────┘
```

按需引入：只用内核 → 加插件 → 加扩展 → 全家桶。你说了算。

| 层 | 包 | 内容 |
|---|---|---|
| Kernel | `packages/core` | Agent、Context、Runtime、Types — 零依赖 |
| Plugins | `packages/plugins` | A2A、SSE、Workspace、defineAction |
| Extensions | `packages/extensions` | Sessions、Healer、Skill 评分 |
| Full | `src/` | 全部工具、通道、Provider |

---

## 自进化

给 Agent 一组测试用例，让它自己调优 Prompt 和工具选择策略：

```ts
import { Evolver } from "quark-agent";

const evolver = new Evolver({ agent, evalCases: [...], generations: 10 });
await evolver.evolve();
```

---

## A2A：Agent 之间互相通信

```ts
import { getA2ARegistry } from "quark-agent";

// 注册你的 Agent
getA2ARegistry().register({
  name: "code-reviewer",
  skills: [{ name: "review", description: "Review pull requests" }],
});

// 别的 Agent 可以直接调用
```

---

## Demo

`e2e/` 目录有一个完整可跑的 ReAct Agent Demo：

- SSE 流式输出，实时看到思考和工具调用过程
- 3 层 LLM 路由：Ark API → Model Proxy → Direct API → 降级
- 零外部依赖的专业 Web UI
- `.env` 配置，不硬编码任何密钥

<details>
<summary>配置说明</summary>

```bash
cp e2e/.env.example e2e/.env
```

```env
# 优先级 1：火山引擎 Ark（OpenAI 兼容）
ARK_API_KEY=
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/coding/v3
ARK_MODEL=doubao-seed-code

# 优先级 2：Model Proxy（Anthropic 格式）
MODEL_PROXY_URL=http://127.0.0.1:43191
MODEL_PROXY_KEY=

# 优先级 3：直连 OpenAI 兼容 API
OPENAI_API_KEY=
```

</details>

---

## 测试

```bash
# API 集成测试
node e2e/test-tools.mjs

# 浏览器端到端测试（需要 Chrome）
node e2e/e2e-browser-test.mjs
```

- 13/13 API 测试通过
- 12/12 浏览器 E2E 测试通过
- 全部 16 个工具均经真实 LLM 验证

---

## 项目结构

```
quark-agent/
├── src/
│   ├── core/          内核：Agent、Context、Runtime
│   ├── tools/         16+ 内置工具
│   ├── channel/       7 种通道
│   ├── provider/      OpenAI / Anthropic / Gemini / Ollama
│   ├── plugin/        插件注册 + 内置插件
│   ├── skills/        技能发现、评分、沉淀
│   ├── evolve/        GEPA 自进化
│   ├── a2a/           Agent 间通信协议
│   ├── sync/          EventBus + SSE
│   ├── memory/        SQLite 存储 + 压缩
│   └── sandbox/       VM 沙箱
├── packages/
│   ├── core/          零依赖内核
│   ├── plugins/       官方插件
│   └── extensions/    高阶扩展
└── e2e/               Demo + 测试 + UI
```

---

## 贡献

PR 欢迎。写个 `defineAction` 就是一个新 Skill，没那么多规矩。

---

## License

[MIT](LICENSE)

---

<div align="center">

**小内核，大组合。**

如果觉得有用，给个 ⭐

</div>
