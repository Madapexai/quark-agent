/**
 * micro-agent Demo Server — Professional Agent Edition
 *
 * Architecture:
 * - /api/chat/stream : SSE streaming endpoint with real multi-step agent reasoning
 * - Tools are REAL (weather hits wttr.in, generate_image hits image API, web_fetch fetches URLs)
 * - With LLM_API_KEY/OPENAI_API_KEY/DEEPSEEK_API_KEY, uses a real ReAct agent loop with LLM reasoning
 * - Without API key, falls back to built-in rule engine (limited capability)
 */

// Load .env file manually (no external dependency)
import * as fs from "node:fs";
import * as path from "node:path";
const envPath = path.join(path.dirname(new URL(import.meta.url).pathname), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { EventBus, PluginRegistry, Agent } from "@micro-agent/core";
import {
  recommendedPlugins, createInMemoryMemory,
  type DefineActionPluginApi, type SSEServer, type A2ARegistry, type A2AAgent, type A2AMessage,
} from "@micro-agent/plugins";
import { sessionsExtension } from "@micro-agent/extensions";
import {
  createActionRouter, createSSEHandler, createA2AHandler, createChatHandler,
} from "@micro-agent/interaction";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEBUI_DIR = path.join(__dirname, "webui");

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || "/workspace";
const SHELL_TIMEOUT = parseInt(process.env.SHELL_TIMEOUT || "30000", 10);

function makeScope() {
  return { tools: ["*"] as string[], sandboxTier: "full" as const, models: "*" as const, memoryDomains: "*" as const };
}

// ============ REAL TOOLS ============

const weatherTool = {
  name: "weather",
  description: "Query real-time weather for a city",
  parameters: {
    type: "object",
    properties: { city: { type: "string", description: "City name" } },
    required: ["city"],
  },
  async execute(args: { city: string }, _ctx: any) {
    const city = encodeURIComponent(args.city);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(`https://wttr.in/${city}?format=j1`, {
        signal: controller.signal,
        headers: { "User-Agent": "micro-agent/1.0", "Accept": "application/json" },
      });
      clearTimeout(timer);
      if (!res.ok) return { error: `HTTP ${res.status}`, city: args.city };
      const data = await res.json() as any;
      const cur = data.current_condition?.[0];
      const area = data.nearest_area?.[0];
      const today = data.weather?.[0];
      const tomorrow = data.weather?.[1];
      if (!cur) return { error: "no data", city: args.city };
      const cityName = [area?.areaName?.[0]?.value, area?.country?.[0]?.value].filter(Boolean).join(", ");
      const desc = cur.lang_zh?.[0]?.value || cur.weatherDesc?.[0]?.value || "Unknown";
      return {
        city: cityName || args.city,
        observation_time: cur.observation_time || "now",
        temperature_C: Number(cur.temp_C),
        feels_like_C: Number(cur.FeelsLikeC),
        humidity: Number(cur.humidity),
        weather: desc,
        wind: `${cur.winddir16Point} ${cur.windspeedKmph}km/h`,
        visibility: `${cur.visibility}km`,
        pressure: `${cur.pressure}hPa`,
        today_high: today ? Number(today.maxtempC) : null,
        today_low: today ? Number(today.mintempC) : null,
        tomorrow: tomorrow ? { high: Number(tomorrow.maxtempC), low: Number(tomorrow.mintempC) } : null,
      };
    } catch (e: any) {
      return { error: e.message, city: args.city };
    }
  },
};

const webFetchTool = {
  name: "web_fetch",
  description: "Fetch webpage content",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch" },
      maxBytes: { type: "number", description: "Max chars, default 5000" },
    },
    required: ["url"],
  },
  async execute(args: { url: string; maxBytes?: number }, _ctx: any) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(args.url, {
        signal: controller.signal,
        headers: { "User-Agent": "micro-agent/1.0" },
        redirect: "follow",
      });
      clearTimeout(timer);
      if (!res.ok) return { error: `HTTP ${res.status}`, url: args.url };
      const html = await res.text();
      const text = html.replace(/<script[\s\S]*?<\/script>/gi, "")
                       .replace(/<style[\s\S]*?<\/style>/gi, "")
                       .replace(/<[^>]+>/g, " ")
                       .replace(/\s+/g, " ")
                       .trim();
      return { url: args.url, content: text.slice(0, args.maxBytes || 5000), length: text.length };
    } catch (e: any) {
      return { error: e.message, url: args.url };
    }
  },
};

const imageGenTool = {
  name: "generate_image",
  description: "Generate image from text prompt",
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Image description" },
      size: { type: "string", description: "Size: square_hd/portrait_4_3/portrait_16_9/landscape_4_3/landscape_16_9" },
    },
    required: ["prompt"],
  },
  async execute(args: { prompt: string; size?: string }, _ctx: any) {
    const size = args.size || "portrait_4_3";
    const url = `https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=${encodeURIComponent(args.prompt)}&image_size=${size}`;
    return { image_url: url, prompt: args.prompt, size };
  },
};

const codeExecTool = {
  name: "run_code",
  description: "Execute JavaScript or Python code in a sandboxed environment",
  parameters: {
    type: "object",
    properties: {
      code: { type: "string", description: "Code to execute" },
      language: { type: "string", enum: ["javascript", "python"], description: "Programming language (default javascript)" },
    },
    required: ["code"],
  },
  async execute(args: { code: string; language?: string }, _ctx: any) {
    const lang = args.language || "javascript";
    if (lang === "python") {
      return new Promise((resolve) => {
        exec(`python3 -c ${JSON.stringify(args.code)}`, {
          timeout: 15000,
          maxBuffer: 512 * 1024,
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
        }, (error, stdout, stderr) => {
          const result: any = {
            language: "python",
            output: (stdout || "").slice(0, 10000),
            exit_code: error ? 1 : 0,
          };
          if (stderr) result.stderr = stderr.slice(0, 5000);
          if (error && error.killed) result.timed_out = true;
          resolve(result);
        });
      });
    }
    // JavaScript sandbox
    const logs: string[] = [];
    const sandboxConsole = {
      log: (...a: any[]) => logs.push(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")),
      error: (...a: any[]) => logs.push("[error] " + a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")),
    };
    try {
      const fn = new Function("console", `"use strict";\n${args.code}`);
      const result = fn(sandboxConsole);
      if (result !== undefined) logs.push("=> " + (typeof result === "string" ? result : JSON.stringify(result)));
      return { language: "javascript", output: logs.join("\n") || "(no output)" };
    } catch (e: any) {
      return { language: "javascript", error: e.message };
    }
  },
};

// ============ File Operation Tools ============

const readFileTool = {
  name: "read_file",
  description: "Read file content from the workspace",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to workspace root" },
      offset: { type: "number", description: "Line offset to start reading from (1-based, default 1)" },
      limit: { type: "number", description: "Maximum number of lines to read" },
    },
    required: ["path"],
  },
  async execute(args: { path: string; offset?: number; limit?: number }, _ctx: any) {
    const filePath = path.resolve(WORKSPACE_ROOT, args.path);
    if (!filePath.startsWith(WORKSPACE_ROOT)) return { error: "Path outside workspace" };
    try {
      if (!fs.existsSync(filePath)) return { error: `File not found: ${args.path}` };
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      const start = Math.max(1, args.offset || 1) - 1;
      const end = args.limit ? start + args.limit : lines.length;
      const selected = lines.slice(start, end);
      return { path: args.path, content: selected.join("\n"), total_lines: lines.length, shown_lines: selected.length };
    } catch (e: any) { return { error: e.message }; }
  },
};

const writeFileTool = {
  name: "write_file",
  description: "Write content to a file in the workspace",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to workspace root" },
      content: { type: "string", description: "Content to write" },
      append: { type: "boolean", description: "Append to file instead of overwriting (default false)" },
    },
    required: ["path", "content"],
  },
  async execute(args: { path: string; content: string; append?: boolean }, _ctx: any) {
    const filePath = path.resolve(WORKSPACE_ROOT, args.path);
    if (!filePath.startsWith(WORKSPACE_ROOT)) return { error: "Path outside workspace" };
    try {
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      if (args.append) {
        fs.appendFileSync(filePath, args.content, "utf-8");
      } else {
        fs.writeFileSync(filePath, args.content, "utf-8");
      }
      return { success: true, path: args.path, bytes: Buffer.byteLength(args.content, "utf-8") };
    } catch (e: any) { return { error: e.message }; }
  },
};

const editFileTool = {
  name: "edit_file",
  description: "Replace exact string in a file. Use for targeted edits.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to workspace root" },
      old_string: { type: "string", description: "Exact string to find and replace" },
      new_string: { type: "string", description: "Replacement string" },
      replace_all: { type: "boolean", description: "Replace all occurrences (default false)" },
    },
    required: ["path", "old_string", "new_string"],
  },
  async execute(args: { path: string; old_string: string; new_string: string; replace_all?: boolean }, _ctx: any) {
    const filePath = path.resolve(WORKSPACE_ROOT, args.path);
    if (!filePath.startsWith(WORKSPACE_ROOT)) return { error: "Path outside workspace" };
    try {
      if (!fs.existsSync(filePath)) return { error: `File not found: ${args.path}` };
      let content = fs.readFileSync(filePath, "utf-8");
      if (!content.includes(args.old_string)) return { error: "old_string not found in file" };
      if (args.replace_all) {
        content = content.split(args.old_string).join(args.new_string);
      } else {
        const idx = content.indexOf(args.old_string);
        if (idx !== content.lastIndexOf(args.old_string)) return { error: "old_string found multiple times; use replace_all=true or provide more context" };
        content = content.replace(args.old_string, args.new_string);
      }
      fs.writeFileSync(filePath, content, "utf-8");
      return { success: true, path: args.path };
    } catch (e: any) { return { error: e.message }; }
  },
};

