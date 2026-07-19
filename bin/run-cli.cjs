#!/usr/bin/env node
/**
 * quark-agent CLI launcher
 *
 * Uses tsx to run the TypeScript source directly, so no pre-build needed.
 * Works with: npx github:Madapexai/quark-agent
 */
const { execSync } = require("child_process");
const { resolve, dirname } = require("path");
const cliPath = resolve(__dirname, "cli.ts");

// Use tsx to run the TypeScript CLI
try {
  const { existsSync } = require("fs");
  // Find tsx binary
  const tsxBin = resolve(
    dirname(require.resolve("tsx/package.json")),
    "dist",
    "cli.mjs"
  );

  if (existsSync(tsxBin)) {
    // Spawn tsx as child process, inheriting stdio
    const { spawn } = require("child_process");
    const child = spawn(
      process.execPath,
      [tsxBin, cliPath, ...process.argv.slice(2)],
      { stdio: "inherit", env: process.env }
    );
    child.on("exit", (code) => process.exit(code ?? 0));
    child.on("error", (err) => {
      console.error("[quark-agent] Failed to start:", err.message);
      process.exit(1);
    });
  } else {
    // Fallback: try npx tsx
    execSync(`npx tsx "${cliPath}" ${process.argv.slice(2).map(a => `"${a}"`).join(" ")}`, {
      stdio: "inherit",
      env: process.env,
    });
  }
} catch (err) {
  console.error("[quark-agent] Error:", err.message);
  console.error("\nMake sure tsx is installed: npm install tsx");
  process.exit(1);
}
