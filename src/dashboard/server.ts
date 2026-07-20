/**
 * Dashboard Server —— WebUI 配置中心后端
 *
 * 提供 HTTP API 供前端配置中心调用：
 * - 配置管理（读写 .quark-agent.json）
 * - Provider 探测
 * - Profile 与工具查询
 * - Skills 管理（增删查）
 * - Sandbox 预设
 * - Channels 配置模板
 * - 对话（同步 / SSE 流式）
 * - Trace 查询与清理
 * - 静态文件托管（src/dashboard/web/）
 *
 * 仅依赖 Node 内置模块（http/fs/path/url/child_process）。
 */

import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { exec, execSync } from "node:child_process";

import { loadConfig, writeConfigFile, findConfigFile, type QuarkConfig } from "../config/index.js";
import { listProfiles, toolsForProfile } from "../core/profiles.js";
import { presetPolicy, type SandboxPolicy } from "../sandbox/policy.js";
import { InMemoryTracer } from "../observe/tracing.js";
import { createAgent, type Agent } from "../index.js";
import type { Span, Tool } from "../core/types.js";
import { EventBus, SSEServer, syncPlugin } from "../sync/index.js";
import { PluginRegistry } from "../plugin/registry.js";

// ============================================================================
// 常量
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 静态文件目录：src/dashboard/web/ */
const WEB_DIR = path.join(__dirname, "web");
/** 插件目录：process.cwd()/.quark-plugins/ */
const PLUGINS_DIR = path.join(process.cwd(), ".quark-plugins");

/** 静态文件 MIME 映射 */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

