#!/usr/bin/env node
/**
 * quark-agent CLI launcher
 *
 * Uses tsx to run the TypeScript source directly, so no pre-build needed.
 * Works with: npx github:Madapexai/quark-agent
 *
 * 重要：不覆盖子进程 cwd，保留用户当前工作目录，确保
 * `findConfigFile()` / `writeConfigFile()` 操作的是用户目录而非 npx 缓存目录。
 */
const { resolve, dirname, join } = require("path");
const { existsSync } = require("fs");
const { spawn } = require("child_process");

// 解析 quark-agent 自身的安装目录（bin 的父目录）
const projectRoot = resolve(__dirname, "..");
const cliPath = resolve(__dirname, "cli.ts");
const tsconfigPath = resolve(projectRoot, "tsconfig.json");

/**
 * 找到 tsx 可执行文件。
 * 优先用本地依赖里的 tsx（npx 安装时已装到 node_modules）。
 */
function findTsx() {
  // 1. project node_modules/.bin/tsx
  const localBin = join(projectRoot, "node_modules", ".bin", "tsx");
  if (existsSync(localBin)) return localBin;

  // 2. 从 tsx package.json 解析 bin
  try {
    const tsxPkg = require.resolve("tsx/package.json", { paths: [projectRoot] });
    const bin = resolve(dirname(tsxPkg), "dist", "cli.mjs");
    if (existsSync(bin)) return bin;
  } catch {}

  return null;
}

function main() {
  const tsxBin = findTsx();
  const args = [];

  if (tsxBin) {
    args.push(tsxBin);
    if (existsSync(tsconfigPath)) args.push("--tsconfig", tsconfigPath);
    args.push(cliPath);
  } else {
    // Fallback: Node 22+ 原生 TS 支持（不需要 tsx）
    // 注意：--experimental-strip-types 不支持路径别名 (paths)，仅在无 tsx 时使用
    args.push("--experimental-strip-types", cliPath);
  }

  args.push(...process.argv.slice(2));

  const child = spawn(process.execPath, args, {
    stdio: "inherit",
    // 关键：不设置 cwd，保留用户当前工作目录
    env: { ...process.env, TSX_TSCONFIG_PATH: tsconfigPath },
  });

  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (err) => {
    console.error("[quark-agent] Failed to start:", err.message);
    console.error("  如果是从 npx github:... 启动，请确认 npm install 完成。");
    process.exit(1);
  });
}

main();