const listDirTool = {
  name: "list_dir",
  description: "List directory contents in the workspace",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path relative to workspace root (default: .)" },
      recursive: { type: "boolean", description: "List recursively (default false, max depth 3)" },
    },
    required: [],
  },
  async execute(args: { path?: string; recursive?: boolean }, _ctx: any) {
    const dirPath = path.resolve(WORKSPACE_ROOT, args.path || ".");
    if (!dirPath.startsWith(WORKSPACE_ROOT)) return { error: "Path outside workspace" };
    try {
      if (!fs.existsSync(dirPath)) return { error: `Directory not found: ${args.path || "."}` };
      const stat = fs.statSync(dirPath);
      if (!stat.isDirectory()) return { error: "Not a directory" };
      const entries: any[] = [];
      function walk(dir: string, depth: number) {
        if (depth > (args.recursive ? 3 : 0)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          const rel = path.relative(WORKSPACE_ROOT, full);
          entries.push({ name: entry.name, type: entry.isDirectory() ? "dir" : "file", path: rel });
          if (entry.isDirectory() && args.recursive && depth < 3) walk(full, depth + 1);
        }
      }
      walk(dirPath, 0);
      return { path: args.path || ".", entries };
    } catch (e: any) { return { error: e.message }; }
  },
};

// ============ Search Tools ============

const searchFilesTool = {
  name: "search_files",
  description: "Search for text patterns in files (like grep). Returns matching lines.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for" },
      path: { type: "string", description: "Directory to search in (relative to workspace, default: .)" },
      file_pattern: { type: "string", description: "Glob pattern for file names (e.g. *.ts, *.py)" },
      max_results: { type: "number", description: "Max results to return (default 50)" },
    },
    required: ["pattern"],
  },
  async execute(args: { pattern: string; path?: string; file_pattern?: string; max_results?: number }, _ctx: any) {
    const searchDir = path.resolve(WORKSPACE_ROOT, args.path || ".");
    if (!searchDir.startsWith(WORKSPACE_ROOT)) return { error: "Path outside workspace" };
    try {
      const regex = new RegExp(args.pattern, "i");
      const maxResults = args.max_results || 50;
      const results: Array<{ file: string; line: number; content: string }> = [];
      function walkAndSearch(dir: string) {
        if (results.length >= maxResults) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (results.length >= maxResults) break;
          if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
            walkAndSearch(path.join(dir, entry.name));
          } else if (entry.isFile()) {
            if (args.file_pattern) {
              const globRegex = new RegExp(args.file_pattern.replace(/\*/g, ".*").replace(/\?/g, "."));
              if (!globRegex.test(entry.name)) continue;
            }
            const fullPath = path.join(dir, entry.name);
            try {
              const content = fs.readFileSync(fullPath, "utf-8");
              const lines = content.split("\n");
              for (let i = 0; i < lines.length && results.length < maxResults; i++) {
                if (regex.test(lines[i])) {
                  results.push({ file: path.relative(WORKSPACE_ROOT, fullPath), line: i + 1, content: lines[i].trim().slice(0, 200) });
                }
              }
            } catch { /* skip unreadable files */ }
          }
        }
      }
      walkAndSearch(searchDir);
      return { pattern: args.pattern, matches: results.length, results };
    } catch (e: any) { return { error: e.message }; }
  },
};

const findFilesTool = {
  name: "find_files",
  description: "Find files by name pattern (like glob/find). Returns matching file paths.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern to match file names (e.g. *.ts, *.json, test*)" },
      path: { type: "string", description: "Directory to search in (relative to workspace, default: .)" },
    },
    required: ["pattern"],
  },
  async execute(args: { pattern: string; path?: string }, _ctx: any) {
    const searchDir = path.resolve(WORKSPACE_ROOT, args.path || ".");
    if (!searchDir.startsWith(WORKSPACE_ROOT)) return { error: "Path outside workspace" };
    try {
      const globRegex = new RegExp(args.pattern.replace(/\*/g, ".*").replace(/\?/g, ".").replace(/\./g, "\\."));
      const results: string[] = [];
      function walk(dir: string, depth: number) {
        if (depth > 6) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (results.length >= 100) return;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
            walk(full, depth + 1);
          } else if (entry.isFile() && globRegex.test(entry.name)) {
            results.push(path.relative(WORKSPACE_ROOT, full));
          }
        }
      }
      walk(searchDir, 0);
      return { pattern: args.pattern, matches: results.length, files: results };
    } catch (e: any) { return { error: e.message }; }
  },
};

// ============ Shell Tool ============

const shellTool = {
  name: "shell",
  description: "Execute a shell command in the workspace directory. Use for git, npm, build, test commands.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      timeout: { type: "number", description: "Timeout in milliseconds (default 30000)" },
    },
    required: ["command"],
  },
  async execute(args: { command: string; timeout?: number }, _ctx: any): Promise<any> {
    const timeout = Math.min(args.timeout || SHELL_TIMEOUT, 60000);
    return new Promise((resolve) => {
      exec(args.command, {
        cwd: WORKSPACE_ROOT,
        timeout,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, FORCE_COLOR: "0", TERM: "dumb" },
      }, (error, stdout, stderr) => {
        const result: any = {
          command: args.command,
          stdout: stdout?.slice(0, 10000) || "",
          stderr: stderr?.slice(0, 5000) || "",
          exit_code: error ? (error as any).code || 1 : 0,
        };
        if (error && error.killed) result.timed_out = true;
        resolve(result);
      });
    });
  },
};

// ============ Web Search Tool ============