/** 支持的 LLM Provider 列表 */
const PROVIDER_CHOICES = [
  { name: "OpenAI", envKey: "OPENAI_API_KEY", defaultBase: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini" },
  { name: "Anthropic", envKey: "ANTHROPIC_API_KEY", defaultBase: "https://api.anthropic.com/v1", defaultModel: "claude-sonnet-4-5-20250929" },
  { name: "Gemini", envKey: "GEMINI_API_KEY", defaultBase: "https://generativelanguage.googleapis.com/v1beta", defaultModel: "gemini-1.5-flash" },
  { name: "Ollama", envKey: "", defaultBase: "http://127.0.0.1:11434", defaultModel: "llama3.1" },
  { name: "OpenRouter", envKey: "OPENROUTER_API_KEY", defaultBase: "https://openrouter.ai/api/v1", defaultModel: "openai/gpt-4o-mini" },
  { name: "GLM", envKey: "GLM_API_KEY", defaultBase: "https://open.bigmodel.cn/api/paas/v4", defaultModel: "glm-4-flash" },
  { name: "Agnes", envKey: "AGNES_API_KEY", defaultBase: "https://apihub.agnes-ai.com/v1", defaultModel: "agnes-2.0-flash" },
  { name: "DeepSeek", envKey: "DEEPSEEK_API_KEY", defaultBase: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat" },
  { name: "Volcengine Ark", envKey: "ARK_API_KEY", defaultBase: "https://ark.cn-beijing.volces.com/api/coding/v3", defaultModel: "doubao-seed-code" },
];

/** Channels 配置字段模板（参考 src/channel/*.ts constructor 参数） */
const CHANNEL_TEMPLATES = {
  discord: {
    fields: [
      { name: "token", type: "string", required: true, envKey: "DISCORD_BOT_TOKEN", description: "Bot token from discord.com/developers/applications" },
      { name: "channelId", type: "string", required: false, envKey: "DISCORD_CHANNEL_ID", description: "Restrict to a specific channel ID" },
    ],
  },
  slack: {
    fields: [
      { name: "token", type: "string", required: true, envKey: "SLACK_BOT_TOKEN", description: "xoxb-... bot token" },
      { name: "signingSecret", type: "string", required: true, envKey: "SLACK_SIGNING_SECRET", description: "Signing secret for request verification" },
      { name: "channelId", type: "string", required: false, envKey: "SLACK_CHANNEL_ID", description: "Restrict to a channel" },
      { name: "port", type: "number", required: false, description: "HTTP port for event subscription (default 3000)" },
    ],
  },
  telegram: {
    fields: [
      { name: "botToken", type: "string", required: true, envKey: "TELEGRAM_BOT_TOKEN", description: "Bot Token, e.g. 123456:ABC-DEF" },
      { name: "webhookSecret", type: "string", required: false, description: "Webhook secret token (setWebhook)" },
      { name: "polling", type: "boolean", required: false, description: "Enable polling mode (default false, uses webhook)" },
      { name: "port", type: "number", required: false, description: "HTTP port for webhook" },
    ],
  },
  feishu: {
    fields: [
      { name: "appId", type: "string", required: true, envKey: "FEISHU_APP_ID", description: "飞书应用 App ID" },
      { name: "appSecret", type: "string", required: true, envKey: "FEISHU_APP_SECRET", description: "飞书应用 App Secret" },
      { name: "verificationToken", type: "string", required: false, description: "事件订阅 Verification Token" },
      { name: "encryptKey", type: "string", required: false, description: "事件订阅 Encrypt Key (AES-256-CBC)" },
      { name: "port", type: "number", required: false, description: "HTTP port for webhook" },
    ],
  },
  wechat: {
    fields: [
      { name: "appId", type: "string", required: true, envKey: "WECHAT_APP_ID", description: "公众号 AppID 或企业微信 CorpID" },
      { name: "appSecret", type: "string", required: true, envKey: "WECHAT_APP_SECRET", description: "AppSecret" },
      { name: "token", type: "string", required: true, description: "公众号 Token (签名校验)" },
      { name: "encodingAESKey", type: "string", required: false, description: "EncodingAESKey (安全模式, 43 chars)" },
      { name: "port", type: "number", required: false, description: "HTTP port for webhook" },
    ],
  },
};

// ============================================================================
// 类型
// ============================================================================

export interface DashboardServerOptions {
  /** 监听端口，默认 8788 */
  port?: number;
  /** 监听地址，默认 127.0.0.1 */
  host?: string;
  /** 启动后是否自动打开浏览器，默认 true */
  open?: boolean;
  /** 配置文件路径，默认 process.cwd()/.quark-agent.json */
  configPath?: string;
}

/** Agent 单例容器 */
interface AgentInstance {
  agent: Agent;
  close: () => Promise<void>;
  tracer: InMemoryTracer;
}

// ============================================================================
// 辅助函数
// ============================================================================

/** 简易深合并（与 config 模块同语义），只合并普通对象，数组直接替换 */
function deepMergeConfig(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const val = override[key];
    if (val === undefined) continue;
    if (
      val !== null &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMergeConfig(result[key] as Record<string, unknown>, val as Record<string, unknown>);
    } else {
      result[key] = val;
    }
  }
  return result;
}

/** 探测 provider 是否可用：向 ${baseURL}/models 发 GET 请求，超时 8 秒 */
async function probeProviderEndpoint(
  apiKey: string,
  baseURL: string,
  _model: string,
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    const url = `${baseURL.replace(/\/$/, "")}/models`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
    clearTimeout(timer);
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, latencyMs, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, latencyMs, error: msg };
  }
}

/** 默认配置模板（reset 用） */
function defaultConfigTemplate(): Record<string, unknown> {
  return {
    apiKey: "",
    baseURL: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    temperature: 0.7,
    maxTokens: 4096,
    profile: "minimal",
    dbPath: "./.data/micro-agent.sqlite",
    maxToolRounds: 6,
    contextTokenBudget: 8000,
    workingMemoryRounds: 12,
    sandbox: {
      toolAutoApprove: "safe",
      allowNetwork: true,
      allowFilesystem: true,
      maxTimeoutMs: 30000,
    },
    checkpoint: {
      enabled: false,
      autoSaveInterval: 60,
      maxPerSession: 10,
    },
    longRunning: {
      enabled: false,
      maxConcurrent: 3,
      timeoutMinutes: 30,
    },
  };
}

// ============================================================================
// DashboardServer
// ============================================================================

