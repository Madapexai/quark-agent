#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createServer } from "node:net";

const port = process.env.WORKFLOW_E2E_PORT ?? "3457";
const baseUrl = `http://127.0.0.1:${port}`;
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const serverOutput = [];
let server;

function assertPortAvailable() {
  return new Promise((resolve, reject) => {
    const probe = createServer();

    probe.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use`));
      } else {
        reject(error);
      }
    });
    probe.listen(Number(port), "127.0.0.1", () => {
      probe.close((error) => (error ? reject(error) : resolve()));
    });
  });
}

function startServer() {
  server = spawn(
    npmCommand,
    ["exec", "--", "tsx", "e2e/demo-server.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: port,
        WORKSPACE_ROOT: process.cwd(),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  for (const stream of [server.stdout, server.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      serverOutput.push(chunk);
      if (serverOutput.length > 40) serverOutput.shift();
    });
  }
}

async function waitForServer({ attempts = 40, intervalMs = 250 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Demo server exited with code ${server.exitCode}`);
    }

    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Demo server did not become ready at ${baseUrl}`);
}

function runWorkflowTests() {
  return new Promise((resolve, reject) => {
    const test = spawn(process.execPath, ["e2e/test-workflows-e2e.mjs"], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: port },
      stdio: "inherit",
    });

    test.on("error", reject);
    test.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Workflow E2E tests terminated by ${signal}`));
      } else {
        resolve(code ?? 1);
      }
    });
  });
}

let exitCode = 1;
try {
  await assertPortAvailable();
  startServer();
  await waitForServer();
  exitCode = await runWorkflowTests();
} catch (error) {
  console.error(`[workflow-e2e] ${error.message}`);
  if (serverOutput.length > 0) {
    console.error(serverOutput.join("").trim());
  }
} finally {
  if (server?.exitCode === null) server.kill("SIGTERM");
}

process.exit(exitCode);