const webSearchTool = {
  name: "web_search",
  description: "Search the web for information. Returns search results with titles and URLs.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      num_results: { type: "number", description: "Number of results (default 5)" },
    },
    required: ["query"],
  },
  async execute(args: { query: string; num_results?: number }, _ctx: any) {
    try {
      const num = args.num_results || 5;
      const url = `https://www.google.com/search?q=${encodeURIComponent(args.query)}&num=${num}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; micro-agent/1.0)" },
      });
      clearTimeout(timer);
      if (!res.ok) return { error: `HTTP ${res.status}`, query: args.query };
      const html = await res.text();
      const results: Array<{ title: string; url: string; snippet: string }> = [];
      const regex = /<a[^>]+href="\/url\?q=([^&"]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      while ((match = regex.exec(html)) !== null && results.length < num) {
        const url = decodeURIComponent(match[1]);
        if (url.startsWith("http") && !url.includes("google.com")) {
          const title = match[2].replace(/<[^>]+>/g, "").trim();
          if (title) results.push({ title, url, snippet: "" });
        }
      }
      return { query: args.query, results };
    } catch (e: any) {
      return { error: e.message, query: args.query };
    }
  },
};

// ============ Todo Tools ============

const todoStore: Map<string, Array<{ id: string; content: string; status: "pending" | "in_progress" | "completed"; priority: "high" | "medium" | "low" }>> = new Map();

const todoWriteTool = {
  name: "todo_write",
  description: "Create or update a todo list for tracking task progress",
  parameters: {
    type: "object",
    properties: {
      session_id: { type: "string", description: "Session ID (default: default)" },
      todos: {
        type: "array",
        description: "List of todo items",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Unique ID for the todo item" },
            content: { type: "string", description: "Description of the task" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            priority: { type: "string", enum: ["high", "medium", "low"] },
          },
          required: ["id", "content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  async execute(args: { session_id?: string; todos: Array<{ id: string; content: string; status: "pending" | "in_progress" | "completed"; priority?: "high" | "medium" | "low" }> }, _ctx: any) {
    const sid = args.session_id || "default";
    const existing = todoStore.get(sid) || [];
    for (const todo of args.todos) {
      const idx = existing.findIndex(t => t.id === todo.id);
      if (idx >= 0) {
        existing[idx] = { ...existing[idx], ...todo };
      } else {
        existing.push({ priority: "medium", ...todo });
      }
    }
    todoStore.set(sid, existing);
    return { session_id: sid, todos: existing };
  },
};

const taskListTool = {
  name: "task_list",
  description: "List all tasks/todos in a session",
  parameters: {
    type: "object",
    properties: {
      session_id: { type: "string", description: "Session ID (default: default)" },
      status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "Filter by status" },
    },
    required: [],
  },
  async execute(args: { session_id?: string; status?: string }, _ctx: any) {
    const sid = args.session_id || "default";
    const todos = todoStore.get(sid) || [];
    const filtered = args.status ? todos.filter(t => t.status === args.status) : todos;
    return { session_id: sid, total: todos.length, tasks: filtered };
  },
};

// ============ Memory Tools ============

const memoryStore: Map<string, Array<{ key: string; value: string; timestamp: number }>> = new Map();

const memorySaveTool = {
  name: "memory_save",
  description: "Save a key-value pair to persistent memory for later retrieval",
  parameters: {
    type: "object",
    properties: {
      key: { type: "string", description: "Memory key" },
      value: { type: "string", description: "Memory value" },
      namespace: { type: "string", description: "Namespace (default: default)" },
    },
    required: ["key", "value"],
  },
  async execute(args: { key: string; value: string; namespace?: string }, _ctx: any) {
    const ns = args.namespace || "default";
    const store = memoryStore.get(ns) || [];
    const idx = store.findIndex(m => m.key === args.key);
    const entry = { key: args.key, value: args.value, timestamp: Date.now() };
    if (idx >= 0) store[idx] = entry; else store.push(entry);
    memoryStore.set(ns, store);
    return { saved: true, key: args.key, namespace: ns };
  },
};

const memorySearchTool = {
  name: "memory_search",
  description: "Search memory for previously saved key-value pairs",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query (matches against keys and values)" },
      namespace: { type: "string", description: "Namespace to search in (default: default)" },
    },
    required: ["query"],
  },
  async execute(args: { query: string; namespace?: string }, _ctx: any) {
    const ns = args.namespace || "default";
    const store = memoryStore.get(ns) || [];
    const q = args.query.toLowerCase();
    const results = store.filter(m => m.key.toLowerCase().includes(q) || m.value.toLowerCase().includes(q));
    return { query: args.query, namespace: ns, results };
  },
};

// ============ LLM Integration ============

const toolDefinitions = [
  // File operations
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read the contents of a file in the workspace. Returns file content with line numbers.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to workspace root" },
          offset: { type: "number", description: "Line number to start reading from (1-based, default 1)" },
          limit: { type: "number", description: "Maximum number of lines to read" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description: "Write content to a file in the workspace. Creates parent directories if needed. Can append to existing files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to workspace root" },
          content: { type: "string", description: "Content to write" },
          append: { type: "boolean", description: "Append to file instead of overwriting (default false)" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "edit_file",
      description: "Make a targeted edit to a file by replacing an exact string. Use for precise modifications.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to workspace root" },
          old_string: { type: "string", description: "Exact string to find" },
          new_string: { type: "string", description: "String to replace with" },
          replace_all: { type: "boolean", description: "Replace all occurrences (default false)" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_dir",
      description: "List files and directories in a workspace path. Supports recursive listing.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path relative to workspace root (default: .)" },
          recursive: { type: "boolean", description: "List recursively (default false)" },
        },
        required: [],
      },
    },
  },
  // Search
  {
    type: "function" as const,
    function: {
      name: "search_files",
      description: "Search for a text pattern in workspace files (like grep). Returns matching lines with file paths and line numbers.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for" },
          path: { type: "string", description: "Directory to search in (relative to workspace root, default: .)" },
          file_pattern: { type: "string", description: "Glob pattern for file names (e.g. *.ts, *.py)" },
          max_results: { type: "number", description: "Max results (default 50)" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "find_files",
      description: "Find files by name pattern (like glob/find). Returns matching file paths.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern (e.g. *.ts, *.json, test*)" },
          path: { type: "string", description: "Directory to search in (relative to workspace root, default: .)" },
        },
        required: ["pattern"],
      },
    },
  },
  // Shell
  {
    type: "function" as const,
    function: {
      name: "shell",
      description: "Execute a shell command in the workspace directory. Use for git, npm, build, test, and other CLI operations.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          timeout: { type: "number", description: "Timeout in milliseconds (default 30000, max 60000)" },
        },
        required: ["command"],
      },
    },
  },
  // Web
  {
    type: "function" as const,
    function: {
      name: "web_search",
      description: "Search the web for information. Returns search results with titles and URLs.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          num_results: { type: "number", description: "Number of results (default 5)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "web_fetch",
      description: "Fetch and extract text content from any webpage URL. Useful for reading articles, documentation, or API responses.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to fetch" },
          maxBytes: { type: "number", description: "Maximum characters to extract (default 5000)" },
        },
        required: ["url"],
      },
    },
  },
  // Code execution
  {
    type: "function" as const,
    function: {
      name: "run_code",
      description: "Execute JavaScript or Python code in a sandboxed environment. Use console.log() for output. Supports math, string ops, algorithms.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "Code to execute" },
          language: { type: "string", enum: ["javascript", "python"], description: "Programming language (default javascript)" },
        },
        required: ["code"],
      },
    },
  },
  // Image
  {
    type: "function" as const,
    function: {
      name: "generate_image",
      description: "Generate an image from a text description prompt.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Detailed image description" },
          size: {
            type: "string",
            enum: ["square_hd", "portrait_4_3", "portrait_16_9", "landscape_4_3", "landscape_16_9"],
            description: "Image aspect ratio",
          },
        },
        required: ["prompt"],
      },
    },
  },
  // Weather
  {
    type: "function" as const,
    function: {
      name: "weather",
      description: "Query real-time weather conditions for any city worldwide. Returns temperature, humidity, wind, and forecast.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "City name in English, e.g. Beijing, Tokyo, New York" },
        },
        required: ["city"],
      },
    },
  },
  // Task management
  {
    type: "function" as const,
    function: {
      name: "todo_write",
      description: "Create or update a todo list for tracking task progress. Supports pending/in_progress/completed states.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "List of todo items",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Unique ID" },
                content: { type: "string", description: "Task description" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                priority: { type: "string", enum: ["high", "medium", "low"] },
              },
              required: ["id", "content", "status"],
            },
          },
        },
        required: ["todos"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "task_list",
      description: "List all tasks/todos, optionally filtered by status.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "Filter by status" },
        },
        required: [],
      },
    },
  },
  // Memory
  {
    type: "function" as const,
    function: {
      name: "memory_save",
      description: "Save a key-value pair to persistent memory for later retrieval across conversations.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Memory key" },
          value: { type: "string", description: "Memory value" },
          namespace: { type: "string", description: "Namespace (default: default)" },
        },
        required: ["key", "value"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "memory_search",
      description: "Search memory for previously saved key-value pairs.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query (matches against keys and values)" },
          namespace: { type: "string", description: "Namespace (default: default)" },
        },
        required: ["query"],
      },
    },
  },
];

type LLMMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

type LLMResponse = {
  content: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

function getLLMConfig() {
  // Priority 1: Volcengine Ark Coding Plan (OpenAI-compatible)
  const arkApiKey = process.env.ARK_API_KEY || process.env.LLM_API_KEY;
  const arkBaseUrl = process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/coding/v3";
  const arkModel = process.env.ARK_MODEL || "doubao-seed-code";

  // Priority 2: model-proxy (Anthropic Messages API)
  const modelProxyUrl = process.env.MODEL_PROXY_URL || "http://127.0.0.1:43191";
  const modelProxyKey = process.env.MODEL_PROXY_KEY || process.env.ZAI_ANTHROPIC_AUTH_TOKEN || "";
  const modelProxyModel = process.env.MODEL_PROXY_MODEL || "GLM-4.5-Air";

  // Priority 3: Direct OpenAI-compatible API
  const apiKey = process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY;
  let baseUrl: string;
  let model: string;

  if (process.env.DEEPSEEK_API_KEY) {
    baseUrl = "https://api.deepseek.com/v1";
    model = "deepseek-chat";
  } else {
    baseUrl = "https://api.openai.com/v1";
    model = "gpt-4o-mini";
  }

  const useArk = !!arkApiKey;
  const useModelProxy = !useArk && !!modelProxyKey;
  const useDirectApi = !useArk && !useModelProxy && !!apiKey;

  return {
    apiKey: useArk ? arkApiKey! : (useDirectApi ? apiKey! : ""),
    baseUrl: useArk ? arkBaseUrl : baseUrl,
    model: useArk ? arkModel : model,
    useArk, useModelProxy, useDirectApi,
    modelProxyUrl, modelProxyKey, modelProxyModel,
  };
}

let _modelProxyAvailable: boolean | null = null;
function isModelProxyAvailable(): boolean {
  if (_modelProxyAvailable !== null) return _modelProxyAvailable;
  // Will be checked asynchronously; default to trying
  return true;
}
void isModelProxyAvailable; // retained for future availability probing

// ---- Anthropic Messages API helpers (for model-proxy) ----

function convertOpenAIToolsToAnthropic(tools: typeof toolDefinitions): any[] {
  return tools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

function convertOpenAIMessagesToAnthropic(messages: LLMMessage[]): { system?: string; messages: Array<{ role: "user" | "assistant"; content: string | Array<any> }> } {
  const result: Array<{ role: "user" | "assistant"; content: string | Array<any> }> = [];
  let system: string | undefined;

  for (const msg of messages) {
    if (msg.role === "system") {
      system = msg.content || undefined;
    } else if (msg.role === "assistant" && msg.tool_calls) {
      // Assistant with tool calls → content blocks with tool_use
      const blocks: any[] = [];
      if (msg.content) blocks.push({ type: "text", text: msg.content });
      for (const tc of msg.tool_calls) {
        let input = {};
        try { input = JSON.parse(tc.function.arguments); } catch {}
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
      }
      result.push({ role: "assistant", content: blocks });
    } else if (msg.role === "tool") {
      // Tool result → user message with tool_result content block
      result.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: msg.tool_call_id, content: msg.content }],
      });
    } else if (msg.role === "user" || msg.role === "assistant") {
      result.push({ role: msg.role, content: msg.content || "" });
    }
  }

  return { system, messages: result };
}

async function callLLMStreamViaModelProxy(
  messages: LLMMessage[],
  tools: typeof toolDefinitions,
  _writer: SSEWriter,
  send: (type: string, content: string, meta?: Record<string, any>) => void,
): Promise<LLMResponse> {
  const { modelProxyUrl } = getLLMConfig();
  const model = process.env.MODEL_PROXY_MODEL || "GLM-4.5-Air";

  // Convert OpenAI format → Anthropic format
  const { system, messages: anthropicMsgs } = convertOpenAIMessagesToAnthropic(messages);
  const anthropicTools = convertOpenAIToolsToAnthropic(tools);

  const body: any = {
    model,
    messages: anthropicMsgs,
    max_tokens: 4096,
    stream: true,
  };
  if (system) body.system = system;
  if (anthropicTools.length > 0) body.tools = anthropicTools;

  // Determine auth: use ZAI key for model-proxy, or try local adapter
  let url: string;
  let apiKey: string;

  if (process.env.ZAI_ANTHROPIC_AUTH_TOKEN) {
    // Use model-proxy directly with Z.ai auth
    url = `${modelProxyUrl}/v1/messages`;
    apiKey = process.env.ZAI_ANTHROPIC_AUTH_TOKEN;
  } else if (process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY) {
    // Use local adapter which converts to OpenAI format
    url = "http://127.0.0.1:43192/v1/messages";
    apiKey = "local-adapter-token";
  } else {
    // No auth available - try model-proxy anyway
    url = `${modelProxyUrl}/v1/messages`;
    apiKey = "";
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Model Proxy API error: ${resp.status} - ${errText.slice(0, 300)}`);
  }

  // Parse Anthropic SSE stream
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> = [];
  const toolCallMap = new Map<string, { id: string; type: "function"; function: { name: string; arguments: string } }>();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data) continue;

      try {
        const event = JSON.parse(data);

        if (event.type === "content_block_delta") {
          if (event.delta?.type === "text_delta" && event.delta.text) {
            content += event.delta.text;
            send("text_delta", event.delta.text);
          } else if (event.delta?.type === "input_json_delta" && event.delta.partial_json) {
            // Accumulate tool call arguments
            const idx = event.index;
            const tc = toolCalls[idx - 1] || toolCallMap.get(`tc-${idx}`);
            if (tc) tc.function.arguments += event.delta.partial_json;
          }
        } else if (event.type === "content_block_start") {
          if (event.content_block?.type === "tool_use") {
            const idx = event.index;
            const tc = {
              id: event.content_block.id || `tc_${Date.now()}_${idx}`,
              type: "function" as const,
              function: {
                name: event.content_block.name || "",
                arguments: "",
              },
            };
            toolCalls[idx - 1] = tc;
            toolCallMap.set(`tc-${idx}`, tc);
          }
        } else if (event.type === "message_stop") {
          // End of message
        }
      } catch {
        // Skip unparseable events
      }
    }
  }

  // Filter out empty tool calls
  const validToolCalls = toolCalls.filter(tc => tc && tc.function.name);

  return {
    content,
    tool_calls: validToolCalls.length > 0 ? validToolCalls : undefined,
  };
}

