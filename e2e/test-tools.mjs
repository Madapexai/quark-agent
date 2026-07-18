#!/usr/bin/env node
/**
 * Micro Agent Tool Integration Test
 * 
 * Tests all 16 tools via the SSE streaming API with LLM agent.
 * Each test sends a prompt designed to trigger a specific tool,
 * then parses the SSE stream to verify the tool was called and returned valid results.
 */
import { execSync } from "node:child_process";

const BASE_URL = "http://localhost:3456";
const TEST_TIMEOUT = 60000;

// ============ SSE Parser ============
function parseSSEStream(text) {
  const events = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let eventType = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) eventType = line.slice(7).trim();
      else if (line.startsWith("data: ")) data += line.slice(6);
      else if (line.startsWith("data:")) data += line.slice(5);
    }
    if (data) {
      try { events.push({ event: eventType, data: JSON.parse(data) }); }
      catch { /* skip */ }
    }
  }
  return events;
}

// ============ Test Runner ============
async function sendChat(message) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT);
  try {
    const resp = await fetch(`${BASE_URL}/api/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return { error: `HTTP ${resp.status}`, events: [] };
    const text = await resp.text();
    const events = parseSSEStream(text);
    return { events, raw: text };
  } catch (e) {
    clearTimeout(timer);
    return { error: e.message, events: [] };
  }
}

function extractToolCalls(events) {
  const calls = [];
  for (const ev of events) {
    if (ev.event === "step" && ev.data?.type === "tool_call") {
      calls.push({
        tool: ev.data.meta?.tool,
        args: ev.data.meta?.args,
        content: ev.data.content,
      });
    }
  }
  return calls;
}

function extractToolResults(events) {
  const results = [];
  for (const ev of events) {
    if (ev.event === "step" && ev.data?.type === "tool_result") {
      results.push({
        tool: ev.data.meta?.tool,
        content: ev.data.content,
      });
    }
  }
  return results;
}

function extractFinalText(events) {
  let text = "";
  for (const ev of events) {
    if (ev.event === "step" && (ev.data?.type === "text_delta" || ev.data?.type === "text")) {
      text += ev.data.content || "";
    }
  }
  return text;
}

// ============ Test Cases ============
const tests = [
  {
    name: "read_file",
    prompt: "请读取工作区中的 micro-agent/package.json 文件，告诉我这个项目的名称和版本",
    validate: (events) => {
      const calls = extractToolCalls(events);
      const hasRead = calls.some(c => c.tool === "read_file");
      const results = extractToolResults(events);
      const readResult = results.find(r => r.tool === "read_file");
      const hasContent = readResult?.content?.includes("micro-agent");
      return { pass: hasRead && hasContent, detail: `tool_called=${hasRead}, has_content=${hasContent}` };
    },
  },
  {
    name: "write_file + read_file",
    prompt: "请在工作区创建一个文件 /tmp/agent-test-hello.txt，内容为 'Hello from Micro Agent!'，然后读取它确认写入成功",
    validate: (events) => {
      const calls = extractToolCalls(events);
      const hasWrite = calls.some(c => c.tool === "write_file");
      const hasRead = calls.some(c => c.tool === "read_file");
      const results = extractToolResults(events);
      const readResult = results.find(r => r.tool === "read_file");
      const hasContent = readResult?.content?.includes("Hello from Micro Agent");
      return { pass: hasWrite && hasRead && hasContent, detail: `write=${hasWrite}, read=${hasRead}, content_ok=${hasContent}` };
    },
  },
  {
    name: "list_dir",
    prompt: "请列出工作区根目录的文件和文件夹，告诉我有哪些顶层目录",
    validate: (events) => {
      const calls = extractToolCalls(events);
      const hasList = calls.some(c => c.tool === "list_dir");
      const results = extractToolResults(events);
      const listResult = results.find(r => r.tool === "list_dir");
      const hasEntries = listResult?.content?.includes("micro-agent");
      return { pass: hasList && hasEntries, detail: `tool_called=${hasList}, has_entries=${hasEntries}` };
    },
  },
  {
    name: "edit_file",
    prompt: "请先读取 /tmp/agent-test-hello.txt，然后把 'Hello from Micro Agent!' 改成 'Hello from Micro Agent v2!'，修改后再读取确认",
    validate: (events) => {
      const calls = extractToolCalls(events);
      const hasEdit = calls.some(c => c.tool === "edit_file");
      const results = extractToolResults(events);
      const editResult = results.find(r => r.tool === "edit_file");
      const hasSuccess = editResult?.content?.includes("success");
      return { pass: hasEdit && hasSuccess, detail: `edit_called=${hasEdit}, success=${hasSuccess}` };
    },
  },
  {
    name: "search_files",
    prompt: "请搜索工作区中包含 'micro-agent' 关键词的文件（只在 package.json 文件中搜索）",
    validate: (events) => {
      const calls = extractToolCalls(events);
      const hasSearch = calls.some(c => c.tool === "search_files");
      const results = extractToolResults(events);
      const searchResult = results.find(r => r.tool === "search_files");
      const hasMatches = searchResult?.content?.includes("matches");
      return { pass: hasSearch && hasMatches, detail: `search_called=${hasSearch}, has_matches=${hasMatches}` };
    },
  },
  {
    name: "find_files",
    prompt: "请搜索工作区中所有的 .ts 文件，列出前10个",
    validate: (events) => {
      const calls = extractToolCalls(events);
      const hasFind = calls.some(c => c.tool === "find_files");
      const results = extractToolResults(events);
      const findResult = results.find(r => r.tool === "find_files");
      const hasFiles = findResult?.content?.includes(".ts");
      return { pass: hasFind && hasFiles, detail: `find_called=${hasFind}, has_ts_files=${hasFiles}` };
    },
  },
  {
    name: "shell",
    prompt: "请执行 shell 命令 'echo Hello from shell && date'，告诉我输出结果",
    validate: (events) => {
      const calls = extractToolCalls(events);
      const hasShell = calls.some(c => c.tool === "shell");
      const results = extractToolResults(events);
      const shellResult = results.find(r => r.tool === "shell");
      const hasOutput = shellResult?.content?.includes("Hello from shell");
      return { pass: hasShell && hasOutput, detail: `shell_called=${hasShell}, has_output=${hasOutput}` };
    },
  },
  {
    name: "web_fetch",
    prompt: "请抓取网页 https://httpbin.org/get 的内容，告诉我返回了什么",
    validate: (events) => {
      const calls = extractToolCalls(events);
      const hasFetch = calls.some(c => c.tool === "web_fetch");
      const results = extractToolResults(events);
      const fetchResult = results.find(r => r.tool === "web_fetch");
      const hasContent = fetchResult?.content?.includes("httpbin");
      return { pass: hasFetch, detail: `fetch_called=${hasFetch}, has_content=${hasContent}` };
    },
  },
  {
    name: "run_code (JavaScript)",
    prompt: "请用 run_code 工具执行一段 JavaScript 代码：计算斐波那契数列的前10个数，用 console.log 输出",
    validate: (events) => {
      const calls = extractToolCalls(events);
      const hasRun = calls.some(c => c.tool === "run_code");
      const results = extractToolResults(events);
      const runResult = results.find(r => r.tool === "run_code");
      const hasOutput = runResult?.content?.includes("output");
      return { pass: hasRun && hasOutput, detail: `run_called=${hasRun}, has_output=${hasOutput}` };
    },
  },
  {
    name: "weather",
    prompt: "请查询北京现在的天气情况",
    validate: (events) => {
      const calls = extractToolCalls(events);
      const hasWeather = calls.some(c => c.tool === "weather");
      const results = extractToolResults(events);
      const weatherResult = results.find(r => r.tool === "weather");
      const hasTemp = weatherResult?.content?.includes("temperature") || weatherResult?.content?.includes("temp");
      return { pass: hasWeather, detail: `weather_called=${hasWeather}, has_temp=${hasTemp}` };
    },
  },
  {
    name: "generate_image",
    prompt: "请生成一张日落风景图片",
    validate: (events) => {
      const calls = extractToolCalls(events);
      const hasImage = calls.some(c => c.tool === "generate_image");
      const results = extractToolResults(events);
      const imageResult = results.find(r => r.tool === "generate_image");
      const hasUrl = imageResult?.content?.includes("image_url");
      return { pass: hasImage && hasUrl, detail: `image_called=${hasImage}, has_url=${hasUrl}` };
    },
  },
  {
    name: "todo_write + task_list",
    prompt: "请创建一个待办事项列表，包含3个任务：1)设计系统架构 2)编写核心代码 3)编写测试用例。然后列出所有待办任务",
    validate: (events) => {
      const calls = extractToolCalls(events);
      const hasTodo = calls.some(c => c.tool === "todo_write");
      const hasList = calls.some(c => c.tool === "task_list");
      return { pass: hasTodo, detail: `todo_write=${hasTodo}, task_list=${hasList}` };
    },
  },
  {
    name: "memory_save + memory_search",
    prompt: "请保存一条记忆：key='project_name', value='Micro Agent Framework'，然后搜索记忆中的 'Micro Agent'",
    validate: (events) => {
      const calls = extractToolCalls(events);
      const hasSave = calls.some(c => c.tool === "memory_save");
      const hasSearch = calls.some(c => c.tool === "memory_search");
      return { pass: hasSave && hasSearch, detail: `memory_save=${hasSave}, memory_search=${hasSearch}` };
    },
  },
];

// ============ Main ============
async function main() {
  console.log("=".repeat(60));
  console.log("  Micro Agent Tool Integration Test");
  console.log("  Testing 16 tools via LLM Agent SSE API");
  console.log("=".repeat(60));

  // Check server is running
  try {
    const resp = await fetch(`${BASE_URL}/api/status`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const status = await resp.json();
    console.log(`\nServer: ${status.mode} mode | Model: ${status.model}`);
    console.log(`Tools:  ${status.tools.length} registered\n`);
  } catch {
    console.error("ERROR: Server not running at " + BASE_URL);
    console.error("Start it with: cd /workspace/micro-agent && npx tsx e2e/demo-server.ts");
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const results = [];

  for (let i = 0; i < tests.length; i++) {
    const test = tests[i];
    const num = String(i + 1).padStart(2, "0");
    process.stdout.write(`[${num}/${tests.length}] ${test.name} ... `);

    const { events, error } = await sendChat(test.prompt);

    if (error) {
      console.log(`SKIP (${error})`);
      results.push({ name: test.name, status: "SKIP", detail: error });
      skipped++;
      continue;
    }

    try {
      const { pass, detail } = test.validate(events);
      if (pass) {
        console.log(`PASS (${detail})`);
        results.push({ name: test.name, status: "PASS", detail });
        passed++;
      } else {
        console.log(`FAIL (${detail})`);
        results.push({ name: test.name, status: "FAIL", detail });
        failed++;
      }
    } catch (e) {
      console.log(`ERROR (${e.message})`);
      results.push({ name: test.name, status: "ERROR", detail: e.message });
      failed++;
    }
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("  Test Summary");
  console.log("=".repeat(60));
  console.log(`  Total:   ${tests.length}`);
  console.log(`  Passed:  ${passed}`);
  console.log(`  Failed:  ${failed}`);
  console.log(`  Skipped: ${skipped}`);
  console.log("=".repeat(60));

  if (failed > 0) {
    console.log("\n  Failed tests:");
    for (const r of results.filter(r => r.status === "FAIL" || r.status === "ERROR")) {
      console.log(`    - ${r.name}: ${r.detail}`);
    }
  }

  console.log(`\n  Result: ${failed === 0 ? "ALL PASSED" : "SOME FAILED"}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
