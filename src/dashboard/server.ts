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
import { exec } from "node:child_process";

import { loadConfig, writeConfigFile, findConfigFile, type QuarkConfig } from "../config/index.js";
import { listProfiles, toolsForProfile } from "../core/profiles.js";
import { presetPolicy, type SandboxPolicy } from "../sandbox/policy.js";
import { InMemoryTracer } from "../observe/tracing.js";
import { createAgent, type Agent } from "../index.js";
import type { Span, Tool } from "../core/types.js";
import { EventBus, SSEServer, syncPlugin } from "../sync/index.js";
import { PluginRegistry } from "../plugin/registry.js";
import { PROVIDER_CATALOG, recommendByPrice, recommendByQuality, getProviderStats, flatCatalogSorted } from "../provider/catalog.js";
import { EnvManager } from "../env/manager.js";
import { SkillInstaller } from "../skills/installer.js";
import { AgentTeam, type TeamConfig, type AgentFactory } from "../team/index.js";
import { ComputerService, type ClickOptions, type TypeOptions, type KeyCombo } from "../tools/computer_service.js";
import { RelayRouter, type RelayRule } from "../channel/relay.js";
import { logger } from "../observe/logviewer.js";
import { LangfuseClient, type LangfuseConfig } from "../observe/langfuse.js";
import { ModelManager } from "../config/model-manager.js";
import { ChatRoomManager } from "../chatroom/index.js";
import { DreamingEngine, type DreamingConfig } from "../dreaming/index.js";

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
  /** 环境变量管理器 */
  private envManager: EnvManager | null = null;
  /** Skill 安装器 */
  private skillInstaller: SkillInstaller | null = null;
  /** Computer 服务 */
  private computer: ComputerService | null = null;
  /** Relay 路由器 */
  private relay: RelayRouter | null = null;
  /** Agent Team 工厂（lazy 初始化） */
  private teamFactory: AgentFactory | null = null;
  /** Langfuse 客户端 */
  private langfuseClient: LangfuseClient | null = null;
  /** 模型管理器 */
  private modelManager: ModelManager | null = null;
  /** 聊天室管理器 */
  private chatroomManager: ChatRoomManager | null = null;
  /** 自进化引擎 */
  private dreamingEngine: DreamingEngine | null = null;

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

    // 初始化新模块实例
    this.modelManager = new ModelManager();
    this.chatroomManager = new ChatRoomManager();
    this.dreamingEngine = new DreamingEngine({ enabled: true });
    // Langfuse 从配置文件读取
    const cfg = loadConfig();
    const lf = (cfg as unknown as Record<string, unknown>).langfuse as Partial<LangfuseConfig> | undefined;
    if (lf && lf.publicKey && lf.secretKey) {
      this.langfuseClient = new LangfuseClient({
        publicKey: lf.publicKey,
        secretKey: lf.secretKey,
        baseUrl: lf.baseUrl,
        enabled: lf.enabled ?? false,
      });
    }

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

      // ---- Provider Catalog ----
      if (pathname === "/api/catalog" && method === "GET") {
        await this.handleCatalog(res);
        return;
      }
      if (pathname === "/api/catalog/sort" && method === "GET") {
        await this.handleCatalogSort(url, res);
        return;
      }
      if (pathname === "/api/catalog/recommend" && method === "GET") {
        await this.handleCatalogRecommend(url, res);
        return;
      }
      if (pathname === "/api/catalog/stats" && method === "GET") {
        await this.handleCatalogStats(res);
        return;
      }

      // ---- 环境变量管理 ----
      if (pathname === "/api/env" && method === "GET") {
        await this.handleEnvList(res);
        return;
      }
      if (pathname === "/api/env" && method === "POST") {
        await this.handleEnvSet(req, res);
        return;
      }
      if (pathname === "/api/env" && method === "DELETE") {
        await this.handleEnvUnset(url, res);
        return;
      }
      if (pathname === "/api/env/recommended" && method === "GET") {
        await this.handleEnvRecommended(res);
        return;
      }

      // ---- Skill 搜索 ----
      if (pathname === "/api/skills/search" && method === "GET") {
        await this.handleSkillSearch(url, res);
        return;
      }

      // ---- Agent Team ----
      if (pathname === "/api/team/run" && method === "POST") {
        await this.handleTeamRun(req, res);
        return;
      }
      if (pathname === "/api/team/stream" && method === "POST") {
        await this.handleTeamStream(req, res);
        return;
      }
      if (pathname === "/api/team/presets" && method === "GET") {
        await this.handleTeamPresets(res);
        return;
      }

      // ---- Computer Use ----
      if (pathname === "/api/computer/screenshot" && method === "POST") {
        await this.handleComputerScreenshot(req, res);
        return;
      }
      if (pathname === "/api/computer/click" && method === "POST") {
        await this.handleComputerClick(req, res);
        return;
      }
      if (pathname === "/api/computer/type" && method === "POST") {
        await this.handleComputerType(req, res);
        return;
      }
      if (pathname === "/api/computer/key" && method === "POST") {
        await this.handleComputerKey(req, res);
        return;
      }
      if (pathname === "/api/computer/hotkey" && method === "POST") {
        await this.handleComputerHotkey(req, res);
        return;
      }
      if (pathname === "/api/computer/windows" && method === "GET") {
        await this.handleComputerWindows(res);
        return;
      }
      if (pathname === "/api/computer/launch" && method === "POST") {
        await this.handleComputerLaunch(req, res);
        return;
      }
      if (pathname === "/api/computer/clipboard" && method === "GET") {
        await this.handleComputerClipboardGet(res);
        return;
      }
      if (pathname === "/api/computer/clipboard" && method === "POST") {
        await this.handleComputerClipboardSet(req, res);
        return;
      }
      if (pathname === "/api/computer/history" && method === "GET") {
        await this.handleComputerHistory(res);
        return;
      }
      if (pathname === "/api/computer/browser/open" && method === "POST") {
        await this.handleComputerBrowserOpen(req, res);
        return;
      }
      if (pathname === "/api/computer/browser/eval" && method === "POST") {
        await this.handleComputerBrowserEval(req, res);
        return;
      }
      if (pathname === "/api/computer/browser/screenshot" && method === "GET") {
        await this.handleComputerBrowserScreenshot(res);
        return;
      }

      // ---- Relay ----
      if (pathname === "/api/relay/rules" && method === "GET") {
        await this.handleRelayListRules(res);
        return;
      }
      if (pathname === "/api/relay/rules" && method === "POST") {
        await this.handleRelayAddRule(req, res);
        return;
      }
      if (pathname === "/api/relay/rules" && method === "DELETE") {
        await this.handleRelayDeleteRule(url, res);
        return;
      }
      if (pathname === "/api/relay/rules/toggle" && method === "POST") {
        await this.handleRelayToggleRule(req, res);
        return;
      }
      if (pathname === "/api/relay/test" && method === "POST") {
        await this.handleRelayTest(req, res);
        return;
      }

      // ---- 日志 API ----
      if (pathname === "/api/logs" && method === "GET") {
        await this.handleLogsQuery(url, res);
        return;
      }
      if (pathname === "/api/logs/stats" && method === "GET") {
        await this.handleLogsStats(res);
        return;
      }
      if (pathname === "/api/logs/clear" && method === "POST") {
        await this.handleLogsClear(res);
        return;
      }
      if (pathname === "/api/logs/stream" && method === "GET") {
        await this.handleLogsStream(res);
        return;
      }

      // ---- Langfuse 配置 API ----
      if (pathname === "/api/langfuse/config" && method === "GET") {
        await this.handleLangfuseGetConfig(res);
        return;
      }
      if (pathname === "/api/langfuse/config" && method === "POST") {
        await this.handleLangfuseSetConfig(req, res);
        return;
      }
      if (pathname === "/api/langfuse/test" && method === "POST") {
        await this.handleLangfuseTest(res);
        return;
      }
      if (pathname === "/api/langfuse/flush" && method === "POST") {
        await this.handleLangfuseFlush(res);
        return;
      }
      if (pathname === "/api/langfuse/send-traces" && method === "POST") {
        await this.handleLangfuseSendTraces(res);
        return;
      }

      // ---- 模型管理 API ----
      if (pathname === "/api/models" && method === "GET") {
        await this.handleModelsList(res);
        return;
      }
      if (pathname === "/api/models/active" && method === "GET") {
        await this.handleModelsActive(res);
        return;
      }
      if (pathname === "/api/models/switch" && method === "POST") {
        await this.handleModelsSwitch(req, res);
        return;
      }
      if (pathname === "/api/models" && method === "POST") {
        await this.handleModelsAdd(req, res);
        return;
      }
      const modelsProbeMatch = pathname.match(/^\/api\/models\/([^/]+)\/probe$/);
      if (modelsProbeMatch && method === "POST") {
        await this.handleModelsProbe(modelsProbeMatch[1], res);
        return;
      }
      const modelsPutMatch = pathname.match(/^\/api\/models\/([^/]+)$/);
      if (modelsPutMatch && method === "PUT") {
        await this.handleModelsUpdate(modelsPutMatch[1], req, res);
        return;
      }
      if (modelsPutMatch && method === "DELETE") {
        await this.handleModelsDelete(modelsPutMatch[1], res);
        return;
      }
      if (pathname === "/api/models/recommend" && method === "GET") {
        await this.handleModelsRecommend(url, res);
        return;
      }
      const modelsCompareMatch = pathname.match(/^\/api\/models\/([^/]+)\/compare\/([^/]+)$/);
      if (modelsCompareMatch && method === "GET") {
        await this.handleModelsCompare(modelsCompareMatch[1], modelsCompareMatch[2], res);
        return;
      }

      // ---- 聊天室 API ----
      if (pathname === "/api/chatrooms" && method === "GET") {
        await this.handleChatroomsList(res);
        return;
      }
      if (pathname === "/api/chatrooms" && method === "POST") {
        await this.handleChatroomsCreate(req, res);
        return;
      }
      const chatroomMatch = pathname.match(/^\/api\/chatrooms\/([^/]+)$/);
      const chatroomMembersMatch = pathname.match(/^\/api\/chatrooms\/([^/]+)\/members$/);
      const chatroomJoinMatch = pathname.match(/^\/api\/chatrooms\/([^/]+)\/join$/);
      const chatroomLeaveMatch = pathname.match(/^\/api\/chatrooms\/([^/]+)\/leave$/);
      const chatroomMessagesMatch = pathname.match(/^\/api\/chatrooms\/([^/]+)\/messages$/);
      const chatroomBindTeamMatch = pathname.match(/^\/api\/chatrooms\/([^/]+)\/bind-team$/);
      const chatroomAskMatch = pathname.match(/^\/api\/chatrooms\/([^/]+)\/ask$/);
      const chatroomStreamMatch = pathname.match(/^\/api\/chatrooms\/([^/]+)\/stream$/);
      const chatroomStatsMatch = pathname.match(/^\/api\/chatrooms\/([^/]+)\/stats$/);

      if (chatroomStreamMatch && method === "GET") {
        await this.handleChatroomStream(chatroomStreamMatch[1], req, res);
        return;
      }
      if (chatroomStatsMatch && method === "GET") {
        await this.handleChatroomStats(chatroomStatsMatch[1], res);
        return;
      }
      if (chatroomMembersMatch && method === "GET") {
        await this.handleChatroomMembers(chatroomMembersMatch[1], res);
        return;
      }
      if (chatroomJoinMatch && method === "POST") {
        await this.handleChatroomJoin(chatroomJoinMatch[1], req, res);
        return;
      }
      if (chatroomLeaveMatch && method === "POST") {
        await this.handleChatroomLeave(chatroomLeaveMatch[1], req, res);
        return;
      }
      if (chatroomMessagesMatch && method === "GET") {
        await this.handleChatroomMessages(chatroomMessagesMatch[1], url, res);
        return;
      }
      if (chatroomMessagesMatch && method === "POST") {
        await this.handleChatroomSendMessage(chatroomMessagesMatch[1], req, res);
        return;
      }
      if (chatroomBindTeamMatch && method === "POST") {
        await this.handleChatroomBindTeam(chatroomBindTeamMatch[1], req, res);
        return;
      }
      if (chatroomAskMatch && method === "POST") {
        await this.handleChatroomAsk(chatroomAskMatch[1], req, res);
        return;
      }
      if (chatroomMatch && method === "GET") {
        await this.handleChatroomGet(chatroomMatch[1], res);
        return;
      }
      if (chatroomMatch && method === "DELETE") {
        await this.handleChatroomDelete(chatroomMatch[1], res);
        return;
      }

      // ---- Dreaming API ----
      if (pathname === "/api/dreaming/config" && method === "GET") {
        await this.handleDreamingGetConfig(res);
        return;
      }
      if (pathname === "/api/dreaming/config" && method === "POST") {
        await this.handleDreamingSetConfig(req, res);
        return;
      }
      if (pathname === "/api/dreaming/learn" && method === "POST") {
        await this.handleDreamingLearn(req, res);
        return;
      }
      if (pathname === "/api/dreaming/analyze" && method === "POST") {
        await this.handleDreamingAnalyze(req, res);
        return;
      }
      if (pathname === "/api/dreaming/history" && method === "GET") {
        await this.handleDreamingHistory(res);
        return;
      }
      if (pathname === "/api/dreaming/stats" && method === "GET") {
        await this.handleDreamingStats(res);
        return;
      }
      const dreamingEvolveMatch = pathname.match(/^\/api\/dreaming\/evolve\/([^/]+)$/);
      if (dreamingEvolveMatch && method === "POST") {
        await this.handleDreamingEvolve(dreamingEvolveMatch[1], res);
        return;
      }
      if (pathname === "/api/dreaming/watch/start" && method === "POST") {
        await this.handleDreamingWatchStart(res);
        return;
      }
      if (pathname === "/api/dreaming/watch/stop" && method === "POST") {
        await this.handleDreamingWatchStop(res);
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

  /** GET /api/providers → 支持的 provider 列表（从 PROVIDER_CATALOG 转换，向后兼容） */
  private async handleListProviders(res: ServerResponse): Promise<void> {
    // 从新 catalog 转换为旧格式，保持向后兼容
    const providers = PROVIDER_CATALOG.map((p) => ({
      name: p.name,
      envKey: p.envKey,
      defaultBase: p.defaultBase,
      defaultModel: p.models[0]?.id ?? "",
    }));
    this.writeJSON(res, 200, providers);
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

  /** GET /api/skills → 已安装的 skill 列表（用新 SkillInstaller） */
  private async handleListSkills(res: ServerResponse): Promise<void> {
    try {
      const installer = this.getSkillInstaller();
      const skills = installer.list();
      this.writeJSON(res, 200, skills);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** POST /api/skills/add → 安装 skill（用新 SkillInstaller.install 多源支持） */
  private async handleAddSkill(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body || typeof body.package !== "string") {
      this.writeJSON(res, 400, { error: "Missing 'package' in body" });
      return;
    }
    try {
      const installer = this.getSkillInstaller();
      const result = await installer.install(body.package);
      this.writeJSON(res, 200, { ok: true, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { ok: false, error: msg });
    }
  }

  /** POST /api/skills/remove → 卸载 skill（用新 SkillInstaller.uninstall） */
  private async handleRemoveSkill(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body || typeof body.name !== "string") {
      this.writeJSON(res, 400, { error: "Missing 'name' in body" });
      return;
    }
    try {
      const installer = this.getSkillInstaller();
      const removed = await installer.uninstall(body.name);
      if (!removed) {
        this.writeJSON(res, 404, { error: `Skill not found: ${body.name}` });
        return;
      }
      this.writeJSON(res, 200, { ok: true, removed: body.name });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
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
  // Provider Catalog API
  // ===========================================================================

  /** GET /api/catalog → 完整 PROVIDER_CATALOG */
  private async handleCatalog(res: ServerResponse): Promise<void> {
    this.writeJSON(res, 200, PROVIDER_CATALOG);
  }

  /** GET /api/catalog/sort?mode=price|efficient → 排序后的扁平模型列表 */
  private async handleCatalogSort(url: URL, res: ServerResponse): Promise<void> {
    const mode = url.searchParams.get("mode");
    if (mode !== "price" && mode !== "efficient") {
      this.writeJSON(res, 400, { error: "Invalid mode, use 'price' or 'efficient'" });
      return;
    }
    const sorted = flatCatalogSorted(mode);
    this.writeJSON(res, 200, sorted);
  }

  /** GET /api/catalog/recommend?mode=price|efficient → 推荐组合 top 5 */
  private async handleCatalogRecommend(url: URL, res: ServerResponse): Promise<void> {
    const mode = url.searchParams.get("mode");
    if (mode !== "price" && mode !== "efficient") {
      this.writeJSON(res, 400, { error: "Invalid mode, use 'price' or 'efficient'" });
      return;
    }
    const recs = mode === "price" ? recommendByPrice() : recommendByQuality();
    this.writeJSON(res, 200, recs);
  }

  /** GET /api/catalog/stats → 各 provider 统计 */
  private async handleCatalogStats(res: ServerResponse): Promise<void> {
    this.writeJSON(res, 200, getProviderStats());
  }

  // ===========================================================================
  // 环境变量管理 API
  // ===========================================================================

  /** 获取 EnvManager 单例 */
  private getEnvManager(): EnvManager {
    if (!this.envManager) {
      this.envManager = new EnvManager();
    }
    return this.envManager;
  }

  /** GET /api/env → 列出所有环境变量（含来源、敏感标记、掩码） */
  private async handleEnvList(res: ServerResponse): Promise<void> {
    try {
      const env = this.getEnvManager();
      this.writeJSON(res, 200, env.list());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** POST /api/env → 设置环境变量 */
  private async handleEnvSet(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body || typeof body.key !== "string" || typeof body.value !== "string") {
      this.writeJSON(res, 400, { error: "Missing 'key' or 'value' in body" });
      return;
    }
    try {
      const env = this.getEnvManager();
      env.set(body.key, body.value);
      this.writeJSON(res, 200, { ok: true, key: body.key });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** DELETE /api/env?key=XXX → 删除环境变量 */
  private async handleEnvUnset(url: URL, res: ServerResponse): Promise<void> {
    const key = url.searchParams.get("key");
    if (!key) {
      this.writeJSON(res, 400, { error: "Missing 'key' query parameter" });
      return;
    }
    try {
      const env = this.getEnvManager();
      const removed = env.unset(key);
      this.writeJSON(res, 200, { ok: true, removed });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** GET /api/env/recommended → 推荐的环境变量列表 */
  private async handleEnvRecommended(res: ServerResponse): Promise<void> {
    try {
      const env = this.getEnvManager();
      this.writeJSON(res, 200, env.recommended());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  // ===========================================================================
  // Skill 搜索 API
  // ===========================================================================

  /** 获取 SkillInstaller 单例 */
  private getSkillInstaller(): SkillInstaller {
    if (!this.skillInstaller) {
      this.skillInstaller = new SkillInstaller({ pluginsDir: PLUGINS_DIR });
    }
    return this.skillInstaller;
  }

  /** GET /api/skills/search?q=xxx → 搜索 npm 上的 quark-skill 包 */
  private async handleSkillSearch(url: URL, res: ServerResponse): Promise<void> {
    const q = url.searchParams.get("q") ?? "";
    try {
      const installer = this.getSkillInstaller();
      const results = await installer.search(q);
      this.writeJSON(res, 200, results);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  // ===========================================================================
  // Agent Team API
  // ===========================================================================

  /** 获取 Team 工厂（lazy 初始化，内部 cache agent 实例） */
  private async getTeamFactory(): Promise<AgentFactory> {
    if (this.teamFactory) return this.teamFactory;
    const cfg = loadConfig();
    const cache = new Map<string, { run: (input: string) => Promise<{ reply: string; rounds: number; toolCalls: number; contextTokens: number }> }>();
    this.teamFactory = {
      createAgent(opts) {
        // 同步返回 wrapper，内部 lazy 创建 agent 实例
        const key = `${opts.model ?? ""}-${opts.provider ?? ""}-${opts.systemPrompt ?? ""}`;
        let cached = cache.get(key);
        if (!cached) {
          cached = {
            async run(input: string) {
              const { agent } = await createAgent({
                config: {
                  id: `team-${Date.now()}`,
                  name: "Team Agent",
                  model: opts.model || cfg.model,
                  temperature: cfg.temperature,
                  maxTokens: cfg.maxTokens,
                  maxToolRounds: cfg.maxToolRounds,
                  contextTokenBudget: cfg.contextTokenBudget,
                  workingMemoryRounds: cfg.workingMemoryRounds,
                  timeoutMs: 60_000,
                },
                apiKey: cfg.apiKey,
                baseURL: cfg.baseURL,
                modelName: opts.model || cfg.model,
                dbPath: cfg.dbPath,
                profile: cfg.profile,
              });
              const result = await agent.run(input);
              return {
                reply: result.reply,
                rounds: result.rounds,
                toolCalls: result.toolCalls,
                contextTokens: result.contextTokens,
              };
            },
          };
          cache.set(key, cached);
        }
        return cached;
      },
    };
    return this.teamFactory;
  }

  /** POST /api/team/run → 运行 team 任务 */
  private async handleTeamRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body || !body.config || typeof body.input !== "string") {
      this.writeJSON(res, 400, { error: "Missing 'config' or 'input' in body" });
      return;
    }
    try {
      const factory = await this.getTeamFactory();
      const team = new AgentTeam(body.config as TeamConfig, factory);
      const result = await team.run(body.input as string);
      this.writeJSON(res, 200, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** POST /api/team/stream → SSE 流式返回 team 运行步骤 */
  private async handleTeamStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body || !body.config || typeof body.input !== "string") {
      this.writeJSON(res, 400, { error: "Missing 'config' or 'input' in body" });
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
    res.write(": connected\n\n");

    try {
      const factory = await this.getTeamFactory();
      const team = new AgentTeam(body.config as TeamConfig, factory);
      const generator = team.stream(body.input as string);

      for await (const step of generator) {
        if ("type" in step && step.type === "final") {
          res.write(`event: done\ndata: ${JSON.stringify(step.result)}\n\n`);
        } else {
          res.write(`event: step\ndata: ${JSON.stringify(step)}\n\n`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.write(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`);
    } finally {
      try { res.end(); } catch { /* already ended */ }
    }
  }

  /** GET /api/team/presets → 预定义 team 模板 */
  private async handleTeamPresets(res: ServerResponse): Promise<void> {
    const presets = [
      {
        name: "Sequential Pipeline",
        description: "顺序流水线：每个 agent 处理上一个的输出",
        config: {
          mode: "sequential" as const,
          members: [
            { id: "researcher", name: "研究员", role: "worker" as const, systemPrompt: "你是一个研究助手，负责收集和整理信息。" },
            { id: "writer", name: "撰写者", role: "worker" as const, systemPrompt: "你是一个内容撰写专家，负责将信息组织成清晰的文字。" },
          ],
        },
      },
      {
        name: "MoA (Mixture of Agents)",
        description: "并行调用多个 agent，aggregator 聚合最佳答案",
        config: {
          mode: "moa" as const,
          members: [
            { id: "worker-1", name: "Agent A", role: "worker" as const, systemPrompt: "你是一个分析型助手。" },
            { id: "worker-2", name: "Agent B", role: "worker" as const, systemPrompt: "你是一个创意型助手。" },
            { id: "aggregator", name: "聚合器", role: "aggregator" as const, systemPrompt: "请从多个候选回答中综合出最准确、完整的答案。" },
          ],
        },
      },
      {
        name: "Orchestrator-Worker",
        description: "主控 agent 决定调用哪个 worker，根据结果决定是否继续",
        config: {
          mode: "orchestrator" as const,
          members: [
            { id: "orchestrator", name: "主控", role: "orchestrator" as const, expertise: "任务分配与决策" },
            { id: "coder", name: "程序员", role: "worker" as const, systemPrompt: "你是代码编写专家。", expertise: "编写和调试代码" },
            { id: "reviewer", name: "审阅者", role: "worker" as const, systemPrompt: "你是代码审阅专家。", expertise: "审阅和优化代码" },
          ],
        },
      },
    ];
    this.writeJSON(res, 200, presets);
  }

  // ===========================================================================
  // Computer Use API
  // ===========================================================================

  /** 获取 ComputerService 单例 */
  private getComputer(): ComputerService {
    if (!this.computer) this.computer = new ComputerService({ trace: true });
    return this.computer;
  }

  /** POST /api/computer/screenshot → 截屏 */
  private async handleComputerScreenshot(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    try {
      const cs = this.getComputer();
      const region = body?.region as { x: number; y: number; width: number; height: number } | undefined;
      const result = await cs.screenshot(region);
      this.writeJSON(res, 200, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** POST /api/computer/click → 鼠标点击 */
  private async handleComputerClick(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body || typeof body.x !== "number" || typeof body.y !== "number") {
      this.writeJSON(res, 400, { error: "Missing 'x' or 'y' in body" });
      return;
    }
    try {
      const cs = this.getComputer();
      await cs.click(body as unknown as ClickOptions);
      this.writeJSON(res, 200, { ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** POST /api/computer/type → 输入文本 */
  private async handleComputerType(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body || typeof body.text !== "string") {
      this.writeJSON(res, 400, { error: "Missing 'text' in body" });
      return;
    }
    try {
      const cs = this.getComputer();
      await cs.type(body as unknown as TypeOptions);
      this.writeJSON(res, 200, { ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** POST /api/computer/key → 按键组合 */
  private async handleComputerKey(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body || typeof body.key !== "string") {
      this.writeJSON(res, 400, { error: "Missing 'key' in body" });
      return;
    }
    try {
      const cs = this.getComputer();
      await cs.key(body as unknown as KeyCombo);
      this.writeJSON(res, 200, { ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** POST /api/computer/hotkey → 快捷键 */
  private async handleComputerHotkey(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body || !Array.isArray(body.keys) || body.keys.length < 2) {
      this.writeJSON(res, 400, { error: "Missing 'keys' array (at least 2 keys) in body" });
      return;
    }
    try {
      const cs = this.getComputer();
      await cs.hotkey(...(body.keys as string[]));
      this.writeJSON(res, 200, { ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** GET /api/computer/windows → 列出窗口 */
  private async handleComputerWindows(res: ServerResponse): Promise<void> {
    try {
      const cs = this.getComputer();
      const windows = await cs.listWindows();
      this.writeJSON(res, 200, windows);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** POST /api/computer/launch → 启动应用 */
  private async handleComputerLaunch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body || typeof body.name !== "string") {
      this.writeJSON(res, 400, { error: "Missing 'name' in body" });
      return;
    }
    try {
      const cs = this.getComputer();
      await cs.launchApp(body.name);
      this.writeJSON(res, 200, { ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** GET /api/computer/clipboard → 读取剪贴板 */
  private async handleComputerClipboardGet(res: ServerResponse): Promise<void> {
    try {
      const cs = this.getComputer();
      const text = await cs.getClipboard();
      this.writeJSON(res, 200, { text });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** POST /api/computer/clipboard → 写入剪贴板 */
  private async handleComputerClipboardSet(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body || typeof body.text !== "string") {
      this.writeJSON(res, 400, { error: "Missing 'text' in body" });
      return;
    }
    try {
      const cs = this.getComputer();
      await cs.setClipboard(body.text);
      this.writeJSON(res, 200, { ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** GET /api/computer/history → 操作历史 */
  private async handleComputerHistory(res: ServerResponse): Promise<void> {
    try {
      const cs = this.getComputer();
      this.writeJSON(res, 200, cs.getHistory());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** POST /api/computer/browser/open → 浏览器打开 URL */
  private async handleComputerBrowserOpen(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body || typeof body.url !== "string") {
      this.writeJSON(res, 400, { error: "Missing 'url' in body" });
      return;
    }
    try {
      const cs = this.getComputer();
      await cs.browserOpen(body.url);
      this.writeJSON(res, 200, { ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** POST /api/computer/browser/eval → 浏览器执行 JS */
  private async handleComputerBrowserEval(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body || typeof body.script !== "string") {
      this.writeJSON(res, 400, { error: "Missing 'script' in body" });
      return;
    }
    try {
      const cs = this.getComputer();
      const result = await cs.browserEval(body.script);
      this.writeJSON(res, 200, { ok: true, result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** GET /api/computer/browser/screenshot → 浏览器截图 */
  private async handleComputerBrowserScreenshot(res: ServerResponse): Promise<void> {
    try {
      const cs = this.getComputer();
      const result = await cs.browserScreenshot();
      this.writeJSON(res, 200, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  // ===========================================================================
  // Relay API
  // ===========================================================================

  /** 获取 RelayRouter 单例 */
  private getRelay(): RelayRouter {
    if (!this.relay) {
      const cfg = loadConfig();
      const relayConfig = (cfg as unknown as Record<string, unknown>).relay as { rules: RelayRule[] } | undefined;
      this.relay = new RelayRouter(
        { rules: relayConfig?.rules ?? [] },
        new Map(), // 空 channels，仅 dry-run
      );
    }
    return this.relay;
  }

  /** GET /api/relay/rules → 列出转发规则 */
  private async handleRelayListRules(res: ServerResponse): Promise<void> {
    try {
      const relay = this.getRelay();
      this.writeJSON(res, 200, relay.listRules());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** POST /api/relay/rules → 添加转发规则 */
  private async handleRelayAddRule(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body || typeof body.id !== "string") {
      this.writeJSON(res, 400, { error: "Missing 'id' in body" });
      return;
    }
    try {
      const relay = this.getRelay();
      relay.addRule(body as unknown as RelayRule);
      this.writeJSON(res, 200, { ok: true, id: body.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** DELETE /api/relay/rules?id=xxx → 删除转发规则 */
  private async handleRelayDeleteRule(url: URL, res: ServerResponse): Promise<void> {
    const id = url.searchParams.get("id");
    if (!id) {
      this.writeJSON(res, 400, { error: "Missing 'id' query parameter" });
      return;
    }
    try {
      const relay = this.getRelay();
      const removed = relay.removeRule(id);
      this.writeJSON(res, 200, { ok: true, removed });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** POST /api/relay/rules/toggle → 切换规则启用/禁用 */
  private async handleRelayToggleRule(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body || typeof body.id !== "string" || typeof body.enabled !== "boolean") {
      this.writeJSON(res, 400, { error: "Missing 'id' or 'enabled' in body" });
      return;
    }
    try {
      const relay = this.getRelay();
      relay.toggleRule(body.id, body.enabled);
      this.writeJSON(res, 200, { ok: true, id: body.id, enabled: body.enabled });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** POST /api/relay/test → 测试转发（dry-run） */
  private async handleRelayTest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body || typeof body.channel !== "string" || typeof body.text !== "string") {
      this.writeJSON(res, 400, { error: "Missing 'channel' or 'text' in body" });
      return;
    }
    try {
      const relay = this.getRelay();
      const result = await relay.route({
        channel: body.channel,
        sessionId: (body.sessionId as string) ?? "test",
        userId: (body.userId as string) ?? "test-user",
        text: body.text,
      });
      this.writeJSON(res, 200, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  // ===========================================================================
  // 日志 API
  // ===========================================================================

  /** GET /api/logs → 查询日志 */
  private async handleLogsQuery(url: URL, res: ServerResponse): Promise<void> {
    const levelParam = url.searchParams.get("level");
    const sourceParam = url.searchParams.get("source");
    const search = url.searchParams.get("search") ?? undefined;
    const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
    const level = levelParam ? (levelParam.split(",") as Array<"debug" | "info" | "warn" | "error">) : undefined;
    const source = sourceParam ? sourceParam.split(",") : undefined;
    const result = logger.query({ level, source, search, limit, offset });
    this.writeJSON(res, 200, result);
  }

  /** GET /api/logs/stats → 日志统计 */
  private async handleLogsStats(res: ServerResponse): Promise<void> {
    this.writeJSON(res, 200, logger.stats());
  }

  /** POST /api/logs/clear → 清空日志 */
  private async handleLogsClear(res: ServerResponse): Promise<void> {
    logger.clear();
    this.writeJSON(res, 200, { ok: true });
  }

  /** GET /api/logs/stream → SSE 实时日志流 */
  private async handleLogsStream(res: ServerResponse): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    };
    this.applyCORS(headers);
    res.writeHead(200, headers);
    res.write(": connected\n\n");

    // 订阅日志回调
    const unsubscribe = logger.subscribe((entry) => {
      try {
        res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
      } catch {
        /* 客户端已断开 */
      }
    });

    // 客户端断开时取消订阅
    res.on("close", () => {
      unsubscribe();
    });
  }

  // ===========================================================================
  // Langfuse 配置 API
  // ===========================================================================

  /** GET /api/langfuse/config → 读取 Langfuse 配置 */
  private async handleLangfuseGetConfig(res: ServerResponse): Promise<void> {
    const cfg = loadConfig();
    const lf = (cfg as unknown as Record<string, unknown>).langfuse ?? {};
    this.writeJSON(res, 200, lf);
  }

  /** POST /api/langfuse/config → 写入 Langfuse 配置 */
  private async handleLangfuseSetConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body || typeof body.publicKey !== "string" || typeof body.secretKey !== "string") {
      this.writeJSON(res, 400, { error: "Missing 'publicKey' or 'secretKey' in body" });
      return;
    }
    const langfuseConfig: Record<string, unknown> = {
      publicKey: body.publicKey,
      secretKey: body.secretKey,
      baseUrl: body.baseUrl ?? "https://cloud.langfuse.com",
      enabled: body.enabled ?? false,
    };
    // 写入配置文件
    const existing = (findConfigFile() ?? {}) as Record<string, unknown>;
    existing.langfuse = langfuseConfig;
    writeConfigFile(existing as Partial<QuarkConfig>);
    // 重建 Langfuse 客户端
    if (this.langfuseClient) {
      await this.langfuseClient.shutdown().catch(() => {});
    }
    this.langfuseClient = new LangfuseClient({
      publicKey: body.publicKey as string,
      secretKey: body.secretKey as string,
      baseUrl: (body.baseUrl as string) ?? "https://cloud.langfuse.com",
      enabled: (body.enabled as boolean) ?? false,
    });
    this.writeJSON(res, 200, { ok: true, config: langfuseConfig });
  }

  /** POST /api/langfuse/test → 测试 Langfuse 连接 */
  private async handleLangfuseTest(res: ServerResponse): Promise<void> {
    if (!this.langfuseClient) {
      this.writeJSON(res, 400, { error: "Langfuse not configured" });
      return;
    }
    try {
      // 发一个空 trace 测试连通性
      this.langfuseClient.createTrace({ id: "test-" + Date.now(), name: "connection-test" });
      await this.langfuseClient.flush();
      this.writeJSON(res, 200, { ok: true, message: "连接测试成功" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 200, { ok: false, error: msg });
    }
  }

  /** POST /api/langfuse/flush → 手动 flush */
  private async handleLangfuseFlush(res: ServerResponse): Promise<void> {
    if (!this.langfuseClient) {
      this.writeJSON(res, 400, { error: "Langfuse not configured" });
      return;
    }
    await this.langfuseClient.flush();
    this.writeJSON(res, 200, { ok: true });
  }

  /** POST /api/langfuse/send-traces → 发送当前 tracer 的 span 到 Langfuse */
  private async handleLangfuseSendTraces(res: ServerResponse): Promise<void> {
    if (!this.langfuseClient) {
      this.writeJSON(res, 400, { error: "Langfuse not configured" });
      return;
    }
    let spans: Span[] = [];
    try {
      const instance = await this.getAgent();
      spans = instance.tracer.export();
    } catch {
      // agent 未创建
    }
    this.langfuseClient.sendTracerSpans(spans);
    await this.langfuseClient.flush();
    this.writeJSON(res, 200, { ok: true, sentSpans: spans.length });
  }

  // ===========================================================================
  // 模型管理 API
  // ===========================================================================

  /** 获取 ModelManager 单例 */
  private getModelManager(): ModelManager {
    if (!this.modelManager) {
      this.modelManager = new ModelManager();
    }
    return this.modelManager;
  }

  /** GET /api/models → 列出所有模型配置 */
  private async handleModelsList(res: ServerResponse): Promise<void> {
    try {
      const mm = this.getModelManager();
      this.writeJSON(res, 200, mm.list());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** GET /api/models/active → 当前激活配置 */
  private async handleModelsActive(res: ServerResponse): Promise<void> {
    try {
      const mm = this.getModelManager();
      this.writeJSON(res, 200, mm.getActive());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 404, { error: msg });
    }
  }

  /** POST /api/models/switch → 切换激活配置 */
  private async handleModelsSwitch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body || typeof body.id !== "string") {
      this.writeJSON(res, 400, { error: "Missing 'id' in body" });
      return;
    }
    try {
      const mm = this.getModelManager();
      const config = mm.setActive(body.id as string);
      await this.resetAgent();
      this.writeJSON(res, 200, { ok: true, config });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** POST /api/models → 添加配置 */
  private async handleModelsAdd(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body || typeof body.name !== "string") {
      this.writeJSON(res, 400, { error: "Missing required fields in body" });
      return;
    }
    try {
      const mm = this.getModelManager();
      const config = mm.add({
        name: body.name as string,
        providerId: (body.providerId as string) ?? "",
        modelId: (body.modelId as string) ?? "",
        apiKey: body.apiKey as string | undefined,
        baseURL: body.baseURL as string | undefined,
        parameters: (body.parameters as Record<string, unknown>) ?? {},
      });
      this.writeJSON(res, 200, { ok: true, config });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** PUT /api/models/:id → 更新配置 */
  private async handleModelsUpdate(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body) {
      this.writeJSON(res, 400, { error: "Invalid JSON body" });
      return;
    }
    try {
      const mm = this.getModelManager();
      const config = mm.update(id, body as Record<string, unknown>);
      this.writeJSON(res, 200, { ok: true, config });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** DELETE /api/models/:id → 删除配置 */
  private async handleModelsDelete(id: string, res: ServerResponse): Promise<void> {
    try {
      const mm = this.getModelManager();
      const removed = mm.remove(id);
      this.writeJSON(res, 200, { ok: true, removed });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** POST /api/models/:id/probe → 探测配置可用性 */
  private async handleModelsProbe(id: string, res: ServerResponse): Promise<void> {
    try {
      const mm = this.getModelManager();
      const result = await mm.probe(id);
      this.writeJSON(res, 200, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** GET /api/models/recommend?mode=price|efficient → 推荐配置 */
  private async handleModelsRecommend(url: URL, res: ServerResponse): Promise<void> {
    const mode = url.searchParams.get("mode");
    if (mode !== "price" && mode !== "efficient") {
      this.writeJSON(res, 400, { error: "Invalid mode, use 'price' or 'efficient'" });
      return;
    }
    try {
      const mm = this.getModelManager();
      this.writeJSON(res, 200, mm.recommendFromCatalog(mode));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** GET /api/models/:ida/compare/:idb → 对比两个配置 */
  private async handleModelsCompare(idA: string, idB: string, res: ServerResponse): Promise<void> {
    try {
      const mm = this.getModelManager();
      this.writeJSON(res, 200, mm.compare(idA, idB));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  // ===========================================================================
  // 聊天室 API
  // ===========================================================================

  /** 获取 ChatRoomManager 单例 */
  private getChatroomManager(): ChatRoomManager {
    if (!this.chatroomManager) {
      this.chatroomManager = new ChatRoomManager();
    }
    return this.chatroomManager;
  }

  /** GET /api/chatrooms → 列出所有房间 */
  private async handleChatroomsList(res: ServerResponse): Promise<void> {
    const crm = this.getChatroomManager();
    this.writeJSON(res, 200, crm.listRooms());
  }

  /** POST /api/chatrooms → 创建房间 */
  private async handleChatroomsCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body || typeof body.name !== "string") {
      this.writeJSON(res, 400, { error: "Missing 'name' in body" });
      return;
    }
    const crm = this.getChatroomManager();
    const room = crm.createRoom(body.name as string, body.description as string | undefined);
    this.writeJSON(res, 200, room);
  }

  /** GET /api/chatrooms/:id → 获取房间信息 */
  private async handleChatroomGet(id: string, res: ServerResponse): Promise<void> {
    const crm = this.getChatroomManager();
    const room = crm.getRoom(id);
    if (!room) {
      this.writeJSON(res, 404, { error: "Room not found" });
      return;
    }
    this.writeJSON(res, 200, room);
  }

  /** DELETE /api/chatrooms/:id → 删除房间 */
  private async handleChatroomDelete(id: string, res: ServerResponse): Promise<void> {
    const crm = this.getChatroomManager();
    const removed = crm.deleteRoom(id);
    this.writeJSON(res, 200, { ok: true, removed });
  }

  /** GET /api/chatrooms/:id/members → 列出成员 */
  private async handleChatroomMembers(id: string, res: ServerResponse): Promise<void> {
    const crm = this.getChatroomManager();
    this.writeJSON(res, 200, crm.listMembers(id));
  }

  /** POST /api/chatrooms/:id/join → 加入房间 */
  private async handleChatroomJoin(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body || typeof body.userId !== "string" || typeof body.name !== "string") {
      this.writeJSON(res, 400, { error: "Missing 'userId' or 'name' in body" });
      return;
    }
    const crm = this.getChatroomManager();
    const ok = crm.joinRoom(id, {
      id: body.userId as string,
      name: body.name as string,
      role: (body.role as "admin" | "member" | "observer") ?? "member",
    });
    this.writeJSON(res, 200, { ok });
  }

  /** POST /api/chatrooms/:id/leave → 离开房间 */
  private async handleChatroomLeave(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body || typeof body.userId !== "string") {
      this.writeJSON(res, 400, { error: "Missing 'userId' in body" });
      return;
    }
    const crm = this.getChatroomManager();
    const ok = crm.leaveRoom(id, body.userId as string);
    this.writeJSON(res, 200, { ok });
  }

  /** GET /api/chatrooms/:id/messages → 获取消息 */
  private async handleChatroomMessages(id: string, url: URL, res: ServerResponse): Promise<void> {
    const crm = this.getChatroomManager();
    const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
    const before = url.searchParams.get("before") ? parseInt(url.searchParams.get("before")!, 10) : undefined;
    const messages = crm.getMessages(id, { limit, before });
    this.writeJSON(res, 200, messages);
  }

  /** POST /api/chatrooms/:id/messages → 发消息 */
  private async handleChatroomSendMessage(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body || typeof body.userId !== "string" || typeof body.content !== "string") {
      this.writeJSON(res, 400, { error: "Missing 'userId' or 'content' in body" });
      return;
    }
    try {
      const crm = this.getChatroomManager();
      const msg = crm.sendMessage(id, body.userId as string, body.content as string);
      this.writeJSON(res, 200, msg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** POST /api/chatrooms/:id/bind-team → 绑定 team */
  private async handleChatroomBindTeam(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body) {
      this.writeJSON(res, 400, { error: "Invalid JSON body" });
      return;
    }
    try {
      const crm = this.getChatroomManager();
      crm.bindTeam(id, body as unknown as TeamConfig);
      this.writeJSON(res, 200, { ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** POST /api/chatrooms/:id/ask → 让 team 处理消息 */
  private async handleChatroomAsk(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body || typeof body.messageId !== "string") {
      this.writeJSON(res, 400, { error: "Missing 'messageId' in body" });
      return;
    }
    try {
      const crm = this.getChatroomManager();
      const factory = await this.getTeamFactory();
      const result = await crm.processWithTeam(id, body.messageId as string, factory);
      this.writeJSON(res, 200, { ok: true, messages: result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** GET /api/chatrooms/:id/stream → SSE 实时消息流 */
  private async handleChatroomStream(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    };
    this.applyCORS(headers);
    res.writeHead(200, headers);
    res.write(": connected\n\n");

    try {
      const crm = this.getChatroomManager();
      const unsubscribe = crm.subscribe(id, (msg) => {
        try {
          res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
        } catch {
          /* 客户端已断开 */
        }
      });
      req.on("close", () => {
        unsubscribe();
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.write(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`);
      try { res.end(); } catch { /* already ended */ }
    }
  }

  /** GET /api/chatrooms/:id/stats → 房间统计 */
  private async handleChatroomStats(id: string, res: ServerResponse): Promise<void> {
    const crm = this.getChatroomManager();
    this.writeJSON(res, 200, crm.getStats(id));
  }

  // ===========================================================================
  // Dreaming API
  // ===========================================================================

  /** 获取 DreamingEngine 单例 */
  private getDreamingEngine(): DreamingEngine {
    if (!this.dreamingEngine) {
      this.dreamingEngine = new DreamingEngine({ enabled: true });
    }
    return this.dreamingEngine;
  }

  /** GET /api/dreaming/config → 读取自进化配置 */
  private async handleDreamingGetConfig(res: ServerResponse): Promise<void> {
    const cfg = loadConfig();
    const dreaming = (cfg as unknown as Record<string, unknown>).dreaming ?? { enabled: true, strategy: "both", maxDepth: 3 };
    this.writeJSON(res, 200, dreaming);
  }

  /** POST /api/dreaming/config → 更新自进化配置 */
  private async handleDreamingSetConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body) {
      this.writeJSON(res, 400, { error: "Invalid JSON body" });
      return;
    }
    // 写入配置文件
    const existing = (findConfigFile() ?? {}) as Record<string, unknown>;
    existing.dreaming = body;
    writeConfigFile(existing as Partial<QuarkConfig>);
    // 重建引擎
    this.dreamingEngine = new DreamingEngine(body as Partial<DreamingConfig> & { enabled: boolean });
    this.writeJSON(res, 200, { ok: true, config: body });
  }

  /** POST /api/dreaming/learn → 手动 /learn */
  private async handleDreamingLearn(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body || typeof body.sessionId !== "string") {
      this.writeJSON(res, 400, { error: "Missing 'sessionId' in body" });
      return;
    }
    try {
      const engine = this.getDreamingEngine();
      // 获取当前 tracer 的 span 作为 trace 数据
      let traces: Array<{ name: string; kind: string; status: string; error?: string; attributes?: Record<string, unknown> }> = [];
      try {
        const instance = await this.getAgent();
        traces = instance.tracer.export();
      } catch {
        // agent 未创建，使用空 trace
      }
      const record = await engine.learn(body.sessionId as string, traces);
      this.writeJSON(res, 200, record);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** POST /api/dreaming/analyze → 分析失败 */
  private async handleDreamingAnalyze(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJSON(req);
    if (!body || typeof body.fingerprint !== "string") {
      this.writeJSON(res, 400, { error: "Missing 'fingerprint' in body" });
      return;
    }
    try {
      const engine = this.getDreamingEngine();
      let traces: Array<{ name: string; kind: string; status: string; error?: string; attributes?: Record<string, unknown> }> = [];
      try {
        const instance = await this.getAgent();
        traces = instance.tracer.export();
      } catch {
        // agent 未创建
      }
      const record = await engine.analyzeFailure(body.fingerprint as string, traces);
      this.writeJSON(res, 200, record ?? { ok: false, message: "未触发进化条件" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** GET /api/dreaming/history → 进化历史 */
  private async handleDreamingHistory(res: ServerResponse): Promise<void> {
    const engine = this.getDreamingEngine();
    this.writeJSON(res, 200, engine.getHistory());
  }

  /** GET /api/dreaming/stats → 进化统计 */
  private async handleDreamingStats(res: ServerResponse): Promise<void> {
    const engine = this.getDreamingEngine();
    this.writeJSON(res, 200, engine.getStats());
  }

  /** POST /api/dreaming/evolve/:id → 手动执行某个进化 */
  private async handleDreamingEvolve(id: string, res: ServerResponse): Promise<void> {
    const engine = this.getDreamingEngine();
    const history = engine.getHistory();
    const record = history.find((r) => r.id === id);
    if (!record) {
      this.writeJSON(res, 404, { error: `进化记录不存在: ${id}` });
      return;
    }
    const result = await engine.evolve(record);
    this.writeJSON(res, 200, result);
  }

  /** POST /api/dreaming/watch/start → 启动自动监视 */
  private async handleDreamingWatchStart(res: ServerResponse): Promise<void> {
    const engine = this.getDreamingEngine();
    try {
      const instance = await this.getAgent();
      engine.startAutoWatch(instance.tracer as unknown as import("../dreaming/index.js").WatchableTracer);
      this.writeJSON(res, 200, { ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJSON(res, 500, { error: msg });
    }
  }

  /** POST /api/dreaming/watch/stop → 停止自动监视 */
  private async handleDreamingWatchStop(res: ServerResponse): Promise<void> {
    const engine = this.getDreamingEngine();
    engine.stopAutoWatch();
    this.writeJSON(res, 200, { ok: true });
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
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    });
  }

  /** 把 CORS 头追加到给定 headers */
  private applyCORS(headers: Record<string, string>): void {
    headers["Access-Control-Allow-Origin"] = "*";
    headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS";
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