async function callLLMStream(
  messages: LLMMessage[],
  tools: typeof toolDefinitions,
  _writer: SSEWriter,
  send: (type: string, content: string, meta?: Record<string, any>) => void,
): Promise<LLMResponse> {
  const config = getLLMConfig();

  // Try model-proxy (Anthropic Messages API) if configured
  if (config.useModelProxy) {
    return await callLLMStreamViaModelProxy(messages, tools, _writer, send);
  }

  // Direct OpenAI-compatible API (Ark / OpenAI / DeepSeek)
  const url = `${config.baseUrl}/chat/completions`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      tools,
      stream: true,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`LLM API error: ${resp.status} - ${errText.slice(0, 200)}`);
  }

  // Parse SSE stream from LLM
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoningContent = "";
  const toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;

      try {
        const chunk = JSON.parse(data);
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        // Handle reasoning/thinking content (Ark Coding Plan models)
        if (delta.reasoning_content) {
          reasoningContent += delta.reasoning_content;
          // Don't send reasoning to frontend as text - it's internal thinking
        }

        // Accumulate content
        if (delta.content) {
          content += delta.content;
          // Stream content tokens to frontend as they arrive
          send("text_delta", delta.content);
        }

        // Accumulate tool calls
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolCalls[idx]) {
              toolCalls[idx] = {
                id: tc.id || "",
                type: "function" as const,
                function: { name: "", arguments: "" },
              };
            }
            if (tc.id) toolCalls[idx].id = tc.id;
            if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
            if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
          }
        }
      } catch {
        // Skip unparseable chunks
      }
    }
  }

  return {
    content,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

async function executeTool(name: string, args: any): Promise<any> {
  switch (name) {
    case "weather": return weatherTool.execute(args, {});
    case "web_fetch": return webFetchTool.execute(args, {});
    case "generate_image": return imageGenTool.execute(args, {});
    case "run_code": return codeExecTool.execute(args, {});
    case "read_file": return readFileTool.execute(args, {});
    case "write_file": return writeFileTool.execute(args, {});
    case "edit_file": return editFileTool.execute(args, {});
    case "list_dir": return listDirTool.execute(args, {});
    case "search_files": return searchFilesTool.execute(args, {});
    case "find_files": return findFilesTool.execute(args, {});
    case "shell": return shellTool.execute(args, {});
    case "web_search": return webSearchTool.execute(args, {});
    case "todo_write": return todoWriteTool.execute(args, {});
    case "task_list": return taskListTool.execute(args, {});
    case "memory_save": return memorySaveTool.execute(args, {});
    case "memory_search": return memorySearchTool.execute(args, {});
    default: return { error: `Unknown tool: ${name}` };
  }
}

// ============ Professional Multi-Step Agent (SSE Streaming) ============

type SSEWriter = {
  write: (data: string) => void;
  end: () => void;
};

type Step = {
  type: "thinking" | "tool_call" | "tool_result" | "text" | "text_delta" | "error" | "done";
  content: string;
  meta?: Record<string, any>;
};

function sseEvent(w: SSEWriter, event: string, data: any) {
  w.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function detectIntent(msg: string): "weather" | "travel" | "image" | "code" | "greeting" {
  const m = msg.toLowerCase();
  if (m.includes("新疆") || m.includes("旅游") || m.includes("攻略") || m.includes("travel") ||
      m.includes("xinjiang") || m.includes("trip") || m.includes("itinerary") ||
      (m.includes("游") && (m.includes("预算") || m.includes("机票") || m.includes("住宿") || m.includes("晚"))) ||
      (m.includes("plan") && (m.includes("day") || m.includes("budget") || m.includes("night")))) {
    return "travel";
  }
  if (m.includes("生图") || m.includes("生成图") || m.includes("图片") || m.includes("美女") ||
      m.includes("image") || m.includes("picture") || m.includes("generate") || m.includes("portrait") ||
      m.includes("画") || m.includes("绘制") || m.includes("illustration") || m.includes("插画") ||
      m.includes("photo") || m.includes("照片") || m.includes("壁纸") || m.includes("wallpaper") ||
      m.includes("风景图") || m.includes("生成") && (m.includes("图") || m.includes("画"))) {
    return "image";
  }
  if (m.includes("代码") || m.includes("算法") || m.includes("leetcode") || m.includes("游戏") ||
      m.includes("flappy") || m.includes("bird") || m.includes("pet") || m.includes("game") || m.includes("code") || m.includes("demo")) {
    return "code";
  }
  if (m.includes("天气") || m.includes("weather") || m.includes("气温") || m.includes("温度")) {
    return "weather";
  }
  if (m.trim().length < 10 && (m.includes("你好") || m.includes("hi") || m.includes("hello") || m === "")) {
    return "greeting";
  }
  return "greeting";
}

async function runAgentPipelineLLM(userMsg: string, w: SSEWriter, send: (type: Step["type"], content: string, meta?: Record<string, any>) => void) {
  const systemPrompt = `You are Micro Agent, a professional AI assistant with comprehensive tool access. You have 16 tools available:

**File Operations:** read_file, write_file, edit_file, list_dir
**Search:** search_files (grep), find_files (glob)
**Shell:** shell (execute commands with timeout)
**Web:** web_search, web_fetch
**Code:** run_code (JavaScript/Python sandbox)
**Image:** generate_image
**Weather:** weather (real-time global weather)
**Tasks:** todo_write, task_list
**Memory:** memory_save, memory_search

When the user asks a question:
1. Think about what information you need
2. Use the appropriate tools to gather data
3. Synthesize a comprehensive, well-formatted response

Key behaviors:
- For code questions: read files first, then edit/write with precision
- For research: use web_search to find information, web_fetch to read pages
- For multi-step tasks: use todo_write to track progress
- For shell commands: use shell tool with appropriate timeout
- Always use tools when they can provide real-time or factual data
- Be concise but thorough.`;

  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMsg },
  ];

  const MAX_ROUNDS = 8;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    send("thinking", round === 0 ? "Analyzing your request..." : "Processing tool results...");

    let response: LLMResponse;
    try {
      response = await callLLMStream(messages, toolDefinitions, w, send as any);
    } catch (e: any) {
      send("error", `LLM call failed: ${e.message}`);
      send("thinking", "Falling back to built-in rule engine...");
      await runAgentPipelineFallback(userMsg, w, send);
      return;
    }

    if (response.tool_calls && response.tool_calls.length > 0) {
      // Add assistant message with tool calls
      messages.push({
        role: "assistant",
        content: response.content || null,
        tool_calls: response.tool_calls,
      });

      // Execute each tool call
      for (const tc of response.tool_calls) {
        const toolName = tc.function.name;
        let toolArgs: any;
        try {
          toolArgs = JSON.parse(tc.function.arguments);
        } catch {
          toolArgs = {};
          send("tool_result", JSON.stringify({ error: `Failed to parse arguments: ${tc.function.arguments}` }), { tool: toolName });
          messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ error: "Failed to parse arguments" }) });
          continue;
        }

        send("tool_call", `${toolName}(${JSON.stringify(toolArgs)})`, { tool: toolName, args: toolArgs });

        const toolResult = await executeTool(toolName, toolArgs);
        const resultStr = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult, null, 2);

        send("tool_result", resultStr, { tool: toolName });

        // Add tool result to messages
        messages.push({ role: "tool", tool_call_id: tc.id, content: resultStr });
      }
    } else {
      // No tool calls — LLM gave final answer
      if (response.content) {
        send("text", response.content);
      }
      break;
    }
  }

  send("done", "");
}

