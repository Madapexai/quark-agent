#!/usr/bin/env node
/**
 * Micro Agent E2E Browser Test
 * 
 * Opens the web UI in Chromium, tests each tool via the chat interface,
 * takes screenshots as evidence, and generates a test report.
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = "http://localhost:3456";
const SCREENSHOT_DIR = "/workspace/micro-agent/e2e/screenshots";
const CHROME_PATH = "/usr/bin/google-chrome-stable";

// Ensure screenshot directory
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// ============ Helpers ============
function screenshotPath(name) {
  return path.join(SCREENSHOT_DIR, `${name}.png`);
}

async function waitForResponse(page, timeoutMs = 90000) {
  // Wait for the agent to finish by polling the send button state and content
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await page.evaluate(() => {
      const sendBtn = document.querySelector('#sendBtn');
      const doneSteps = document.querySelectorAll('.tool-call-card.done, .tool-call-card.error');
      const answerEl = document.querySelector('.final-answer');
      const hasContent = answerEl && answerEl.textContent.trim().length > 0;
      return {
        btnDisabled: sendBtn ? sendBtn.disabled : true,
        hasDoneSteps: doneSteps.length > 0,
        hasAnswer: hasContent,
      };
    });
    if (!result.btnDisabled && (result.hasDoneSteps || result.hasAnswer)) {
      break;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  // Extra wait for final rendering
  await new Promise(r => setTimeout(r, 2000));
}

async function sendMessage(page, text) {
  const input = await page.$('#input');
  await input.click();
  await input.type(text, { delay: 10 });
  await page.keyboard.press('Enter');
  // Wait for input to clear
  await new Promise(r => setTimeout(r, 500));
}

async function newChat(page) {
  const btn = await page.$('.btn-new-chat');
  if (btn) await btn.click();
  await new Promise(r => setTimeout(r, 500));
}

// ============ Test Definitions ============
const testCases = [
  {
    name: "01-homepage",
    description: "Homepage loads correctly with status indicator",
    action: async (page) => {
      // Just wait for page to load, screenshot will be taken
      await new Promise(r => setTimeout(r, 3000));
    },
    validate: async (page) => {
      const statusText = await page.$eval('#statusText', el => el.textContent);
      const hasWelcome = await page.$('.welcome-title');
      return {
        pass: !!hasWelcome && statusText.length > 0,
        detail: `status="${statusText}"`,
      };
    },
  },
  {
    name: "02-weather",
    description: "Weather tool: query Beijing weather",
    action: async (page) => {
      await sendMessage(page, "查询北京现在的天气");
      await waitForResponse(page);
    },
    validate: async (page) => {
      const toolCards = await page.$$('.tool-call-card');
      const toolNames = [];
      for (const card of toolCards) {
        const name = await card.$eval('.tool-call-name', el => el.textContent);
        toolNames.push(name);
      }
      const answer = await page.$eval('.final-answer', el => el.textContent);
      return {
        pass: toolNames.includes('weather') && answer.length > 10,
        detail: `tools=[${toolNames}], answer_len=${answer.length}`,
      };
    },
  },
  {
    name: "03-read-file",
    description: "read_file tool: read package.json",
    action: async (page) => {
      await newChat(page);
      await sendMessage(page, "读取工作区中的 micro-agent/package.json 文件，告诉我项目名称和版本");
      await waitForResponse(page);
    },
    validate: async (page) => {
      const toolCards = await page.$$('.tool-call-card');
      const toolNames = [];
      for (const card of toolCards) {
        const name = await card.$eval('.tool-call-name', el => el.textContent);
        toolNames.push(name);
      }
      return {
        pass: toolNames.includes('read_file'),
        detail: `tools=[${toolNames}]`,
      };
    },
  },
  {
    name: "04-write-file",
    description: "write_file tool: create a test file",
    action: async (page) => {
      await newChat(page);
      await sendMessage(page, "在工作区创建文件 /tmp/e2e-test.txt，内容为 'E2E Test File - Micro Agent'");
      await waitForResponse(page);
    },
    validate: async (page) => {
      const toolCards = await page.$$('.tool-call-card');
      const toolNames = [];
      for (const card of toolCards) {
        const name = await card.$eval('.tool-call-name', el => el.textContent);
        toolNames.push(name);
      }
      return {
        pass: toolNames.includes('write_file'),
        detail: `tools=[${toolNames}]`,
      };
    },
  },
  {
    name: "05-list-dir",
    description: "list_dir tool: list workspace root",
    action: async (page) => {
      await newChat(page);
      await sendMessage(page, "列出工作区根目录的文件和文件夹");
      await waitForResponse(page);
    },
    validate: async (page) => {
      const toolCards = await page.$$('.tool-call-card');
      const toolNames = [];
      for (const card of toolCards) {
        const name = await card.$eval('.tool-call-name', el => el.textContent);
        toolNames.push(name);
      }
      return {
        pass: toolNames.includes('list_dir'),
        detail: `tools=[${toolNames}]`,
      };
    },
  },
  {
    name: "06-shell",
    description: "shell tool: execute echo command",
    action: async (page) => {
      await newChat(page);
      await sendMessage(page, "执行 shell 命令: echo 'Hello from Micro Agent Shell' && date");
      await waitForResponse(page);
    },
    validate: async (page) => {
      const toolCards = await page.$$('.tool-call-card');
      const toolNames = [];
      for (const card of toolCards) {
        const name = await card.$eval('.tool-call-name', el => el.textContent);
        toolNames.push(name);
      }
      return {
        pass: toolNames.includes('shell'),
        detail: `tools=[${toolNames}]`,
      };
    },
  },
  {
    name: "07-run-code",
    description: "run_code tool: execute JavaScript",
    action: async (page) => {
      await newChat(page);
      await sendMessage(page, "用 run_code 执行 JavaScript 代码：计算斐波那契前10项并输出");
      await waitForResponse(page);
    },
    validate: async (page) => {
      const toolCards = await page.$$('.tool-call-card');
      const toolNames = [];
      for (const card of toolCards) {
        const name = await card.$eval('.tool-call-name', el => el.textContent);
        toolNames.push(name);
      }
      return {
        pass: toolNames.includes('run_code'),
        detail: `tools=[${toolNames}]`,
      };
    },
  },
  {
    name: "08-generate-image",
    description: "generate_image tool: create a sunset image",
    action: async (page) => {
      await newChat(page);
      await sendMessage(page, "生成一张日落风景图片");
      await waitForResponse(page);
    },
    validate: async (page) => {
      const toolCards = await page.$$('.tool-call-card');
      const toolNames = [];
      for (const card of toolCards) {
        const name = await card.$eval('.tool-call-name', el => el.textContent);
        toolNames.push(name);
      }
      return {
        pass: toolNames.includes('generate_image'),
        detail: `tools=[${toolNames}]`,
      };
    },
  },
  {
    name: "09-search-files",
    description: "search_files tool: grep for micro-agent",
    action: async (page) => {
      await newChat(page);
      await sendMessage(page, "搜索工作区中包含 'micro-agent' 关键词的文件");
      await waitForResponse(page);
    },
    validate: async (page) => {
      const toolCards = await page.$$('.tool-call-card');
      const toolNames = [];
      for (const card of toolCards) {
        const name = await card.$eval('.tool-call-name', el => el.textContent);
        toolNames.push(name);
      }
      return {
        pass: toolNames.includes('search_files') || toolNames.includes('find_files'),
        detail: `tools=[${toolNames}]`,
      };
    },
  },
  {
    name: "10-todo-memory",
    description: "todo_write + memory_save tools",
    action: async (page) => {
      await newChat(page);
      await sendMessage(page, "创建3个待办任务：1)设计架构 2)编码 3)测试，然后保存一条记忆 key='test', value='e2e test passed'");
      await waitForResponse(page);
    },
    validate: async (page) => {
      const toolCards = await page.$$('.tool-call-card');
      const toolNames = [];
      for (const card of toolCards) {
        const name = await card.$eval('.tool-call-name', el => el.textContent);
        toolNames.push(name);
      }
      const hasTodo = toolNames.includes('todo_write');
      const hasMemory = toolNames.includes('memory_save');
      return {
        pass: hasTodo || hasMemory,
        detail: `tools=[${toolNames}], todo=${hasTodo}, memory=${hasMemory}`,
      };
    },
  },
  {
    name: "11-web-fetch",
    description: "web_fetch tool: fetch httpbin.org",
    action: async (page) => {
      await newChat(page);
      await sendMessage(page, "抓取网页 https://httpbin.org/get 的内容");
      await waitForResponse(page);
    },
    validate: async (page) => {
      const toolCards = await page.$$('.tool-call-card');
      const toolNames = [];
      for (const card of toolCards) {
        const name = await card.$eval('.tool-call-name', el => el.textContent);
        toolNames.push(name);
      }
      return {
        pass: toolNames.includes('web_fetch'),
        detail: `tools=[${toolNames}]`,
      };
    },
  },
  {
    name: "12-edit-file",
    description: "edit_file tool: modify the test file",
    action: async (page) => {
      await newChat(page);
      await sendMessage(page, "编辑文件 /tmp/e2e-test.txt，把 'E2E Test File' 改成 'E2E Test File - Updated'");
      await waitForResponse(page);
    },
    validate: async (page) => {
      const toolCards = await page.$$('.tool-call-card');
      const toolNames = [];
      for (const card of toolCards) {
        const name = await card.$eval('.tool-call-name', el => el.textContent);
        toolNames.push(name);
      }
      return {
        pass: toolNames.includes('edit_file') || toolNames.includes('write_file'),
        detail: `tools=[${toolNames}]`,
      };
    },
  },
];

// ============ Main ============
async function main() {
  console.log("=".repeat(70));
  console.log("  Micro Agent E2E Browser Test");
  console.log("  Testing all tools via Chromium + Web UI");
  console.log("=".repeat(70));

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1280,900",
    ],
    defaultViewport: { width: 1280, height: 900 },
  });

  const page = await browser.newPage();
  
  // Collect console errors
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  console.log(`\nOpening ${BASE_URL} ...`);
  await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));

  let passed = 0;
  let failed = 0;
  const results = [];

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    const num = String(i + 1).padStart(2, "0");
    process.stdout.write(`[${num}/${testCases.length}] ${tc.name}: ${tc.description} ... `);

    try {
      await tc.action(page);
      
      // Take screenshot
      const ssPath = screenshotPath(tc.name);
      await page.screenshot({ path: ssPath, fullPage: false });
      
      // Validate
      const result = await tc.validate(page);
      if (result.pass) {
        console.log(`PASS (${result.detail})`);
        results.push({ name: tc.name, status: "PASS", detail: result.detail, screenshot: ssPath });
        passed++;
      } else {
        console.log(`FAIL (${result.detail})`);
        results.push({ name: tc.name, status: "FAIL", detail: result.detail, screenshot: ssPath });
        failed++;
      }
    } catch (e) {
      // Take screenshot on error too
      const ssPath = screenshotPath(tc.name + "-error");
      try { await page.screenshot({ path: ssPath, fullPage: false }); } catch {}
      console.log(`ERROR (${e.message.slice(0, 100)})`);
      results.push({ name: tc.name, status: "ERROR", detail: e.message.slice(0, 200), screenshot: ssPath });
      failed++;
    }
  }

  await browser.close();

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("  Test Summary");
  console.log("=".repeat(70));
  console.log(`  Total:   ${testCases.length}`);
  console.log(`  Passed:  ${passed}`);
  console.log(`  Failed:  ${failed}`);
  console.log("=".repeat(70));

  if (failed > 0) {
    console.log("\n  Failed tests:");
    for (const r of results.filter(r => r.status !== "PASS")) {
      console.log(`    - ${r.name}: ${r.detail}`);
    }
  }

  // Generate HTML report
  const reportHtml = generateReport(results, passed, failed);
  const reportPath = path.join(SCREENSHOT_DIR, "report.html");
  fs.writeFileSync(reportPath, reportHtml);
  console.log(`\n  Report: ${reportPath}`);
  console.log(`  Screenshots: ${SCREENSHOT_DIR}/`);
  console.log(`\n  Result: ${failed === 0 ? "ALL PASSED" : "SOME FAILED"}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

function generateReport(results, passed, failed) {
  const rows = results.map(r => {
    const statusColor = r.status === "PASS" ? "#16a34a" : r.status === "FAIL" ? "#dc2626" : "#ea580c";
    const relScreenshot = path.basename(r.screenshot || "");
    return `<tr>
      <td style="font-weight:500">${r.name}</td>
      <td>${r.detail || ""}</td>
      <td style="color:${statusColor};font-weight:600">${r.status}</td>
      <td>${relScreenshot ? `<a href="${relScreenshot}" target="_blank"><img src="${relScreenshot}" style="max-width:300px;border:1px solid #ddd;border-radius:6px;cursor:pointer" onerror="this.style.display='none'"></a>` : "N/A"}</td>
    </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Micro Agent E2E Test Report</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 1200px; margin: 0 auto; padding: 24px; background: #f9f9f9; }
h1 { font-size: 24px; margin-bottom: 4px; }
.summary { display: flex; gap: 24px; margin: 16px 0; }
.summary-card { background: white; border: 1px solid #e5e5e5; border-radius: 8px; padding: 16px 24px; }
.summary-card .num { font-size: 32px; font-weight: 700; }
.summary-card .label { font-size: 13px; color: #6b6b6b; }
table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; border: 1px solid #e5e5e5; }
th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid #f0f0f0; font-size: 14px; }
th { background: #f5f5f5; font-weight: 600; }
img { transition: transform 0.2s; }
img:hover { transform: scale(1.5); }
</style></head><body>
<h1>Micro Agent E2E Test Report</h1>
<p style="color:#6b6b6b">Generated at ${new Date().toISOString()}</p>
<div class="summary">
  <div class="summary-card"><div class="num">${results.length}</div><div class="label">Total</div></div>
  <div class="summary-card"><div class="num" style="color:#16a34a">${passed}</div><div class="label">Passed</div></div>
  <div class="summary-card"><div class="num" style="color:#dc2626">${failed}</div><div class="label">Failed</div></div>
</div>
<table><thead><tr><th>Test</th><th>Detail</th><th>Status</th><th>Screenshot</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
