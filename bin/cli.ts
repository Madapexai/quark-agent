#!/usr/bin/env node
/**
 * micro-agent CLI 入口
 *
 * 用法：
 *   micro-agent chat                      # 启动交互式 CLI
 *   micro-agent ask "你好"                 # 单次问答
 *   micro-agent serve --port 8787         # 启动 HTTP 服务
 *   micro-agent evolve --prompt-file p.txt --eval-file e.json
 *
 * 环境变量：
 *   MICRO_API_KEY     LLM API Key
 *   MICRO_BASE_URL    OpenAI 兼容端点（默认 https://api.openai.com/v1）
 *   MICRO_MODEL       模型名（默认 gpt-4o-mini）
 *   MICRO_DB          SQLite 路径（默认 ./.data/micro-agent.sqlite）
 */

import { createAgent, Runtime, CliChannel, HttpChannel, Evolver } from "../src/index.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { findConfigFile } from "../src/config/index.js";

const apiKey = process.env.MICRO_API_KEY ?? "";
const baseURL = process.env.MICRO_BASE_URL ?? "https://api.openai.com/v1";
const model = process.env.MICRO_MODEL ?? "gpt-4o-mini";
const dbPath = process.env.MICRO_DB ?? "./.data/micro-agent.sqlite";

function usage(): void {
  console.log(`quark-agent — 5KB Agent Kernel

Usage:
  quark-agent                              Interactive CLI (default)
  quark-agent chat                         Interactive CLI
  quark-agent ask "<question>"             One-shot Q&A
  quark-agent serve [--port 8787]          Start HTTP channel
  quark-agent setup [--non-interactive]    First-run setup wizard
  quark-agent add <package>               Install a plugin/skill
  quark-agent list                        List installed plugins
  quark-agent evolve --prompt-file <p> --eval-file <e>

Environment:
  MICRO_API_KEY   LLM API Key (required)
  MICRO_BASE_URL  OpenAI-compatible endpoint
  MICRO_MODEL     Model name
  MICRO_DB        SQLite path

Examples:
  npx quark-agent                          # zero-config CLI chat
  npx quark-agent ask "Read package.json"  # one-shot
  npx quark-agent add @someone/slack-skill # install a plugin
  npx quark-agent setup                    # interactive setup wizard
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "-h" || cmd === "--help") {
    usage();
    process.exit(0);
  }

  if (cmd === "add") {
    await runAdd(args.slice(1));
    return;
  }

  if (cmd === "list") {
    runList();
    return;
  }

  if (cmd === "setup") {
    await runSetup(args.slice(1));
    return;
  }

  if (cmd === "evolve") {
    await runEvolve(args.slice(1));
    return;
  }

  if (!apiKey && !findConfigFile()?.apiKey) {
    showApiKeyGuide();
    process.exit(1);
  }

  const { agent, close } = await createAgent({
    config: {
      id: "micro-agent-cli",
      name: "Micro Agent",
      model,
      temperature: 0.7,
      maxToolRounds: 6,
      timeoutMs: 60_000,
      contextTokenBudget: 8000,
      workingMemoryRounds: 12,
    },
    apiKey,
    baseURL,
    modelName: model,
    dbPath,
    enableSkills: true,
    enableSessions: true,
    soulSpec: {
      id: "default",
      name: "Micro Agent",
      persona: "你是一个轻量、可自进化的 agent 助手。回答简洁、准确。可调用工具完成计算、检索记忆、获取网页。",
      traits: ["简洁", "严谨", "主动"],
      principles: ["不确定时先调用工具验证，不要臆造", "回答控制在必要长度"],
      speakingStyle: "直接给结论，必要时附简短示例",
    },
  });

  try {
    if (cmd === "ask") {
      const question = args.slice(1).join(" ").trim();
      if (!question) {
        console.error("[error] 缺少问题");
        process.exit(1);
      }
      const result = await agent.run(question, { userId: "cli-user", sessionId: "ask", channel: "cli" });
      console.log(result.reply);
      console.error(`\n[rounds=${result.rounds} toolCalls=${result.toolCalls} recovered=${result.recovered}]`);
    } else if (cmd === "serve") {
      const portIdx = args.indexOf("--port");
      const port = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : 8787;
      const channel = new HttpChannel({ port, host: "0.0.0.0" });
      const runtime = new Runtime();
      runtime.register(channel, async (event) => {
        const r = await agent.run(event.text, {
          userId: event.userId,
          sessionId: event.sessionId,
          scope: event.scope,
          channel: event.from,
        });
        return r.reply;
      });
      await runtime.start();
      console.log(`[http] listening on http://0.0.0.0:${port}/chat`);
      const shutdown = async () => {
        await runtime.stop();
        await close();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    } else {
      // 默认 chat
      const channel = new CliChannel();
      const runtime = new Runtime();
      runtime.register(channel, async (event) => {
        const r = await agent.run(event.text, {
          userId: event.userId,
          sessionId: event.sessionId,
          scope: event.scope,
          channel: event.from,
        });
        return r.reply;
      });
      await runtime.start();
      process.on("SIGINT", async () => {
        await runtime.stop();
        await close();
        process.exit(0);
      });
    }
  } catch (err) {
    console.error(`[error] ${err instanceof Error ? err.message : String(err)}`);
    await close();
    process.exit(1);
  }
}