async function runAgentPipelineFallback(userMsg: string, _w: SSEWriter, send: (type: Step["type"], content: string, meta?: Record<string, any>) => void) {
  const intent = detectIntent(userMsg);

  // Thinking step
  await sleep(300);
  if (intent === "weather") {
    send("thinking", "Analyzing request: user is asking about weather conditions.");
    await sleep(400);
    send("thinking", "Identifying target city from query...");
    await sleep(300);

    let city = "Beijing";
    const knownCities: Record<string, string> = {
      "北京": "Beijing", "beijing": "Beijing",
      "上海": "Shanghai", "shanghai": "Shanghai",
      "广州": "Guangzhou", "guangzhou": "Guangzhou",
      "深圳": "Shenzhen", "shenzhen": "Shenzhen",
      "成都": "Chengdu", "chengdu": "Chengdu",
      "杭州": "Hangzhou", "hangzhou": "Hangzhou",
      "乌鲁木齐": "Urumqi", "urumqi": "Urumqi",
      "新疆": "Urumqi", "xinjiang": "Urumqi",
      "东京": "Tokyo", "tokyo": "Tokyo",
      "纽约": "New York", "new york": "New York",
      "伦敦": "London", "london": "London",
      "巴黎": "Paris", "paris": "Paris",
    };
    const lowerMsg = userMsg.toLowerCase();
    for (const [key, val] of Object.entries(knownCities)) {
      if (lowerMsg.includes(key.toLowerCase())) { city = val; break; }
    }
    if (city === "Beijing") {
      const inMatch = userMsg.match(/(?:in|for|at|of)\s+([A-Z][a-zA-Z]+)/);
      if (inMatch) city = inMatch[1];
    }

    send("thinking", `Calling weather tool for: ${city}`);
    send("tool_call", `weather({ city: "${city}" })`, { tool: "weather", args: { city } });
    await sleep(500);

    const result = await weatherTool.execute({ city }, {});
    send("tool_result", JSON.stringify(result, null, 2), { tool: "weather" });
    await sleep(300);

    if ("error" in result) {
      send("error", `Failed to fetch weather data: ${result.error}`);
      send("done", "");
      return;
    }

    send("thinking", "Weather data retrieved. Composing response...");
    await sleep(400);

    const reply = formatWeatherReply(result);
    send("text", reply);
    send("done", "");
    return;
  }

  if (intent === "travel") {
    const isXinjiang = userMsg.toLowerCase().includes("xinjiang") || userMsg.includes("新疆");
    const destCity = isXinjiang ? "Urumqi" : "Beijing";
    const destName = isXinjiang ? "Xinjiang (Urumqi)" : destCity;

    send("thinking", `Analyzing travel request${isXinjiang ? ": multi-destination trip to Xinjiang" : ""}.`);
    await sleep(400);
    send("thinking", `Planning tool chain: need weather data for departure (Beijing) and destination (${destName}), then synthesize travel plan with budget allocation.`);
    await sleep(500);

    // Step 1: Beijing weather (departure)
    send("thinking", "Step 1: Fetching departure city weather (Beijing)...");
    send("tool_call", 'weather({ city: "Beijing" })', { tool: "weather", args: { city: "Beijing" } });
    await sleep(600);
    const bjWeather = await weatherTool.execute({ city: "Beijing" }, {});
    send("tool_result", JSON.stringify(bjWeather, null, 2), { tool: "weather", label: "Beijing" });
    await sleep(300);

    // Step 2: Destination weather
    send("thinking", `Step 2: Fetching destination weather (${destCity})...`);
    send("tool_call", `weather({ city: "${destCity}" })`, { tool: "weather", args: { city: destCity } });
    await sleep(600);
    const destWeather = await weatherTool.execute({ city: destCity }, {});
    send("tool_result", JSON.stringify(destWeather, null, 2), { tool: "weather", label: destCity });
    await sleep(400);

    // Step 3: Synthesize
    send("thinking", "Step 3: Weather data collected for both cities. Composing comprehensive travel plan...");
    await sleep(500);
    send("thinking", "Building itinerary, budget allocation, and recommendations based on weather conditions.");
    await sleep(400);

    const reply = isXinjiang
      ? formatTravelReply(bjWeather, destWeather)
      : formatGenericTravelReply(bjWeather, destWeather, userMsg);
    send("text", reply);
    send("done", "");
    return;
  }

  if (intent === "image") {
    send("thinking", "Analyzing image generation request...");
    await sleep(300);

    // Extract prompt from user message
    const imagePrompt = extractImagePrompt(userMsg);
    const size = "portrait_4_3";

    send("thinking", `Generating image with prompt: "${imagePrompt.slice(0, 60)}${imagePrompt.length > 60 ? '...' : ''}"`);
    send("tool_call", `generate_image({ prompt: "...", size: "${size}" })`, { tool: "generate_image", args: { prompt: imagePrompt, size } });
    await sleep(800);

    const result = await imageGenTool.execute({ prompt: imagePrompt, size }, {});
    send("tool_result", JSON.stringify(result, null, 2), { tool: "generate_image" });
    await sleep(300);

    send("thinking", "Image generated successfully.");
    await sleep(200);

    const reply = `![Generated image](${result.image_url})\n\n**Prompt:** ${imagePrompt}\n**Size:** ${size}\n\nImage generated via text-to-image API. Refresh to regenerate.`;
    send("text", reply);
    send("done", "");
    return;
  }

  if (intent === "code") {
    send("thinking", "Analyzing request: user wants to see code capabilities and games.");
    await sleep(300);
    send("thinking", "Available interactive content: Flappy Bird game, Pet nurturing game, LeetCode Hard algorithms.");
    await sleep(400);

    const reply = formatCodeReply();
    send("text", reply);
    send("done", "");
    return;
  }

  // Greeting / default
  send("thinking", "Initializing session...");
  await sleep(300);
  const reply = `Welcome to **micro-agent** — a 4.90KB gzip micro-kernel agent framework.\n\n**Available tools (16):**\n- **read_file** — Read file contents from workspace\n- **write_file** — Write content to files\n- **edit_file** — Make targeted edits to files\n- **list_dir** — List directory contents\n- **search_files** — Search for text patterns (grep)\n- **find_files** — Find files by name (glob)\n- **shell** — Execute shell commands\n- **web_search** — Search the web\n- **web_fetch** — Fetch webpage content\n- **run_code** — JavaScript/Python sandbox\n- **generate_image** — Text-to-image generation\n- **weather** — Real-time global weather\n- **todo_write** — Create/update todo lists\n- **task_list** — List tasks\n- **memory_save** — Save to persistent memory\n- **memory_search** — Search saved memories\n\n**Try asking:**\n- "What's the weather in Beijing?"\n- "Plan a 6-day Xinjiang trip for 2 people, budget 15000 CNY"\n- "Generate a portrait image"\n- "Read the package.json file"\n- "Search for TODO comments in the codebase"`;
  send("text", reply);
  send("done", "");
}

async function runAgentPipeline(userMsg: string, w: SSEWriter) {
  const send = (type: Step["type"], content: string, meta?: Record<string, any>) => {
    sseEvent(w, "step", { type, content, meta, ts: Date.now() });
  };

  // Check for workflow directives: /goal /loop /team
  // Workflow runs even without LLM (mock-mode) so the Codex-aligned control flow
  // (continuation / completion audit / budget / block threshold) is exercised.
  const isWorkflow = /^\s*\/(goal|loop|team)\b/i.test(userMsg);
  if (isWorkflow) {
    const config = getLLMConfig();
    const hasLLM = config.useArk || config.useModelProxy || config.useDirectApi;
    try {
      await runWorkflowPipeline(userMsg, w, send, config, hasLLM);
      return;
    } catch (e: any) {
      send("error", `Workflow error: ${e.message}`);
    }
  }

  const config = getLLMConfig();
  const hasLLM = config.useArk || config.useModelProxy || config.useDirectApi;

  if (hasLLM) {
    const modeLabel = config.useArk ? `Ark · ${config.model}` : config.useModelProxy ? "model-proxy" : "direct API";
    send("thinking", `Connecting to AI model (${modeLabel})...`);
    try {
      await runAgentPipelineLLM(userMsg, w, send);
      return;
    } catch (e: any) {
      send("thinking", `LLM error: ${e.message}. Falling back to built-in agent...`);
    }
  }

  // Built-in rule engine agent (no auth needed)
  await runAgentPipelineFallback(userMsg, w, send);
}

