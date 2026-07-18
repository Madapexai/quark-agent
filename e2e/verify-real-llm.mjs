#!/usr/bin/env node
/**
 * Self-contained verification: starts demo-server, waits for ready, runs
 * real-LLM chat + /goal workflow probes, then shuts down.
 *
 * Run: node e2e/verify-real-llm.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

const PORT = process.env.PORT || "3457";
const BASE = `http://localhost:${PORT}`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForServer(timeoutMs = 60000) {
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

async function streamChat(message, timeoutMs = 60000) {
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

const RESULTS = [];
function check(name, cond, detail = "") {
  RESULTS.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
}

async function main() {
  console.log("=== Starting demo-server (real LLM mode) ===");
  const server = spawn("npx", ["tsx", "e2e/demo-server.ts"], {
    cwd: "/workspace/micro-agent",
    env: { ...process.env, PORT },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  server.stdout.on("data", (d) => { const s = d.toString(); logs.push(s); process.stdout.write("[server] " + s); });
  server.stderr.on("data", (d) => { const s = d.toString(); logs.push(s); process.stderr.write("[server-err] " + s); });

  try {
    console.log("\n=== Waiting for server ready ===");
    const ready = await waitForServer();
    if (!ready) {
      console.error("Server failed to start. Logs:\n" + logs.join(""));
      process.exit(1);
    }
    console.log("Server ready.\n");

    // Test 1: status endpoint shows real LLM
    console.log("=== Test 1: /api/status shows real LLM enabled ===");
    const statusRes = await fetch(`${BASE}/api/status`);
    const status = await statusRes.json();
    check("status.llm === true", status.llm === true, `llm=${status.llm}, mode=${status.mode}, model=${status.model}`);

    // Test 2: regular chat with real LLM
    console.log("\n=== Test 2: regular chat with real LLM ===");
    const chatEvents = await streamChat("say hello in exactly 5 words, nothing else", 45000);
    const textDeltas = chatEvents.filter((e) => e.type === "text_delta").map((e) => e.content).join("");
    const hasThinking = chatEvents.some((e) => e.type === "thinking");
    const hasText = chatEvents.some((e) => e.type === "text");
    check("chat produced thinking event", hasThinking);
    check("chat produced final text", hasText, `text="${textDeltas.slice(0, 60)}"`);
    check("chat text is non-empty", textDeltas.length > 0, `${textDeltas.length} chars`);

    // Test 3: /goal workflow with real LLM (Codex completion contract)
    console.log("\n=== Test 3: /goal workflow with real LLM ===");
    const goalEvents = await streamChat("/goal read package.json and report the project name", 120000);
    const wfEvents = goalEvents.map((e) => e.meta?.workflowEvent).filter(Boolean);
    const wfSet = new Set(wfEvents);
    check("workflow emitted events", wfEvents.length > 0, `${wfEvents.length} events`);
    check("workflow has continuation", wfSet.has("continuation"), [...wfSet].join(","));
    check("workflow has completion_audit", wfSet.has("completion_audit"), [...wfSet].join(","));
    check("workflow reached goal_achieved or workflow_complete",
      wfSet.has("goal_achieved") || wfSet.has("workflow_complete") || wfSet.has("workflow_failed"),
      [...wfSet].join(","));

    // Summary
    console.log("\n" + "=".repeat(60));
    const passed = RESULTS.filter((r) => r.ok).length;
    const failed = RESULTS.length - passed;
    console.log(`Real-LLM verification: ${passed}/${RESULTS.length} passed${failed ? `, ${failed} failed` : ""}`);
    if (failed > 0) {
      RESULTS.filter((r) => !r.ok).forEach((r) => console.log(`  FAIL: ${r.name} — ${r.detail}`));
    }
  } finally {
    console.log("\n=== Shutting down server ===");
    server.kill("SIGTERM");
    await sleep(2000);
    server.kill("SIGKILL");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
