<div align="center">

# Quark Agent

**5KB 的 Agent 内核，拼出你要的一切。**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178c6?style=flat-square?logo=typescript)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](./LICENSE)
[![npm](https://img.shields.io/badge/npm-quark--agent-cb3837?style=flat-square?logo=npm)](https://www.npmjs.com/)
[![Pass Rate](https://img.shields.io/badge/Benchmark-89.0%25-brightgreen?style=flat-square)](./e2e/FULL-EVAL-REPORT.md)
[![GitHub stars](https://img.shields.io/github/stars/Madapexai/quark-agent?style=flat-square)](https://github.com/Madapexai/quark-agent/stargazers)
[![GitHub Discussions](https://img.shields.io/badge/Discussions-Join-blue?style=flat-square?logo=github)](https://github.com/Madapexai/quark-agent/discussions)

**像夸克组合成质子一样，用最小的内核拼出你需要的 Agent。**

[English](./README.md) · [简体中文](./README.zh-CN.md)

</div>

---

> 不是又一个全家桶框架。核心不到 **5KB gzip**，工具、通道、模型——**全是即插即用的 Skill**。

## 目录

- [为什么选 Quark Agent](#为什么选-quark-agent)
- [Benchmark 成绩](#benchmark-成绩)
- [30 秒跑起来](#30-秒跑起来)
- [16 个工具，7 个类别](#16-个工具7-个类别)
- [一个 Agent，七个入口](#一个-agent七个入口)
- [自进化 (GEPA)](#自进化-gepa)
- [A2A：Agent 之间互相通信](#a2aagent-之间互相通信)
- [架构](#架构)
- [项目结构](#项目结构)
- [测试](#测试)
- [Roadmap](#roadmap)
- [贡献](#贡献)
- [社区](#社区)
- [License](#license)

---

## 为什么选 Quark Agent

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

## Benchmark 成绩

在业界标准的 **AgentBench (清华 THUDM)** 和 **GAIA (Meta/HF)** 上评测——共 200 题，真实 LLM、真实工具调用。完整 trace 报告：[`e2e/FULL-EVAL-REPORT.md`](./e2e/FULL-EVAL-REPORT.md) / 交互式 HTML：[`e2e/FULL-EVAL-REPORT.html`](./e2e/FULL-EVAL-REPORT.html)。

| Benchmark | 总数 | 通过 | 失败 | 错误 | 通过率 |
|-----------|----:|----:|----:|----:|-------:|
| GAIA (Meta/HF) | 100 | 93 | 7 | 0 | **93.0%** |
| AgentBench (THUDM) | 100 | 85 | 9 | 6 | **85.0%** |
| **总计** | **200** | **178** | **16** | **6** | **89.0%** |

**GAIA 按难度** — L1: 97.5% · L2: 94.3% · L3: 84.0%
**AgentBench 按类别** — DB-Bench: 76.0% · OS-Interaction: 93.3% · Knowledge-Graph: 95.0%

> 复现命令：`PORT=3465 node e2e/full-eval.mjs --bench all`——约 75 分钟，约 200 次真实 LLM 调用。

---

## 30 秒跑起来

```bash
# 零安装 — 直接从 GitHub 运行
npx github:Madapexai/quark-agent setup   # 交互式配置向导
npx github:Madapexai/quark-agent chat    # 开始对话！

# 或克隆到本地
git clone https://github.com/Madapexai/quark-agent.git
cd quark-agent && npm install
npx tsx bin/cli.ts setup                 # 配置向导
npx tsx bin/cli.ts chat                  # 开始对话！
```

> **v0.3.0 新增**：`quark-agent setup` 引导你选择 provider、模型、通道和沙箱策略，无需手动编辑 `.env`！

> **⚠️ 需要自备大模型 API Key。** Quark Agent 是模型无关的（讲 OpenAI 兼容协议），但**不内置**模型。2 分钟拿一个免费 Key,见下方[获取免费 API Key](#-获取免费-api-key)。

### 🔑 获取免费 API Key

Quark Agent 启动时会探测每个 provider,选第一个健康的当主用,失败自动降级。你只需在 `e2e/.env` 里填**其中一个**:

| Provider | 模型 | 费用 | 哪里拿 Key |
|---|---|---|---|
| **GLM / 智谱** | `glm-4-flash` | 🆓 免费 | https://open.bigmodel.cn/ — 注册后拿 API Key |
| **Agnes AI** | `agnes-2.0-flash` | 🆓 免费（$0/百万 tokens） | https://wiki.agnes-ai.com/ |
| **火山引擎 Ark** | `doubao-seed-code` | 💰 付费（便宜） | https://www.volcengine.com/product/ark |

**或任何 OpenAI 兼容端点：**

| Provider | 要填的环境变量 |
|---|---|
| OpenAI | `OPENAI_API_KEY=sk-...` |
| Ollama（本地，无需 Key） | `OPENAI_API_KEY=ollama` · `OPENAI_BASE_URL=http://localhost:11434/v1` · `OPENAI_MODEL=llama3.2` |
| DeepSeek | `DEEPSEEK_API_KEY=...` |
| Together / Groq / OpenRouter / vLLM | `OPENAI_API_KEY=...` · `OPENAI_BASE_URL=...` · `OPENAI_MODEL=...` |

**最简路径（免费,2 分钟）：**

```bash
# 1. 打开 https://open.bigmodel.cn/ → 注册 → 拿 API Key
# 2. 填到 e2e/.env：
GLM_API_KEY=你的_key
GLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
GLM_MODEL=glm-4-flash
# 3. 启动
npx tsx e2e/demo-server.ts
```

三行代码创建一个 Agent：

```ts
import { createAgent } from "quark-agent";

const { agent } = await createAgent({
  apiKey: process.env.GLM_API_KEY!,
  profile: "coding",          // 只要编码类工具
  extraCategories: ["web"],   // 再加一组 Web 工具
});
```

<details>
<summary><b>其他运行方式</b></summary>

```bash
# 直接跑 ReAct Demo（不带 UI）
npx tsx examples/basic.ts

# 对运行中的 server 跑 headless E2E
node e2e/test-tools.mjs

# 浏览器端到端测试（需要 Chrome）
node e2e/e2e-browser-test.mjs
```

</details>

<details>
<summary><b>完整配置参考</b></summary>

```bash
cp e2e/.env.example e2e/.env
```

```env
# 优先级 1：火山引擎 Ark（OpenAI 兼容）
ARK_API_KEY=
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/coding/v3
ARK_MODEL=doubao-seed-code

# 优先级 2：Agnes AI（免费，OpenAI 兼容）
AGNES_API_KEY=
AGNES_BASE_URL=https://apihub.agnes-ai.com/v1
AGNES_MODEL=agnes-2.0-flash

# 优先级 3：GLM / 智谱（免费，OpenAI 兼容）
GLM_API_KEY=
GLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
GLM_MODEL=glm-4-flash

# 优先级 4：Model Proxy（Anthropic 格式，本地）
MODEL_PROXY_URL=http://127.0.0.1:43191
MODEL_PROXY_KEY=
MODEL_PROXY_MODEL=GLM-4.5-Air

# 优先级 5：直连 OpenAI 兼容 API
OPENAI_API_KEY=
DEEPSEEK_API_KEY=
```

启动时每个 provider 都会被探测,选第一个健康的当主用。如果主用 provider 在运行中失败,请求会自动降级到下一个。

</details>

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

## 自进化 (GEPA)

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
└── e2e/               Demo + 测试 + Benchmark + UI
```

---

## 测试

```bash
# API 集成测试
node e2e/test-tools.mjs

# 浏览器端到端测试（需要 Chrome）
node e2e/e2e-browser-test.mjs

# 完整 Benchmark（200 题，约 75 分钟）
PORT=3465 node e2e/full-eval.mjs --bench all
```

- 13/13 API 测试通过
- 12/12 浏览器 E2E 测试通过
- 178/200 Benchmark 任务通过（**89.0%**）
- 全部 16 个工具均经真实 LLM 验证

---

## Roadmap

- [x] 5KB 内核 + 16 个可组合工具
- [x] 7 种通道（CLI / HTTP / 飞书 / 企微 / Tg / GH / Hook）
- [x] A2A 协议 + GEPA 自进化
- [x] 200 题 Benchmark 套件（AgentBench + GAIA）
- [ ] 独立文档站点（GitHub Pages + MkDocs Material）
- [ ] `npx quark-agent` 一行安装
- [ ] 插件市场
- [ ] 多模态 computer-use 工具（Claude Computer Use 风格）

---

## 贡献

PR 欢迎。请先读 [`CONTRIBUTING.md`](./CONTRIBUTING.md)——写个 `defineAction` 就是一个新 Skill，没那么多规矩。

可以从 [open issues](https://github.com/Madapexai/quark-agent/issues) 里挑活儿干，或者去 [discussions](https://github.com/Madapexai/quark-agent/discussions) 提想法、提问。

[![Contributors](https://contrib.rocks/image?repo=Madapexai/quark-agent&max=2000)](https://github.com/Madapexai/quark-agent/graphs/contributors)

---

## 社区

- 💬 [GitHub Discussions](https://github.com/Madapexai/quark-agent/discussions) — 提问、分享用例
- 🐛 [Issue Tracker](https://github.com/Madapexai/quark-agent/issues) — bug 与 feature request
- 📚 [Benchmark 报告](./e2e/FULL-EVAL-REPORT.md) — 完整 trace 级评测
- 🐦 Twitter: [@quark_agent](https://twitter.com/)（即将上线）

如果 Quark Agent 对你有帮助，给个 ⭐ 吧——能让更多人看到这个项目。

---

## License

[MIT](./LICENSE)

---

<div align="center">

**小内核，大组合。**

</div>