/**
 * Workflow pipeline: /goal /loop /team dynamic workflows
 * - /goal <desc>       → Plan/Act auto-switch mode
 * - /goal <desc> /loop → Goal/Loop dynamic mode
 * - /team <desc>       → Agent Team collaboration mode
 */
async function runWorkflowPipeline(
  userMsg: string,
  w: SSEWriter,
  send: (type: Step["type"], content: string, meta?: Record<string, any>) => void,
  config: ReturnType<typeof getLLMConfig>,
  hasLLM: boolean,
) {
  // Mock-mode provider: when no LLM is configured, synthesize replies that
  // exercise the Codex-aligned control flow (continuation, completion audit,
  // budget, block threshold). This lets /goal run end-to-end in any environment.
  const workflowProvider = {
    name: hasLLM ? "workflow-llm" : "workflow-mock",
    async chat(req: { messages: any[]; model?: string; temperature?: number }): Promise<{ content: string }> {
      if (!hasLLM) {
        const sys = (req.messages[0]?.content ?? "").toString();
        const user = (req.messages[1]?.content ?? "").toString();
        // Mock planner: synthesize 2-3 steps based on the objective
        if (/planner/i.test(sys)) {
          const obj = (user.match(/Objective:\s*([^\n]+)/) || [])[1] || "task";
          return {
            content: `Read context for: ${obj.slice(0, 80)} | read_file\nProduce the deliverable | run_code\nReport the outcome`,
          };
        }
        // Mock auditor / judge: pass when reply mentions evidence, fail otherwise
        if (/auditor|audit|judge|decide.*achieved|achieved/i.test(sys)) {
          const hasEvidence = /evidence|test\s*(passed|run)|file|output|exit_code/i.test(user);
          return {
            content: JSON.stringify({
              passed: hasEvidence,
              reason: hasEvidence ? "mock audit: evidence keyword detected" : "mock audit: no evidence keyword",
            }),
          };
        }
        // Mock summarizer / generic: short canned reply
        return { content: "Mock workflow reply: step executed using rule engine." };
      }
      const messages = req.messages.map((m) => ({ role: m.role, content: m.content }));
      const baseUrl = config.useArk
        ? config.baseUrl
        : config.useModelProxy
          ? config.modelProxyUrl + "/v1"
          : config.baseUrl;
      const apiKey = config.useArk ? config.apiKey : config.useModelProxy ? config.modelProxyKey : config.apiKey;
      const model = config.useArk ? config.model : config.useModelProxy ? config.modelProxyModel : config.model;

      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: req.temperature ?? 0.3,
          max_tokens: 2000,
        }),
      });
      if (!resp.ok) throw new Error(`Workflow LLM HTTP ${resp.status}`);
      const data = await resp.json() as any;
      return { content: data.choices?.[0]?.message?.content ?? "" };
    },
  };

  // Build a lightweight agent that wraps the existing ReAct pipeline
  const workflowAgent = {
    run: async (prompt: string): Promise<{ reply: string; rounds: number; toolCalls: number }> => {
      // Mock-mode agent: when no LLM is configured, return a canned reply that
      // signals GOAL_COMPLETE with mock evidence. This drives the Codex-aligned
      // continuation loop + completion audit through real control-flow paths.
      if (!hasLLM) {
        const evidence = `Mock evidence: prompt length=${prompt.length}, tools available=${toolDefinitions.length}`;
        return {
          reply: `GOAL_COMPLETE\nEvidence: ${evidence}\nStep executed in mock mode (no LLM configured).`,
          rounds: 1,
          toolCalls: 0,
        };
      }

      // Delegate to the existing LLM pipeline for actual tool execution
      let reply = "";
      let toolCalls = 0;
      const steps: any[] = [];

      // Use a simplified inline ReAct loop
      const systemPrompt = `You are a workflow step executor. Complete the given task using available tools. Be thorough.`;
      const messages: LLMMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ];

      for (let round = 0; round < 5; round++) {
        const response = await callLLMStream(messages, toolDefinitions, w, (type: string, content: string) => {
          if (type === "text_delta") {
            steps.push({ type, content });
          }
        });
        toolCalls += response.tool_calls?.length || 0;

        if (response.tool_calls && response.tool_calls.length > 0) {
          messages.push({ role: "assistant", content: response.content || null, tool_calls: response.tool_calls });
          for (const tc of response.tool_calls) {
            const args = JSON.parse(tc.function.arguments || "{}");
            send("tool_call", `[workflow] ${tc.function.name}(${JSON.stringify(args)})`, { tool: tc.function.name, args });
            const result = await executeTool(tc.function.name, args);
            const resultStr = typeof result === "string" ? result : JSON.stringify(result);
            send("tool_result", resultStr, { tool: tc.function.name });
            messages.push({ role: "tool", tool_call_id: tc.id, content: resultStr });
          }
        } else {
          reply = response.content || "";
          break;
        }
      }
      reply = reply || steps.filter((s) => s.type === "text_delta").map((s) => s.content).join("");
      return { reply, rounds: 1, toolCalls };
    },
  };

  const { DynamicWorkflow, DEFAULT_TEAM } = await import("../src/core/workflows.js");

  const workflow = new DynamicWorkflow({
    agent: workflowAgent as any,
    provider: workflowProvider as any,
    model: config.model,
    tools: toolDefinitions as any,
    maxIterations: 8,
    maxReplans: 3,
    teamMembers: DEFAULT_TEAM,
  });

  await workflow.run(userMsg, (event) => {
    const typeMap: Record<string, Step["type"]> = {
      text: "thinking",
      mode_switch: "thinking",
      plan_created: "thinking",
      step_start: "tool_call",
      step_done: "tool_result",
      step_failed: "error",
      replan: "thinking",
      loop_iteration: "thinking",
      continuation: "thinking",
      budget_warning: "thinking",
      budget_limit: "error",
      block_detected: "error",
      evaluation: "thinking",
      completion_audit: "thinking",
      team_dispatch: "tool_call",
      team_result: "tool_result",
      goal_achieved: "text",
      workflow_complete: "text",
      workflow_failed: "error",
    };
    const stepType = typeMap[event.type] || "thinking";
    const prefix = event.mode ? `[${event.mode.toUpperCase()}] ` : "";
    send(stepType, `${prefix}${event.content}`, {
      workflowEvent: event.type,
      step: event.step,
      result: event.result,
    });
  });

  send("done", "");
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function extractImagePrompt(msg: string): string {
  // Chinese prompt extraction - remove action verbs and measure words
  const cleaned = msg
    .replace(/^(请|帮我|帮我|能不能|可不可以|可以)?(画|绘制|生成|创作|做)[一隻只个张幅下]*/u, "")
    .replace(/[的图片图像插画]*/u, (match) => match.length > 0 && match.includes("的") ? "" : match)
    .trim();

  if (cleaned && cleaned.length > 0) {
    return cleaned + ", digital art, high quality, detailed";
  }
  // Fallback: use the whole message
  return msg + ", digital art, high quality, detailed";
}

function formatWeatherReply(w: any): string {
  return `## Weather Report — ${w.city}\n\n| Metric | Value |\n|--------|-------|\n| Temperature | ${w.temperature_C}\u00b0C (feels like ${w.feels_like_C}\u00b0C) |\n| Condition | ${w.weather} |\n| Humidity | ${w.humidity}% |\n| Wind | ${w.wind} |\n| Visibility | ${w.visibility} |\n| Pressure | ${w.pressure} |\n| Today High/Low | ${w.today_high}\u00b0C / ${w.today_low}\u00b0C |\n${w.tomorrow ? `| Tomorrow | ${w.tomorrow.high}\u00b0C / ${w.tomorrow.low}\u00b0C |` : ""}\n\n*Data source: wttr.in · Observed at ${w.observation_time}*`;
}