async function runEvolve(args: string[]): Promise<void> {
  const promptFileIdx = args.indexOf("--prompt-file");
  const evalFileIdx = args.indexOf("--eval-file");
  if (promptFileIdx < 0 || evalFileIdx < 0) {
    console.error("[error] evolve 需要 --prompt-file 与 --eval-file");
    process.exit(1);
  }
  const seedPrompt = readFileSync(args[promptFileIdx + 1], "utf8");
  const evalSet = JSON.parse(readFileSync(args[evalFileIdx + 1], "utf8"));

  if (!apiKey) {
    console.error("[error] 未设置 MICRO_API_KEY");
    process.exit(1);
  }

  const { agent, deps, close } = await createAgent({
    config: {
      id: "evolver",
      name: "Evolver",
      model,
    },
    apiKey,
    baseURL,
    modelName: model,
    dbPath,
    enableSkills: true,
  });

  void agent;
  const evolver = new Evolver(deps.provider, deps.tracer, deps.skills);
  const result = await evolver.evolve(seedPrompt, evalSet, {
    populationSize: 3,
    generations: 2,
  });
  console.log("=== 自进化结果 ===");
  console.log("最佳分数:", result.bestScore.toFixed(2), "/ 10");
  console.log("是否沉淀为技能:", result.sedimented);
  console.log("\n历史:");
  for (const h of result.history) {
    console.log(`  gen ${h.generation}: best=${h.best.toFixed(2)} avg=${h.avg.toFixed(2)}`);
  }
  console.log("\n最佳 prompt:\n", result.bestPrompt);
  await close();
}

// ============================================================================
// Plugin management: add / list
// ============================================================================

const PLUGINS_DIR = join(process.cwd(), ".quark-plugins");

