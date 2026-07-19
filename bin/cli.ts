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

  if (cmd === "evolve") {
    await runEvolve(args.slice(1));
    return;
  }

  if (!apiKey) {
    console.error("[error] 未设置 MICRO_API_KEY 环境变量");
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