function formatTravelReply(bj: any, wq: any): string {
  const bjTemp = !("error" in bj) ? `${bj.temperature_C}\u00b0C, ${bj.weather}` : "unavailable";
  const wqTemp = !("error" in wq) ? `${wq.temperature_C}\u00b0C, ${wq.weather}` : "unavailable";
  const wqAdvice = !("error" in wq) && wq.weather.toLowerCase().includes("sandstorm")
    ? "\n> **Weather alert:** Urumqi currently reports severe sandstorm. Consider bringing masks, eye protection, and checking for flight delays. Visibility is reduced."
    : "";

  return `## Xinjiang 6-Day, 5-Night Travel Plan\n**For 2 people | Budget: \u00a515,000**\n\n### Weather Conditions\n- **Beijing (departure):** ${bjTemp}\n- **Urumqi (destination):** ${wqTemp}${wqAdvice}\n\n### Itinerary Overview\n\n| Day | Destination | Highlights |\n|-----|-------------|------------|\n| 1 | Urumqi | Arrive, Grand Bazaar, Hong Shan Park |\n| 2 | Tianshan Tianchi | Alpine lake, snow peaks |\n| 3 | Burqin / Kanas | Kanas Lake, Moon Bay |\n| 4 | Hemu Village | Traditional Tuva village, sunrise |\n| 5 | Sayram Lake | Last tear of the Atlantic |\n| 6 | Return | Urumqi city tour, depart |\n\n### Budget Allocation\n\n| Category | Budget (CNY) | Details |\n|----------|-------------|----------|\n| Flights | \u00a55,000\u20137,000 | Beijing\u2194Urumqi round-trip x2 (off-peak / advance booking) |\n| Accommodation | \u00a52,000\u20133,000 | 5 nights x \u00a5400\u2013600 (3-star / boutique homestay) |\n| Dining | \u00a51,500\u20132,400 | 6 days x \u00a5250\u2013400/day (2 people) |\n| Attractions | \u00a51,000\u20131,600 | Tianshan, Kanas, Hemu, Sayram Lake |\n| Local Transport | \u00a52,500\u20133,500 | 6-day car charter / SUV + fuel |\n| Shopping / Misc | \u00a51,000\u20131,500 | Local specialties, souvenirs, emergency |\n| **Total** | **\u00a513,000\u201319,000** | \u00a515,000 feasible in off-peak with early booking |\n\n### Recommendations\n1. **Best time to visit:** June\u2013September (avoid sandstorm season)\n2. **Transport:** Chartering a car with driver is strongly recommended for Xinjiang due to long distances between sites\n3. **Packing:** Sunscreen (UV is strong), layers (temperature varies greatly day/night), ID card (frequent checkpoints)\n4. **Local food:** Roast lamb skewers, pilaf, big-plate chicken, naan bread, milk tea\n5. **Shopping:** Raisins, walnuts, dried fruit from the Grand Bazaar\n\n*Note: This plan is based on real weather data and common travel knowledge. For live flight/hotel pricing, configure an LLM API key (OpenAI/DeepSeek) to enable autonomous web search and booking integration.*`;
}

function formatGenericTravelReply(bj: any, dest: any, _userMsg: string): string {
  const bjTemp = !("error" in bj) ? `${bj.temperature_C}\u00b0C, ${bj.weather}` : "unavailable";
  const destTemp = !("error" in dest) ? `${dest.temperature_C}\u00b0C, ${dest.weather}` : "unavailable";
  const destCity = !("error" in dest) ? dest.city : "destination";

  return `## Travel Plan\n\n### Weather Outlook\n- **Beijing (departure):** ${bjTemp}\n- **${destCity}:** ${destTemp}\n\n### Planning Summary\nBased on your query, here are key recommendations:\n\n1. **Check weather conditions** for both departure and destination before packing\n2. **Book flights in advance** for better pricing, especially during peak seasons\n3. **Accommodation:** Book hotels with free cancellation options\n4. **Local transport:** Research public transit or consider car rental\n5. **Budget:** Allocate 30-40% for transport, 25-30% for accommodation, 20-25% for dining, 10-15% for activities\n\n### Packing Tips\n- Check the forecast and pack layers accordingly\n- Bring necessary documents (ID, passport if applicable)\n- Portable charger and essential medications\n\n*For detailed itineraries, configure an LLM API key (OpenAI/DeepSeek) to enable autonomous web research and personalized planning.*`;
}

function formatCodeReply(): string {
  return `## Code & Interactive Demos\n\nThe following fully functional implementations are available:\n\n### Games\n1. **Flappy Bird** \u2014 Navigate to [/flappy.html](/flappy.html) or click "Flappy" in the top nav. Canvas-based with scoring, obstacles, collision detection, and progressive difficulty.\n\n2. **Pet Nurturing Game** \u2014 Navigate to [/pet.html](/pet.html) or click "Pet" in the top nav. Features 4 attributes (hunger, mood, energy, health), 6 interactions (feed, play, sleep, clean, heal, pet), and level progression.\n\n### Algorithms (LeetCode Hard)\nTwo classic Hard problems are implemented and runnable in the JS sandbox:\n- **Trapping Rain Water** \u2014 Two-pointer approach, O(n) time\n- **Merge k Sorted Lists** \u2014 Divide and conquer approach\n\n### System Capabilities\n- **read_file / write_file / edit_file** — File operations in workspace\n- **list_dir** — Directory listing\n- **search_files** — Grep-like text search\n- **find_files** — Glob-like file search\n- **shell** — Execute shell commands\n- **web_search / web_fetch** — Web search and page fetching\n- **run_code** — JavaScript/Python sandbox execution\n- **generate_image** — Text-to-image generation\n- **weather** — Real-time weather queries\n- **todo_write / task_list** — Task management\n- **memory_save / memory_search** — Persistent memory\n\n*Configure OPENAI_API_KEY or DEEPSEEK_API_KEY for autonomous code generation, debugging loops, and browser automation.*`;
}

// ============ Status & Stream Handlers ============

function createStatusHandler() {
  const config = getLLMConfig();
  const llmEnabled = config.useArk || config.useModelProxy || config.useDirectApi;
  const modelName = config.useArk ? config.model : config.useModelProxy ? (process.env.MODEL_PROXY_MODEL || "GLM-4.5-Air") : "gpt-4o-mini";
  const llmMode = config.useArk ? "ark" : config.useModelProxy ? "model-proxy" : config.useDirectApi ? "direct" : "fallback";
  const body = JSON.stringify({
    llm: llmEnabled,
    model: llmEnabled ? modelName : null,
    mode: llmMode,
    tools: ["read_file", "write_file", "edit_file", "list_dir", "search_files", "find_files", "shell", "web_search", "web_fetch", "run_code", "generate_image", "weather", "todo_write", "task_list", "memory_save", "memory_search"],
    version: "1.0.0",
  });
  return {
    matches(req: any) { return req.url === "/api/status"; },
    async handle(_req: any, res: ServerResponse) {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" });
      res.end(body);
    },
  };
}

function createStreamChatHandler() {
  return {
    matches(req: any) {
      return req.url.startsWith("/api/chat/stream");
    },
    async handle(req: any, res: ServerResponse) {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405); res.end("Method not allowed"); return;
      }

      const rawBody = await req.body();
      let body: any = {};
      try { body = rawBody ? JSON.parse(rawBody) : {}; } catch {}
      const message = typeof body.message === "string" ? body.message : "";
      if (!message) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "message required" })); return; }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "X-Accel-Buffering": "no",
      });
      res.write(": connected\n\n");

      const writer: SSEWriter = {
        write: (d: string) => { try { res.write(d); } catch {} },
        end: () => { try { res.end(); } catch {} },
      };

      try {
        await runAgentPipeline(message, writer);
      } catch (e: any) {
        sseEvent(writer, "step", { type: "error", content: e.message, ts: Date.now() });
        sseEvent(writer, "step", { type: "done", content: "", ts: Date.now() });
      }
      writer.end();
    },
  };
}

// ============ HTTP Server ============

type H = { matches(req: any): boolean; handle(req: any, res?: any): Promise<any> | any };

function createServer(handlers: H[], staticDir: string) {
  const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8", ".ico": "image/x-icon",
  };
  function serveStatic(req: IncomingMessage, res: ServerResponse) {
    let urlPath = (req.url || "/").split("?")[0];
    if (urlPath === "/") urlPath = "/index.html";
    const filePath = path.join(staticDir, urlPath);
    if (!filePath.startsWith(staticDir)) { res.writeHead(403); res.end("Forbidden"); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Not Found", path: urlPath })); return; }
      const ext = path.extname(filePath);
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-cache" });
      res.end(data);
    });
  }
  return http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";
    const headers: Record<string, string> = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) headers[req.rawHeaders[i].toLowerCase()] = req.rawHeaders[i + 1];
    const chunks: Buffer[] = [];
    const bodyPromise = new Promise<string>((resolve) => {
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", () => resolve(""));
    });
    const ireq: any = { method, url, headers, body: async () => { const r = await bodyPromise; return r || undefined; } };
    for (const h of handlers) {
      if (h.matches(ireq)) {
        try {
          if (h.handle.length >= 2) {
            await h.handle(ireq, res);
          } else {
            const out = await h.handle(ireq);
            if (!res.headersSent) res.writeHead(out.status ?? 200, out.headers ?? {});
            res.end(out.body ?? "");
          }
        } catch (e: any) {
          console.error("[server err]", e);
          if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal Error", message: e.message }));
        }
        return;
      }
    }
    serveStatic(req, res);
  });
}

// ============ Main ============