async function runAdd(args: string[]): Promise<void> {
  const pkg = args[0];
  if (!pkg) {
    console.error("[error] Specify a package: quark-agent add @someone/skill-name");
    process.exit(1);
  }

  mkdirSync(PLUGINS_DIR, { recursive: true });

  // Check if already installed
  const pluginDir = join(PLUGINS_DIR, pkg.replace(/^@/, "").replace(/\//, "__"));
  if (existsSync(pluginDir)) {
    console.log(`[skip] ${pkg} is already installed at ${pluginDir}`);
    return;
  }

  console.log(`[install] ${pkg} ...`);

  // Try npm install first (works for public packages)
  try {
    execSync(`npm install --no-save ${pkg}`, {
      cwd: PLUGINS_DIR,
      stdio: "pipe",
      timeout: 60_000,
    });
    console.log(`[ok] ${pkg} installed via npm`);

    // Write a manifest so `list` can find it
    const manifest = { package: pkg, installedAt: new Date().toISOString(), source: "npm" };
    writeFileSync(join(PLUGINS_DIR, ".manifest.json"), JSON.stringify(manifest, null, 2));
  } catch {
    // Fallback: try git clone for GitHub shorthands (user/repo)
    if (pkg.includes("/")) {
      const gitUrl = pkg.startsWith("https://") ? pkg : `https://github.com/${pkg}.git`;
      try {
        execSync(`git clone --depth 1 ${gitUrl} ${pluginDir}`, {
          stdio: "pipe",
          timeout: 60_000,
        });
        console.log(`[ok] ${pkg} cloned from GitHub`);
        const manifest = { package: pkg, installedAt: new Date().toISOString(), source: "git" };
        writeFileSync(join(pluginDir, ".manifest.json"), JSON.stringify(manifest, null, 2));
      } catch {
        console.error(`[error] Could not install ${pkg} — not found on npm or GitHub`);
        process.exit(1);
      }
    } else {
      console.error(`[error] Could not install ${pkg} via npm`);
      process.exit(1);
    }
  }

  console.log(`\nPlugin installed. To use it, import in your agent setup:`);
  console.log(`  import "${pkg}";`);
  console.log(`\nOr add to your agent config:`);
  console.log(`  extraActions: [require("${pkg}")]`);
}

function runList(): void {
  if (!existsSync(PLUGINS_DIR)) {
    console.log("No plugins installed. Use: quark-agent add <package>");
    return;
  }

  const entries = readdirSync(PLUGINS_DIR, { withFileTypes: true });
  const plugins = entries.filter(e => e.isDirectory() && !e.name.startsWith("."));

  if (plugins.length === 0) {
    console.log("No plugins installed. Use: quark-agent add <package>");
    return;
  }

  console.log("Installed plugins:\n");
  for (const p of plugins) {
    const manifestPath = join(PLUGINS_DIR, p.name, ".manifest.json");
    if (existsSync(manifestPath)) {
      try {
        const m = JSON.parse(readFileSync(manifestPath, "utf8"));
        console.log(`  ${m.package}  (${m.source})  ${m.installedAt?.slice(0, 10) ?? ""}`);
      } catch {
        console.log(`  ${p.name}  (local)`);
      }
    } else {
      console.log(`  ${p.name}  (local)`);
    }
  }

  // Also check for a root manifest
  const rootManifest = join(PLUGINS_DIR, ".manifest.json");
  if (existsSync(rootManifest)) {
    try {
      const m = JSON.parse(readFileSync(rootManifest, "utf8"));
      console.log(`  ${m.package}  (${m.source})  ${m.installedAt?.slice(0, 10) ?? ""}`);
    } catch {}
  }
}

// ============================================================================
// Setup Wizard & API Key Guide
// ============================================================================

function showApiKeyGuide(): void {
  console.error(`\n[error] No API key configured.

To get started, you need an LLM API key. Choose one of these options:

  1. Set environment variable:
     export MICRO_API_KEY="sk-..."

  2. Run the setup wizard:
     quark-agent setup

  3. Create a config file (.quark-agent.json):
     {
       "apiKey": "sk-...",
       "model": "gpt-4o-mini"
     }

Supported providers:
  - OpenAI       → MICRO_API_KEY + https://api.openai.com/v1
  - Anthropic    → ANTHROPIC_API_KEY + https://api.anthropic.com/v1
  - Gemini       → GEMINI_API_KEY + https://generativelanguage.googleapis.com/v1beta
  - Ollama       → No key needed (local) + http://127.0.0.1:11434
  - OpenRouter   → OPENROUTER_API_KEY + https://openrouter.ai/api/v1
`);
}

const PROVIDER_CHOICES = [
  { name: "OpenAI", envKey: "MICRO_API_KEY", defaultBase: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini" },
  { name: "Anthropic", envKey: "ANTHROPIC_API_KEY", defaultBase: "https://api.anthropic.com/v1", defaultModel: "claude-sonnet-4-5-20250929" },
  { name: "Gemini", envKey: "GEMINI_API_KEY", defaultBase: "https://generativelanguage.googleapis.com/v1beta", defaultModel: "gemini-1.5-flash" },
  { name: "Ollama", envKey: "", defaultBase: "http://127.0.0.1:11434", defaultModel: "llama3.1" },
  { name: "OpenRouter", envKey: "OPENROUTER_API_KEY", defaultBase: "https://openrouter.ai/api/v1", defaultModel: "openai/gpt-4o-mini" },
];

const CHANNEL_CHOICES = ["CLI", "HTTP", "Discord", "Slack"];

const SANDBOX_CHOICES = [
  { name: "strict", desc: "No network, no filesystem, no shell, approve none" },
  { name: "balanced", desc: "Network ok, filesystem ok, denylist only, approve safe (default)" },
  { name: "permissive", desc: "Everything allowed, approve all" },
];

async function runSetup(setupArgs: string[]): Promise<void> {
  const nonInteractive = setupArgs.includes("--non-interactive");

  if (nonInteractive) {
    runSetupNonInteractive();
    return;
  }

  // Interactive setup
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log("\n🚀 quark-agent Setup Wizard\n");

    // 1. Provider
    console.log("Which LLM provider would you like to use?\n");
    for (let i = 0; i < PROVIDER_CHOICES.length; i++) {
      console.log(`  ${i + 1}. ${PROVIDER_CHOICES[i].name}`);
    }
    const providerIdx = await rl.question("\nEnter choice (1-5): ");
    const pIdx = Math.max(0, Math.min(PROVIDER_CHOICES.length - 1, parseInt(providerIdx, 10) - 1));
    const provider = PROVIDER_CHOICES[pIdx];
    console.log(`  → Selected: ${provider.name}\n`);

    // 2. API Key
    let apiKeyValue = "";
    if (provider.envKey) {
      apiKeyValue = await rl.question(`Enter your ${provider.name} API key (or press Enter to set via env var ${provider.envKey}): `);
      if (!apiKeyValue) {
        console.log(`  → Set ${provider.envKey} environment variable before running.`);
      }
    } else {
      console.log(`  → ${provider.name} doesn't require an API key (local).`);
    }

    // 3. Model
    const modelAnswer = await rl.question(`Which model? (default: ${provider.defaultModel}): `);
    const selectedModel = modelAnswer.trim() || provider.defaultModel;
    console.log(`  → Model: ${selectedModel}\n`);

    // 4. Channels
    console.log("Which channels would you like to configure?");
    for (let i = 0; i < CHANNEL_CHOICES.length; i++) {
      console.log(`  ${i + 1}. ${CHANNEL_CHOICES[i]}`);
    }
    const channelAnswer = await rl.question("\nEnter choices (comma-separated, e.g. 1,2): ");
    const selectedChannels = channelAnswer
      .split(",")
      .map((s) => parseInt(s.trim(), 10) - 1)
      .filter((i) => i >= 0 && i < CHANNEL_CHOICES.length)
      .map((i) => CHANNEL_CHOICES[i]);
    if (selectedChannels.length === 0) selectedChannels.push("CLI");
    console.log(`  → Channels: ${selectedChannels.join(", ")}\n`);

    // 5. Sandbox policy
    console.log("Which sandbox policy?");
    for (let i = 0; i < SANDBOX_CHOICES.length; i++) {
      console.log(`  ${i + 1}. ${SANDBOX_CHOICES[i].name} — ${SANDBOX_CHOICES[i].desc}`);
    }
    const sandboxAnswer = await rl.question("\nEnter choice (1-3, default: 2): ");
    const sandboxIdx = sandboxAnswer.trim() ? Math.max(0, Math.min(2, parseInt(sandboxAnswer, 10) - 1)) : 1;
    const sandboxPolicy = SANDBOX_CHOICES[sandboxIdx].name;
    console.log(`  → Sandbox: ${sandboxPolicy}\n`);

    // Build config
    const config: Record<string, unknown> = {
      apiKey: apiKeyValue || undefined,
      baseURL: provider.defaultBase,
      model: selectedModel,
      profile: "minimal",
      sandbox: { toolAutoApprove: sandboxPolicy === "permissive" ? "all" : sandboxPolicy === "strict" ? "none" : "safe" },
      checkpoint: { enabled: true, autoSaveInterval: 60, maxPerSession: 10 },
    };

    // Write config file
    const configPath = join(process.cwd(), ".quark-agent.json");
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");

    console.log(`\n✅ Config written to ${configPath}`);
    console.log("\nNext steps:");
    if (!apiKeyValue && provider.envKey) {
      console.log(`  1. Set your API key:  export ${provider.envKey}="sk-..."`);
      console.log(`  2. Start chatting:     quark-agent chat`);
    } else {
      console.log(`  1. Start chatting:     quark-agent chat`);
    }
    console.log(`  2. Ask a question:    quark-agent ask "Hello"`);
    if (selectedChannels.includes("HTTP")) {
      console.log(`  3. Start HTTP server: quark-agent serve --port 8787`);
    }
    console.log();
  } finally {
    rl.close();
  }
}

function runSetupNonInteractive(): void {
  console.log("\n📝 Generating template config file (.quark-agent.json)...\n");

  const template = {
    "// _comment_provider": "Choose: OpenAI / Anthropic / Gemini / Ollama / OpenRouter",
    apiKey: "YOUR_API_KEY_HERE",
    baseURL: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    temperature: 0.7,
    maxTokens: 4096,
    profile: "minimal",
    dbPath: "./.data/micro-agent.sqlite",
    maxToolRounds: 6,
    contextTokenBudget: 8000,
    workingMemoryRounds: 12,
    "// _comment_sandbox": "toolAutoApprove: 'all' | 'safe' | 'none'",
    sandbox: {
      toolAutoApprove: "safe",
      allowNetwork: true,
      allowFilesystem: true,
      maxTimeoutMs: 30000,
    },
    "// _comment_checkpoint": "Auto-save agent state for long-running tasks",
    checkpoint: {
      enabled: true,
      autoSaveInterval: 60,
      maxPerSession: 10,
    },
    "// _comment_longRunning": "Long-running programming task support",
    longRunning: {
      enabled: false,
      maxConcurrent: 3,
      timeoutMinutes: 30,
    },
    "// _comment_providers": "Additional providers for MoA routing",
    providers: [
      { name: "anthropic", apiKey: "ANTHROPIC_KEY_HERE" },
    ],
    "// _comment_router": "MoA intelligent router config",
    router: {
      fastModel: "gpt-4o-mini",
      mediumModel: "gpt-4o",
      powerfulModel: "o1",
    },
    "// _comment_channels": "Channel configuration (fill in tokens as needed)",
    channels: {
      discord: { token: "DISCORD_BOT_TOKEN", channelId: "CHANNEL_ID" },
      slack: { token: "SLACK_BOT_TOKEN", signingSecret: "SIGNING_SECRET", channelId: "CHANNEL_ID" },
    },
  };

  const configPath = join(process.cwd(), ".quark-agent.json");
  writeFileSync(configPath, JSON.stringify(template, null, 2) + "\n", "utf8");

  console.log(`✅ Template config written to ${configPath}`);
  console.log("\nNext steps:");
  console.log("  1. Edit .quark-agent.json and set your API key");
  console.log("  2. Start chatting:  quark-agent chat");
  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
