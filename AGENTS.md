# AGENTS.md

约束 AI agent 在本仓库工作的行为规范。任何 agent（人或 AI）在此仓库中操作前必须先读完本文件。

## 1. 项目概览

**Quark Agent** — 夸克级 AI agent 框架。核心小、可自由组合 skill。

- 主干分支：`master`（已废弃 `main`）
- 运行时：Node.js >= 18.17.0 / TypeScript ESM
- 核心包：`packages/core`（零依赖、<10KB）
- Demo：`e2e/demo-server.ts`（SSE 流式 + Web UI）
- LLM 路由：Ark API > Model Proxy > Direct API > rule-engine fallback

## 2. 敏感信息红线（最高优先级）

**秘钥、token、密码、私钥等敏感信息严禁提交到 git，无论是历史、当前文件、还是截图。**

### 2.1 禁止提交的文件类型

以下文件必须被 `.gitignore` 覆盖，且禁止 `git add -f`：

- `.env`、`.env.local`、`.env.*.local` —— 真实环境变量
- `*.pem`、`*.key`、`*.pfx`、`*.p12` —— 私钥/证书
- `secrets.*`、`credentials.*`、`*.secret` —— 凭据文件
- `id_rsa*`、`id_ed25519*` —— SSH 私钥
- `.npmrc`、`.pypirc` —— 包管理器凭据（含 token）
- `.aws/`、`.gcloud/` —— 云厂商凭据目录

### 2.2 禁止提交的内容模式

任何文件中（含代码、注释、文档、截图、log）出现以下模式即视为泄漏，必须移除或脱敏：

| 模式 | 示例 |
|------|------|
| GitHub Personal Access Token | `ghp_[A-Za-z0-9]{36}` |
| GitHub Fine-grained Token | `github_pat_[A-Za-z0-9_]{82}` |
| OpenAI API Key | `sk-[A-Za-z0-9]{20,}` |
| Anthropic API Key | `sk-ant-[A-Za-z0-9]{20,}` |
| AWS Access Key ID | `AKIA[A-Z0-9]{16}` |
| AWS Secret Access Key | 40 字符 base64 |
| Volcengine Ark Key | `ARK_API_KEY=[A-Za-z0-9]{20,}` |
| DeepSeek Key | `DEEPSEEK_API_KEY=sk-[A-Za-z0-9]{20,}` |
| 任何 `*_API_KEY=` 后跟非空值 | `XXX_API_KEY=abc123...` |
| PEM 私钥块 | `-----BEGIN ... PRIVATE KEY-----` |
| JWT | `eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}` |
| 数据库连接串含密码 | `mongodb://user:pass@host` |

### 2.3 提交前必检流程

**每次 `git commit` 前必须执行以下检查，任何一项失败即终止提交：**

```bash
# 1. 扫描已跟踪文件中的敏感模式
git ls-files | xargs grep -lE \
  "ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}|sk-[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----" \
  2>/dev/null

# 2. 扫描待提交的暂存区
git diff --cached | grep -E \
  "ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}|sk-[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}"

# 3. 确认 .env 未被跟踪
git ls-files --error-unmatch .env 2>/dev/null && echo "LEAK: .env is tracked" && exit 1

# 4. 扫描 git 全历史（首次或定期审计）
git log --all -p | grep -E "ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{20,}" | head -5
```

### 2.4 模板文件规范

- `.env.example`、`.env.template` 等模板文件**可以**提交，但所有 key 字段必须为空或为尖括号占位符
- 正确：`ARK_API_KEY=`（空）或 `ARK_API_KEY=<your-key>`
- 错误：`ARK_API_KEY=<真实密钥字符串>`

### 2.5 泄漏应急处理

若发现已泄漏：

1. **不要** 仅用 `git rm` 删除文件（历史仍保留）
2. 必须用 `git filter-repo` 或 BFG Repo-Cleaner 清洗历史
3. 立即在对应平台 revoke 该 token
4. 重新生成新 token 并通过安全渠道分发（不入库）

## 3. 提交规范

### 3.1 Commit Message

Conventional Commits 风格：

```
<type>(<scope>): <subject>

<body>

<footer>
```

- `type`：`feat` / `fix` / `refactor` / `test` / `docs` / `chore` / `perf`
- `scope`：可选，如 `workflows`、`demo-server`、`core`
- `subject`：祈使句、现在时、≤50 字符
- `body`：解释 why，不解释 what

### 3.2 提交粒度

- 一次 commit 一个逻辑变更
- 测试与实现可同 commit，但不得把"调试残留"和"功能实现"混在一起
- 禁止 `git add -A` / `git add .`，必须显式 `git add <file>`

### 3.3 推送规范

- 推送到 `master` 前确保本地测试通过（`tsc --noEmit` + `node e2e/test-workflows.mjs`）
- 禁止 `--force` 推送到 `master`
- 远程名固定为 `origin`

## 4. 代码约束

- TypeScript ESM，`"type": "module"`
- 严禁引入运行时依赖到 `packages/core`（保持零依赖）
- 优先编辑现有文件，不创建不必要的新文件
- 不主动创建 `*.md` 文档（除非用户明确要求）
- 不添加未要求的 emoji

## 5. 测试约束

- 核心逻辑必须有单元测试（`e2e/test-*.mjs`）
- 工作流变更必须更新 `e2e/test-workflows.mjs` 和 `e2e/test-workflows-e2e.mjs`
- 提交前 `npx tsc --noEmit` 必须 clean
- 截图等测试产物放 `e2e/screenshots/`（已 gitignore），不入库

## 6. 工作流实现约束

`src/core/workflows.ts` 是 Codex 对齐的核心文件，修改时必须遵循：

- 对齐 openai/codex `codex-rs/core/src/goals.rs` 的 `GoalStatus` 生命周期
- continuation prompt 对齐 `codex-rs/prompts/templates/goals/continuation.md`
- budget_limit 处理对齐 `budget_limit.md`（禁止 `GOAL_COMPLETE`）
- 完成审计：每条 acceptance criteria 必须映射到具体证据，拒绝代理信号
- 阻塞阈值：连续 3 次同样阻塞条件 → `blocked`
- 修改后必须同步更新测试，确保 10 单元 + 4 SSE E2E + 4 浏览器 E2E 全通过
