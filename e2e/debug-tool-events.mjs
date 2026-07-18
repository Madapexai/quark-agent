#!/usr/bin/env node
/**
 * Debug script: spawn server, hit /api/chat/stream with a tool-requiring prompt,
 * and print every SSE event received. This shows whether the LLM is emitting
 * tool_call events or just text.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

const PORT = "3460";
const BASE = `http://localhost:${PORT}`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForServer(timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch {}
    await sleep(1500);
  }
  return false;
}

async function streamChat(message, timeoutMs = 90000) {
  const res = await fetch(`${BASE}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history: [] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try { events.push(JSON.parse(line.slice(6))); } catch {}
    }
  }
  return events;
}

async function main() {
  console.log("=== Starting demo-server ===");
  const server = spawn("npx", ["tsx", "e2e/demo-server.ts"], {
    cwd: "/workspace/micro-agent",
    env: { ...process.env, PORT },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => process.stderr.write("[server] " + d.toString()));
  server.stderr.on("data", (d) => process.stderr.write("[server-err] " + d.toString()));

  try {
    console.log("Waiting for server...");
    const ready = await waitForServer();
    if (!ready) { console.error("Server failed to start"); process.exit(1); }
    console.log("Server ready.\n");

    const prompts = [
      "What's the weather in Beijing right now?",
      "Read the file package.json and tell me the project name",
      "Run this JavaScript code: console.log(1+1)",
      "List files in the current directory",
    ];

    for (const prompt of prompts) {
      console.log("\n========================================");
      console.log(`PROMPT: ${prompt}`);
      console.log("========================================");
      const evts = await streamChat(prompt, 90000);
      console.log(`Received ${evts.length} events:`);
      for (const e of evts) {
        const c = typeof e.content === "string" ? e.content.slice(0, 120) : JSON.stringify(e.content || "").slice(0, 120);
        const meta = e.meta ? ` meta=${JSON.stringify(e.meta).slice(0, 80)}` : "";
        console.log(`  [${e.type}] ${c}${meta}`);
      }
    }
  } finally {
    console.log("\n=== Shutting down server ===");
    server.kill("SIGTERM");
    await sleep(2000);
    server.kill("SIGKILL");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
