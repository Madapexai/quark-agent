/**
 * Unified Config System — single source of truth for all configuration
 *
 * Priority (highest to lowest):
 * 1. Programmatic overrides
 * 2. Environment variables
 * 3. Config file (.quark-agent.json or quark-agent.config.json)
 * 4. Default values
 *
 * No external dependencies — only Node built-ins.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SandboxPolicy } from "../sandbox/policy.js";
import { DEFAULT_POLICY } from "../sandbox/policy.js";
import type { RouterConfig } from "../provider/router.js";

// ============================================================================
// Types
// ============================================================================

export interface QuarkConfig {
  // Provider
  apiKey: string;
  baseURL: string;
  model: string;
  temperature: number;
  maxTokens: number;

  // Multi-provider (MoA)
  providers?: Array<{
    name: string;
    apiKey?: string;
    baseURL?: string;
    model?: string;
  }>;

  // Router
  router?: RouterConfig;

  // Sandbox
  sandbox: SandboxPolicy;

  // Channels
  channels?: {
    discord?: { token: string; channelId: string };
    slack?: { token: string; signingSecret: string; channelId: string; port?: number };
  };

  // Database
  dbPath: string;

  // Agent
  maxToolRounds: number;
  contextTokenBudget: number;
  workingMemoryRounds: number;
  profile: string;

  // Checkpoint
  checkpoint: {
    enabled: boolean;
    /** Auto-save interval in seconds (0 = only on-demand) */
    autoSaveInterval: number;
    /** Max checkpoints per session */
    maxPerSession: number;
  };

  // Long-running programming
  longRunning: {
    enabled: boolean;
    /** Max concurrent tasks */
    maxConcurrent: number;
    /** Task timeout in minutes */
    timeoutMinutes: number;
  };
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_CONFIG: QuarkConfig = {
  apiKey: "",
  baseURL: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  temperature: 0.7,
  maxTokens: 4096,
  sandbox: { ...DEFAULT_POLICY },
  dbPath: "./.data/micro-agent.sqlite",
  maxToolRounds: 6,
  contextTokenBudget: 8000,
  workingMemoryRounds: 12,
  profile: "minimal",
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

// ============================================================================
// Config file discovery
// ============================================================================

const CONFIG_FILENAMES = [".quark-agent.json", "quark-agent.config.json"];

/**
 * Find and parse config file.
 * Searches from cwd upward to root.
 */
export function findConfigFile(): Partial<QuarkConfig> | null {
  let dir = process.cwd();
  for (let i = 0; i < 20; i++) {
    for (const filename of CONFIG_FILENAMES) {
      const path = join(dir, filename);
      if (existsSync(path)) {
        try {
          const raw = readFileSync(path, "utf8");
          return JSON.parse(raw) as Partial<QuarkConfig>;
        } catch {
          return null;
        }
      }
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ============================================================================
// Environment variable mapping
// ============================================================================

function configFromEnv(): Partial<QuarkConfig> {
  const cfg: Partial<QuarkConfig> = {};

  // Provider
  const apiKey = process.env.MICRO_API_KEY ?? process.env.QUARK_API_KEY;
  if (apiKey) cfg.apiKey = apiKey;

  const baseURL = process.env.MICRO_BASE_URL ?? process.env.QUARK_BASE_URL;
  if (baseURL) cfg.baseURL = baseURL;

  const model = process.env.MICRO_MODEL ?? process.env.QUARK_MODEL;
  if (model) cfg.model = model;

  const dbPath = process.env.MICRO_DB ?? process.env.QUARK_DB;
  if (dbPath) cfg.dbPath = dbPath;

  const temperature = process.env.QUARK_TEMPERATURE;
  if (temperature !== undefined) {
    const val = parseFloat(temperature);
    if (!isNaN(val)) cfg.temperature = val;
  }

  const maxTokens = process.env.QUARK_MAX_TOKENS;
  if (maxTokens !== undefined) {
    const val = parseInt(maxTokens, 10);
    if (!isNaN(val) && val > 0) cfg.maxTokens = val;
  }

  const profile = process.env.QUARK_PROFILE;
  if (profile) cfg.profile = profile;

  // Sandbox
  const autoApprove = process.env.QUARK_SANDBOX_AUTO_APPROVE;
  if (autoApprove === "all" || autoApprove === "safe" || autoApprove === "none") {
    cfg.sandbox = { ...DEFAULT_POLICY, toolAutoApprove: autoApprove };
  }

  // Checkpoint
  const checkpointEnabled = process.env.QUARK_CHECKPOINT_ENABLED;
  if (checkpointEnabled !== undefined) {
    cfg.checkpoint = {
      ...DEFAULT_CONFIG.checkpoint,
      enabled: checkpointEnabled === "true",
    };
  }

  // Channels — Discord
  const discordToken = process.env.DISCORD_BOT_TOKEN;
  const discordChannelId = process.env.DISCORD_CHANNEL_ID;
  if (discordToken) {
    cfg.channels = {
      ...cfg.channels,
      discord: { token: discordToken, channelId: discordChannelId ?? "" },
    };
  }

  // Channels — Slack
  const slackToken = process.env.SLACK_BOT_TOKEN;
  const slackSigningSecret = process.env.SLACK_SIGNING_SECRET;
  const slackChannelId = process.env.SLACK_CHANNEL_ID;
  if (slackToken) {
    cfg.channels = {
      ...cfg.channels,
      slack: {
        token: slackToken,
        signingSecret: slackSigningSecret ?? "",
        channelId: slackChannelId ?? "",
      },
    };
  }

  // Multi-provider from env
  const providers: Array<{ name: string; apiKey: string; baseURL?: string; model?: string }> = [];

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    providers.push({
      name: "anthropic",
      apiKey: anthropicKey,
      baseURL: process.env.ANTHROPIC_BASE_URL,
      model: process.env.ANTHROPIC_MODEL,
    });
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    providers.push({
      name: "gemini",
      apiKey: geminiKey,
      baseURL: process.env.GEMINI_BASE_URL,
      model: process.env.GEMINI_MODEL,
    });
  }

  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (openrouterKey) {
    providers.push({
      name: "openrouter",
      apiKey: openrouterKey,
      baseURL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
      model: process.env.OPENROUTER_MODEL,
    });
  }

  if (providers.length > 0) {
    cfg.providers = providers;
  }

  return cfg;
}

// ============================================================================
// Deep merge
// ============================================================================

function deepMerge<T>(base: T, ...overrides: Partial<T>[]): T {
  const result = { ...base } as Record<string, unknown>;
  for (const override of overrides) {
    for (const key of Object.keys(override)) {
      const val = (override as Record<string, unknown>)[key];
      if (val !== undefined) {
        if (
          typeof val === "object" &&
          val !== null &&
          !Array.isArray(val) &&
          typeof result[key] === "object" &&
          result[key] !== null &&
          !Array.isArray(result[key])
        ) {
          result[key] = deepMerge(
            result[key] as Record<string, unknown>,
            val as Partial<Record<string, unknown>>,
          );
        } else {
          result[key] = val;
        }
      }
    }
  }
  return result as T;
}

// ============================================================================
// Load config
// ============================================================================

/**
 * Load config with full priority chain:
 * defaults < config file < env vars < programmatic overrides
 */
export function loadConfig(overrides?: Partial<QuarkConfig>): QuarkConfig {
  const fileConfig = findConfigFile() ?? {};
  const envConfig = configFromEnv();

  return deepMerge(
    DEFAULT_CONFIG,
    fileConfig,
    envConfig,
    overrides ?? {},
  );
}

// ============================================================================
// Write config file
// ============================================================================

/**
 * Write config to .quark-agent.json in cwd.
 * Used by the setup wizard.
 */
export function writeConfigFile(config: Partial<QuarkConfig>): void {
  const path = join(process.cwd(), ".quark-agent.json");
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}
