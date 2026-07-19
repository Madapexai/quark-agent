#!/usr/bin/env node
/**
 * quark-agent CLI launcher
 *
 * Uses tsx to run the TypeScript source directly, so no pre-build needed.
 * Works with: npx github:Madapexai/quark-agent
 */
const { resolve, dirname, join } = require("path");
const { existsSync } = require("fs");

// Resolve the project root (where this file's parent dir is)
const projectRoot = resolve(__dirname, "..");
const cliPath = resolve(__dirname, "cli.ts");
const tsconfigPath = resolve(projectRoot, "tsconfig.json");

function findTsx() {
  // Strategy 1: Look in project node_modules/.bin
  const localBin = join(projectRoot, "node_modules", ".bin", "tsx");
  if (existsSync(localBin)) return localBin;

  // Strategy 2: Resolve from tsx package
  try {
    const tsxPkg = require.resolve("tsx/package.json", { paths: [projectRoot] });
    const bin = resolve(dirname(tsxPkg), "dist", "cli.mjs");
    if (existsSync(bin)) return bin;
  } catch {}

  // Strategy 3: npx tsx (slower but always works)
  return null;
}

function main() {
  const tsxBin = findTsx();

  // Build args
  const args = [];

  if (tsxBin) {
    args.push(tsxBin);
  } else {
    // Fallback: use node --import tsx/esm
    const { spawn } = require("child_process");
    const child = spawn(process.execPath, [
      "--import", "tsx/esm",
      "--experimental-strip-types",  // Node 22+ native TS
      cliPath,
      ...process.argv.slice(2)
    ], {
      stdio: "inherit",
      cwd: projectRoot,
      env: { ...process.env, TSX_TSCONFIG_PATH: tsconfigPath },
    });
    child.on("exit", (code) => process.exit(code ?? 0));
    child.on("error", (err) => {
      // Last resort: npx tsx
      try {
        const { execSync } = require("child_process");
        execSync(`npx tsx --tsconfig "${tsconfigPath}" "${cliPath}" ${process.argv.slice(2).map(a => `"${a}"`).join(" ")}`, {
          stdio: "inherit",
          cwd: projectRoot,
          env: process.env,
        });
      } catch (e) {
        console.error("[quark-agent] Failed to start. Please install tsx: npm install tsx");
        process.exit(1);
      }
    });
    return;
  }

  // Pass tsconfig so .js imports resolve to .ts
  if (existsSync(tsconfigPath)) {
    args.push("--tsconfig", tsconfigPath);
  }

  args.push(cliPath);
  args.push(...process.argv.slice(2));

  const { spawn } = require("child_process");
  const child = spawn(process.execPath, args, {
    stdio: "inherit",
    cwd: projectRoot,
    env: { ...process.env, TSX_TSCONFIG_PATH: tsconfigPath },
  });

  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (err) => {
    console.error("[quark-agent] Failed to start:", err.message);
    process.exit(1);
  });
}

main();