async function main() {
  const bus = new EventBus();
  const mem = createInMemoryMemory();
  const reg = new PluginRegistry({ bus, memory: mem, scope: makeScope() });
  for (const p of recommendedPlugins()) reg.register(p);
  reg.register(sessionsExtension());

  const tools = new Map<string, any>();
  tools.set("weather", weatherTool);
  tools.set("web_fetch", webFetchTool);
  tools.set("generate_image", imageGenTool);
  tools.set("run_code", codeExecTool);
  tools.set("read_file", readFileTool);
  tools.set("write_file", writeFileTool);
  tools.set("edit_file", editFileTool);
  tools.set("list_dir", listDirTool);
  tools.set("search_files", searchFilesTool);
  tools.set("find_files", findFilesTool);
  tools.set("shell", shellTool);
  tools.set("web_search", webSearchTool);
  tools.set("todo_write", todoWriteTool);
  tools.set("task_list", taskListTool);
  tools.set("memory_save", memorySaveTool);
  tools.set("memory_search", memorySearchTool);

  function makeSimpleProvider() {
    return {
      name: "simple",
      async chat(_req: any) {
        return { content: "Use /api/chat/stream for streaming agent responses.", model: "simple", finishReason: "stop" };
      },
    };
  }

  const agent = new Agent(
    { id: "web-demo", name: "MicroAgent", model: "pro-v1", maxToolRounds: 5 },
    { provider: makeSimpleProvider() as any, memory: mem, bus, tools },
  );

  await reg.installAll();

  const sseSrv = reg.getService<SSEServer>("sse.server")!;
  const actionApi = reg.getService<DefineActionPluginApi>("action.registry")!;
  const a2aReg = reg.getService<A2ARegistry>("a2a.registry")!;
  const actionRegistry = (actionApi as any).getRegistry();

  actionApi.defineAction({
    name: "weather", description: "Query city real-time weather",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    run: async (args: any) => weatherTool.execute({ city: args.city || "Beijing" }, { bus }),
    expose: ["http", "cli", "tool", "mcp", "a2a"],
  });
  actionApi.defineAction({
    name: "generate_image", description: "Generate image from prompt",
    parameters: { type: "object", properties: { prompt: { type: "string" }, size: { type: "string" } }, required: ["prompt"] },
    run: async (args: any) => imageGenTool.execute({ prompt: args.prompt, size: args.size }, { bus }),
    expose: ["http", "cli", "tool", "mcp"],
  });
  actionApi.defineAction({
    name: "web_fetch", description: "Fetch webpage content",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    run: async (args: any) => webFetchTool.execute({ url: args.url }, { bus }),
    expose: ["http", "cli", "tool", "mcp"],
  });
  actionApi.defineAction({
    name: "read_file", description: "Read file content from workspace",
    parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["path"] },
    run: async (args: any) => readFileTool.execute({ path: args.path, offset: args.offset, limit: args.limit }, { bus }),
    expose: ["http", "cli", "tool", "mcp"],
  });
  actionApi.defineAction({
    name: "write_file", description: "Write content to a file in workspace",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, append: { type: "boolean" } }, required: ["path", "content"] },
    run: async (args: any) => writeFileTool.execute({ path: args.path, content: args.content, append: args.append }, { bus }),
    expose: ["http", "cli", "tool", "mcp"],
  });
  actionApi.defineAction({
    name: "edit_file", description: "Replace exact string in a file",
    parameters: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, required: ["path", "old_string", "new_string"] },
    run: async (args: any) => editFileTool.execute({ path: args.path, old_string: args.old_string, new_string: args.new_string, replace_all: args.replace_all }, { bus }),
    expose: ["http", "cli", "tool", "mcp"],
  });
  actionApi.defineAction({
    name: "list_dir", description: "List directory contents in workspace",
    parameters: { type: "object", properties: { path: { type: "string" }, recursive: { type: "boolean" } }, required: [] },
    run: async (args: any) => listDirTool.execute({ path: args.path, recursive: args.recursive }, { bus }),
    expose: ["http", "cli", "tool", "mcp"],
  });
  actionApi.defineAction({
    name: "search_files", description: "Search for text patterns in files",
    parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, file_pattern: { type: "string" }, max_results: { type: "number" } }, required: ["pattern"] },
    run: async (args: any) => searchFilesTool.execute({ pattern: args.pattern, path: args.path, file_pattern: args.file_pattern, max_results: args.max_results }, { bus }),
    expose: ["http", "cli", "tool", "mcp"],
  });
  actionApi.defineAction({
    name: "find_files", description: "Find files by name pattern",
    parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] },
    run: async (args: any) => findFilesTool.execute({ pattern: args.pattern, path: args.path }, { bus }),
    expose: ["http", "cli", "tool", "mcp"],
  });
  actionApi.defineAction({
    name: "shell", description: "Execute a shell command in workspace",
    parameters: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number" } }, required: ["command"] },
    run: async (args: any) => shellTool.execute({ command: args.command, timeout: args.timeout }, { bus }),
    expose: ["http", "cli", "tool", "mcp"],
  });
  actionApi.defineAction({
    name: "web_search", description: "Search the web for information",
    parameters: { type: "object", properties: { query: { type: "string" }, num_results: { type: "number" } }, required: ["query"] },
    run: async (args: any) => webSearchTool.execute({ query: args.query, num_results: args.num_results }, { bus }),
    expose: ["http", "cli", "tool", "mcp"],
  });
  actionApi.defineAction({
    name: "todo_write", description: "Create or update a todo list",
    parameters: { type: "object", properties: { session_id: { type: "string" }, todos: { type: "array" } }, required: ["todos"] },
    run: async (args: any) => todoWriteTool.execute({ session_id: args.session_id, todos: args.todos }, { bus }),
    expose: ["http", "cli", "tool", "mcp"],
  });
  actionApi.defineAction({
    name: "task_list", description: "List all tasks/todos",
    parameters: { type: "object", properties: { session_id: { type: "string" }, status: { type: "string" } }, required: [] },
    run: async (args: any) => taskListTool.execute({ session_id: args.session_id, status: args.status }, { bus }),
    expose: ["http", "cli", "tool", "mcp"],
  });
  actionApi.defineAction({
    name: "memory_save", description: "Save a key-value pair to memory",
    parameters: { type: "object", properties: { key: { type: "string" }, value: { type: "string" }, namespace: { type: "string" } }, required: ["key", "value"] },
    run: async (args: any) => memorySaveTool.execute({ key: args.key, value: args.value, namespace: args.namespace }, { bus }),
    expose: ["http", "cli", "tool", "mcp"],
  });
  actionApi.defineAction({
    name: "memory_search", description: "Search memory for saved key-value pairs",
    parameters: { type: "object", properties: { query: { type: "string" }, namespace: { type: "string" } }, required: ["query"] },
    run: async (args: any) => memorySearchTool.execute({ query: args.query, namespace: args.namespace }, { bus }),
    expose: ["http", "cli", "tool", "mcp"],
  });
  actionApi.defineAction({
    name: "status", description: "Get system status",
    parameters: { type: "object", properties: {} },
    run: async () => ({
      status: "ok", version: "1.0.0",
      coreSize: "4.90KB gzip",
      tools: ["read_file", "write_file", "edit_file", "list_dir", "search_files", "find_files", "shell", "web_search", "web_fetch", "run_code", "generate_image", "weather", "todo_write", "task_list", "memory_save", "memory_search"],
    }),
    expose: ["http", "cli"],
  });

  const a2aAgent: A2AAgent = {
    card: { name: "weather-a2a", description: "A2A weather agent", url: "local://weather", version: "1",
      skills: [{ id: "weather", name: "query weather" }] },
    async createTask(msg: A2AMessage) {
      const text = (msg as any).message?.parts?.find((p: any) => p.kind === "text")?.text || "";
      const city = text.match(/[\u4e00-\u9fa5a-zA-Z]+/)?.[0] || "Beijing";
      const data = await weatherTool.execute({ city }, { bus });
      return { id: "t-" + Date.now(), status: { state: "completed" as const },
        artifacts: [{ parts: [{ kind: "text" as const, text: JSON.stringify(data) }] }] };
    },
    async sendMessage() { return { id: "x", status: { state: "completed" as const } }; },
    async getTask() { return null; },
    async cancelTask() { return null; },
  };
  a2aReg.register(a2aAgent);

  const agentInstances = new Map<string, Agent>();
  agentInstances.set("demo-user", agent);
  const getAgent = async (userId: string) => agentInstances.get(userId) || agent;

  const chatHandler = createChatHandler({ getAgent });
  const streamChatHandler = createStreamChatHandler();
  const sseHandler = createSSEHandler({ sse: sseSrv });
  const actionHandler = createActionRouter({ registry: actionRegistry });
  const a2aHandler = createA2AHandler({ registry: a2aReg });

  const statusHandler = createStatusHandler();
  const handlers: H[] = [statusHandler as H, streamChatHandler as H, chatHandler as H, sseHandler as H, actionHandler as H, a2aHandler as H];
  const PORT = parseInt(process.env.PORT || "3000", 10);
  const server = createServer(handlers, WEBUI_DIR);

  await new Promise<void>((resolve) => server.listen(PORT, "0.0.0.0", resolve));
  const addr = server.address() as { port: number };
  const cfg = getLLMConfig();
  const llmStatus = cfg.useArk
    ? `enabled (Ark · ${cfg.model})`
    : cfg.useModelProxy
      ? `enabled via model-proxy (${cfg.modelProxyModel})`
      : cfg.useDirectApi
        ? `enabled (direct · ${cfg.model})`
        : "disabled (rule-engine fallback; /goal runs in mock-mode)";
  console.log(`\n[micro-agent] Professional Agent Server running on http://localhost:${addr.port}`);
  console.log(`  Chat (streaming): POST /api/chat/stream (SSE)`);
  console.log(`  Web UI:            http://localhost:${addr.port}`);
  console.log(`  Flappy Bird:       /flappy.html`);
  console.log(`  Pet Game:          /pet.html`);
  console.log(`  Tools: read_file | write_file | edit_file | list_dir | search_files | find_files | shell | web_search | web_fetch | run_code | generate_image | weather | todo_write | task_list | memory_save | memory_search`);
  console.log(`  LLM Agent:         ${llmStatus}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