export class DashboardServer {
  private readonly port: number;
  private readonly host: string;
  private readonly open: boolean;
  private readonly configPath: string;
  private server?: http.Server;
  private agentInstance: AgentInstance | null = null;
  private readonly bus = new EventBus();
  private readonly sseServer = new SSEServer(this.bus);

  constructor(opts: DashboardServerOptions = {}) {
    this.port = opts.port ?? 8788;
    this.host = opts.host ?? "127.0.0.1";
    this.open = opts.open ?? true;
    this.configPath = opts.configPath ?? path.join(process.cwd(), ".quark-agent.json");
  }

  // ===========================================================================
  // 生命周期
  // ===========================================================================

  /** 启动 HTTP 服务 */
  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, this.host, () => resolve());
      this.server!.on("error", reject);
    });
    const addr = `http://${this.host}:${this.port}`;
    console.log(`[dashboard] 服务已启动：${addr}`);
    console.log(`[dashboard] 配置文件：${this.configPath}`);
    console.log(`[dashboard] 插件目录：${PLUGINS_DIR}`);
    console.log(`[dashboard] 静态文件：${WEB_DIR}`);

    // 优雅关闭
    const shutdown = async () => {
      await this.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // 自动打开浏览器
    if (this.open) {
      this.openBrowser(addr);
    }
  }

  /** 停止 HTTP 服务并清理 agent */
  async stop(): Promise<void> {
    await this.resetAgent();
    this.sseServer.close();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = undefined;
    }
    console.log("[dashboard] 服务已停止");
  }

  // ===========================================================================
  // Agent 单例管理
  // ===========================================================================

  /** 获取 agent 单例。配置变更后调用 resetAgent 重建 */
  private async getAgent(): Promise<AgentInstance> {
    if (this.agentInstance) return this.agentInstance;
    const cfg = loadConfig();
    if (!cfg.apiKey) {
      throw new Error("No API key configured");
    }
    const { agent, deps, close } = await createAgent({
      config: {
        id: "dashboard-agent",
        name: "Dashboard Agent",
        model: cfg.model,
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens,
        maxToolRounds: cfg.maxToolRounds,
        contextTokenBudget: cfg.contextTokenBudget,
        workingMemoryRounds: cfg.workingMemoryRounds,
        timeoutMs: 60_000,
      },
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL,
      modelName: cfg.model,
      dbPath: cfg.dbPath,
      profile: cfg.profile,
      enableSkills: true,
      enableSessions: true,
    });
    // 装上 syncPlugin，把 agent 生命周期事件转发到 EventBus
    if (deps.tools) {
      const reg = new PluginRegistry({
        memory: deps.memory,
        tracer: deps.tracer,
        tools: deps.tools,
      });
      await reg.install(syncPlugin(this.bus));
      agent.plugins = reg;
    }
    this.agentInstance = { agent, close, tracer: deps.tracer as InMemoryTracer };
    return this.agentInstance;
  }

  /** 重置 agent 单例。下次请求会按新配置重建 */
  private async resetAgent(): Promise<void> {
    if (this.agentInstance) {
      try {
        await this.agentInstance.close();
      } catch {
        /* ignore */
      }
      this.agentInstance = null;
    }
  }

  // ===========================================================================
  // HTTP 路由分发
  // ===========================================================================

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS 预检
    if (req.method === "OPTIONS") {
      this.writeCORS(res, 204);
      res.end();
      return;
    }

    // 解析 URL
    const base = `http://${req.headers.host ?? "localhost"}`;
    const url = new URL(req.url ?? "/", base);
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    try {
      // ---- 配置管理 ----
      if (pathname === "/api/config" && method === "GET") {
        await this.handleGetConfig(res);
        return;
      }
      if (pathname === "/api/config" && method === "POST") {
        await this.handlePostConfig(req, res);
        return;
      }
      if (pathname === "/api/config/reset" && method === "POST") {
        await this.handleResetConfig(res);
        return;
      }

      // ---- Provider 探测 ----
      if (pathname === "/api/providers" && method === "GET") {
        await this.handleListProviders(res);
        return;
      }
      if (pathname === "/api/probe" && method === "POST") {
        await this.handleProbe(req, res);
        return;
      }

      // ---- Profile 与工具 ----
      if (pathname === "/api/profiles" && method === "GET") {
        await this.handleListProfiles(res);
        return;
      }
      const profileToolsMatch = pathname.match(/^\/api\/profiles\/([^/]+)\/tools$/);
      if (profileToolsMatch && method === "GET") {
        await this.handleProfileTools(profileToolsMatch[1], res);
        return;
      }

      // ---- Skills 管理 ----
      if (pathname === "/api/skills" && method === "GET") {
        await this.handleListSkills(res);
        return;
      }
      if (pathname === "/api/skills/add" && method === "POST") {
        await this.handleAddSkill(req, res);
        return;
      }
      if (pathname === "/api/skills/remove" && method === "POST") {
        await this.handleRemoveSkill(req, res);
        return;
      }

      // ---- Sandbox 预设 ----
      if (pathname === "/api/sandbox/presets" && method === "GET") {
        await this.handleSandboxPresets(res);
        return;
      }

      // ---- Channels 配置模板 ----
      if (pathname === "/api/channels/templates" && method === "GET") {
        await this.handleChannelTemplates(res);
        return;
      }

      // ---- 对话 ----
      if (pathname === "/api/chat" && method === "POST") {
        await this.handleChat(req, res);
        return;
      }
      if (pathname === "/api/chat/stream" && method === "GET") {
        await this.handleChatStream(url, res);
        return;
      }

      // ---- Trace ----
      if (pathname === "/api/trace" && method === "GET") {
        await this.handleTrace(res);
        return;
      }
      if (pathname === "/api/trace/stats" && method === "GET") {
        await this.handleTraceStats(res);
        return;
      }
      if (pathname === "/api/trace/clear" && method === "POST") {
        await this.handleTraceClear(res);
        return;
      }

      // ---- 静态文件 ----
      if (method === "GET") {
        this.serveStatic(pathname, res);
        return;
      }

      this.writeJSON(res, 404, { error: "Not Found", path: pathname });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[dashboard] handler error:", msg);
      if (!res.headersSent) {
        this.writeJSON(res, 500, { error: "Internal Error", message: msg });
      }
    }
  }

  // ===========================================================================
  // 配置管理 API
  // ===========================================================================

  /** GET /api/config → 读当前配置（含 env 合并） */
  private async handleGetConfig(res: ServerResponse): Promise<void> {
    const cfg = loadConfig();
    this.writeJSON(res, 200, cfg);
  }

  /** POST /api/config → 合并写入 */
  private async handlePostConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (body === null) {
      this.writeJSON(res, 400, { error: "Invalid JSON body" });
      return;
    }
    const existing = (findConfigFile() ?? {}) as Record<string, unknown>;
    const merged = deepMergeConfig(existing, body);
    writeConfigFile(merged as Partial<QuarkConfig>);
    // 配置变更后重建 agent
    await this.resetAgent();
    this.writeJSON(res, 200, { ok: true, config: merged });
  }

  /** POST /api/config/reset → 重置为默认模板 */
  private async handleResetConfig(res: ServerResponse): Promise<void> {
    const template = defaultConfigTemplate();
    writeConfigFile(template as Partial<QuarkConfig>);
    await this.resetAgent();
    this.writeJSON(res, 200, { ok: true, config: template });
  }

  // ===========================================================================
  // Provider 探测 API
  // ===========================================================================

  /** GET /api/providers → 支持的 provider 列表 */
  private async handleListProviders(res: ServerResponse): Promise<void> {
    this.writeJSON(res, 200, PROVIDER_CHOICES);
  }

  /** POST /api/probe → 探测 provider 是否可用 */
  private async handleProbe(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body || typeof body.apiKey !== "string" || typeof body.baseURL !== "string") {
      this.writeJSON(res, 400, { error: "Missing apiKey/baseURL in body" });
      return;
    }
    const model = typeof body.model === "string" ? body.model : "";
    const result = await probeProviderEndpoint(body.apiKey, body.baseURL, model);
    this.writeJSON(res, 200, result);
  }

  // ===========================================================================
  // Profile 与工具 API
  // ===========================================================================

  /** GET /api/profiles → 所有内置 profile */
  private async handleListProfiles(res: ServerResponse): Promise<void> {
    this.writeJSON(res, 200, listProfiles());
  }

  /** GET /api/profiles/:name/tools → profile 的工具列表（name + description） */
  private async handleProfileTools(rawName: string, res: ServerResponse): Promise<void> {
    const name = decodeURIComponent(rawName);
    const tools = toolsForProfile(name);
    const list = tools.map((t: Tool) => ({ name: t.name, description: t.description }));
    this.writeJSON(res, 200, list);
  }

  // ===========================================================================
  // Skills 管理 API
  // ===========================================================================

  /** GET /api/skills → 已安装的 skill 列表 */
  private async handleListSkills(res: ServerResponse): Promise<void> {
    if (!fs.existsSync(PLUGINS_DIR)) {
      this.writeJSON(res, 200, []);
      return;
    }
    const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
    const skills: Array<Record<string, unknown>> = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const dir = path.join(PLUGINS_DIR, e.name);
      const manifestPath = path.join(dir, ".manifest.json");
      let pkg = e.name;
      let source = "local";
      let installedAt: string | undefined;
      if (fs.existsSync(manifestPath)) {
        try {
          const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
          if (typeof m.package === "string") pkg = m.package;
          if (typeof m.source === "string") source = m.source;
          if (typeof m.installedAt === "string") installedAt = m.installedAt;
        } catch {
          /* ignore manifest parse error */
        }
      }
      skills.push({ name: e.name, package: pkg, source, installedAt, dir });
    }
    // 根目录 manifest（npm install --no-save 写的）
    const rootManifest = path.join(PLUGINS_DIR, ".manifest.json");
    if (fs.existsSync(rootManifest)) {
      try {
        const m = JSON.parse(fs.readFileSync(rootManifest, "utf8"));
        skills.push({
          name: typeof m.package === "string" ? m.package : "root",
          package: m.package,
          source: typeof m.source === "string" ? m.source : "npm",
          installedAt: m.installedAt,
          dir: PLUGINS_DIR,
        });
      } catch {
        /* ignore root manifest parse error */
      }
    }
    this.writeJSON(res, 200, skills);
  }

  /** POST /api/skills/add → 安装 skill（npm install 优先，失败 fallback git clone） */
  private async handleAddSkill(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body || typeof body.package !== "string") {
      this.writeJSON(res, 400, { error: "Missing 'package' in body" });
      return;
    }
    const pkg = body.package;
    fs.mkdirSync(PLUGINS_DIR, { recursive: true });
    const pluginDir = path.join(PLUGINS_DIR, pkg.replace(/^@/, "").replace(/\//, "__"));
    if (fs.existsSync(pluginDir)) {
      this.writeJSON(res, 200, { ok: true, skipped: true, message: `${pkg} already installed` });
      return;
    }

    // 先试 npm install --no-save
    try {
      execSync(`npm install --no-save ${pkg}`, {
        cwd: PLUGINS_DIR,
        stdio: "pipe",
        timeout: 60_000,
      });
      const manifest = { package: pkg, installedAt: new Date().toISOString(), source: "npm" };
      fs.writeFileSync(path.join(PLUGINS_DIR, ".manifest.json"), JSON.stringify(manifest, null, 2));
      this.writeJSON(res, 200, { ok: true, source: "npm", package: pkg });
      return;
    } catch {
      // fallback: git clone（GitHub 简写 user/repo）
      if (pkg.includes("/")) {
        const gitUrl = pkg.startsWith("https://") ? pkg : `https://github.com/${pkg}.git`;
        try {
          execSync(`git clone --depth 1 ${gitUrl} ${pluginDir}`, {
            stdio: "pipe",
            timeout: 60_000,
          });
          const manifest = { package: pkg, installedAt: new Date().toISOString(), source: "git" };
          fs.writeFileSync(path.join(pluginDir, ".manifest.json"), JSON.stringify(manifest, null, 2));
          this.writeJSON(res, 200, { ok: true, source: "git", package: pkg });
          return;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.writeJSON(res, 500, { ok: false, error: `npm + git clone both failed: ${msg}` });
          return;
        }
      }
      this.writeJSON(res, 500, { ok: false, error: "npm install failed and not a git shorthand" });
      return;
    }
  }

  /** POST /api/skills/remove → 删除 skill 目录 */
  private async handleRemoveSkill(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body || typeof body.name !== "string") {
      this.writeJSON(res, 400, { error: "Missing 'name' in body" });
      return;
    }
    const name = body.name;
    const target = path.join(PLUGINS_DIR, name);
    // 防路径穿越
    if (!target.startsWith(PLUGINS_DIR)) {
      this.writeJSON(res, 400, { error: "Invalid name" });
      return;
    }
    if (!fs.existsSync(target)) {
      this.writeJSON(res, 404, { error: `Skill not found: ${name}` });
      return;
    }
    fs.rmSync(target, { recursive: true, force: true });
    this.writeJSON(res, 200, { ok: true, removed: name });
  }

  // ===========================================================================
  // Sandbox 预设 API
  // ===========================================================================

  /** GET /api/sandbox/presets → 三个预设（strict/balanced/permissive） */
  private async handleSandboxPresets(res: ServerResponse): Promise<void> {
    const presets: Array<{ name: "strict" | "balanced" | "permissive"; policy: SandboxPolicy }> = [
      { name: "strict", policy: presetPolicy("strict") },
      { name: "balanced", policy: presetPolicy("balanced") },
      { name: "permissive", policy: presetPolicy("permissive") },
    ];
    this.writeJSON(res, 200, presets);
  }

  // ===========================================================================
  // Channels 配置模板 API
  // ===========================================================================

  /** GET /api/channels/templates → 各 channel 字段模板 */
  private async handleChannelTemplates(res: ServerResponse): Promise<void> {
    this.writeJSON(res, 200, CHANNEL_TEMPLATES);
  }

  // ===========================================================================
  // 对话 API
  // ===========================================================================

  /** POST /api/chat → 同步对话 */
  private async handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body || typeof body.text !== "string") {
      this.writeJSON(res, 400, { error: "Missing 'text' in body" });
      return;
    }
    const text: string = body.text;
    const sessionId: string | undefined = typeof body.sessionId === "string" ? body.sessionId : undefined;
    const userId: string | undefined = typeof body.userId === "string" ? body.userId : undefined;

    let instance: AgentInstance;
    try {
      instance = await this.getAgent();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 400, { error: msg });
      return;
    }
    const result = await instance.agent.run(text, {
      sessionId,
      userId,
      channel: "dashboard",
    });
    this.writeJSON(res, 200, {
      reply: result.reply,
      rounds: result.rounds,
      toolCalls: result.toolCalls,
      contextTokens: result.contextTokens,
      recovered: result.recovered,
    });
  }

  /** GET /api/chat/stream?text=...&sessionId=...&userId=... → SSE 流式对话 */
  private async handleChatStream(url: URL, res: ServerResponse): Promise<void> {
    const text = url.searchParams.get("text") ?? "";
    const sessionId = url.searchParams.get("sessionId") ?? undefined;
    const userId = url.searchParams.get("userId") ?? undefined;
    if (!text) {
      this.writeJSON(res, 400, { error: "Missing 'text' query parameter" });
      return;
    }

    let instance: AgentInstance;
    try {
      instance = await this.getAgent();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 400, { error: msg });
      return;
    }

    // SSE headers
    const headers: Record<string, string> = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    };
    this.applyCORS(headers);
    res.writeHead(200, headers);
    // SSE 注释行，用于刷新缓冲区
    res.write(": connected\n\n");

    // 注册 SSE 客户端，EventBus 事件自动转发
    const client = this.sseServer.addClient({
      res: {
        write: (c: string) => {
          try {
            res.write(c);
          } catch {
            /* client 已断开 */
          }
        },
        end: () => {
          try {
            res.end();
          } catch {
            /* already ended */
          }
        },
      },
      userId,
      sessionId,
    });

    try {
      const result = await instance.agent.run(text, {
        sessionId,
        userId,
        channel: "dashboard",
      });
      // 推送最终结果
      res.write(
        `event: done\ndata: ${JSON.stringify({
          reply: result.reply,
          rounds: result.rounds,
          toolCalls: result.toolCalls,
          contextTokens: result.contextTokens,
          recovered: result.recovered,
        })}\n\n`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.write(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`);
    } finally {
      this.sseServer.removeClient(client.id);
      try {
        res.end();
      } catch {
        /* already ended */
      }
    }
  }

  // ===========================================================================
  // Trace API
  // ===========================================================================

  /** GET /api/trace → 所有 span，按 startedAt 排序 */
  private async handleTrace(res: ServerResponse): Promise<void> {
    let spans: Span[] = [];
    try {
      const instance = await this.getAgent();
      spans = instance.tracer.export().slice().sort((a: Span, b: Span) => a.startedAt - b.startedAt);
    } catch {
      // agent 未创建（无 API key）→ 返回空列表
    }
    this.writeJSON(res, 200, spans);
  }

  /** GET /api/trace/stats → tracer 统计 */
  private async handleTraceStats(res: ServerResponse): Promise<void> {
    let stats: Record<string, { count: number; avgMs: number; errors: number }> = {};
    try {
      const instance = await this.getAgent();
      stats = instance.tracer.stats();
    } catch {
      // agent 未创建 → 返回空统计
    }
    this.writeJSON(res, 200, stats);
  }

  /** POST /api/trace/clear → 清空已结束的 span */
  private async handleTraceClear(res: ServerResponse): Promise<void> {
    let cleared = 0;
    try {
      const instance = await this.getAgent();
      const flushed = instance.tracer.flush();
      cleared = flushed.length;
    } catch {
      // agent 未创建 → 无需清理
    }
    this.writeJSON(res, 200, { ok: true, cleared });
  }

  // ===========================================================================
  // 静态文件
  // ===========================================================================

  /** 从 src/dashboard/web/ 目录返回静态文件 */
  private serveStatic(pathname: string, res: ServerResponse): void {
    let p = pathname;
    if (p === "/") p = "/index.html";
    // 安全：禁止路径穿越
    const filePath = path.join(WEB_DIR, p);
    if (!filePath.startsWith(WEB_DIR)) {
      this.writeJSON(res, 403, { error: "Forbidden" });
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        this.writeJSON(res, 404, { error: "Not Found", path: pathname });
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const mime = MIME[ext] ?? "application/octet-stream";
      const headers: Record<string, string> = {
        "Content-Type": mime,
        "Cache-Control": "no-cache",
      };
      this.applyCORS(headers);
      res.writeHead(200, headers);
      res.end(data);
    });
  }

  // ===========================================================================
  // 工具方法
  // ===========================================================================

  /** 读取并解析 JSON body，失败返回 null */
  private readJSON(req: IncomingMessage): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(raw) as Record<string, unknown>);
        } catch {
          resolve(null);
        }
      });
      req.on("error", () => resolve(null));
    });
  }

  /** 写 JSON 响应，附带 CORS 头 */
  private writeJSON(res: ServerResponse, status: number, body: unknown): void {
    const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" };
    this.applyCORS(headers);
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  }

  /** 只写 CORS 头（用于 OPTIONS 预检） */
  private writeCORS(res: ServerResponse, status = 204): void {
    res.writeHead(status, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    });
  }

  /** 把 CORS 头追加到给定 headers */
  private applyCORS(headers: Record<string, string>): void {
    headers["Access-Control-Allow-Origin"] = "*";
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
  }

  /** 跨平台打开浏览器 */
  private openBrowser(addr: string): void {
    const cmd =
      process.platform === "darwin"
        ? `open ${addr}`
        : process.platform === "win32"
          ? `start ${addr}`
          : `xdg-open ${addr}`;
    exec(cmd, (err) => {
      if (err) {
        console.warn(`[dashboard] 无法自动打开浏览器：${err.message}`);
        console.warn(`[dashboard] 请手动访问 ${addr}`);
      }
    });
  }
}
