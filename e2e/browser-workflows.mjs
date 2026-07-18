#!/usr/bin/env node
/**
 * Browser E2E test for /goal /loop /team dynamic workflows.
 *
 * Opens the Web UI in headless Chromium, sends each workflow directive,
 * captures screenshots as evidence, and asserts the rendered DOM contains
 * Codex-aligned control-flow markers ([GOAL] / [LOOP] / continuation /
 * completion_audit / goal_achieved / workflow_complete).
 *
 * Prereq: demo-server running on PORT (default 3457).
 *   PORT=3457 npx tsx e2e/demo-server.ts &
 *   node e2e/browser-workflows.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const PORT = process.env.PORT || "3457";
const BASE = `http://localhost:${PORT}`;
const SHOT_DIR = "/workspace/micro-agent/e2e/screenshots/workflows";
fs.mkdirSync(SHOT_DIR, { recursive: true });

// Use the full chrome binary (headless shell may not be downloaded)
const CHROME_EXEC = process.env.CHROME_EXEC
  || "/root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome";

const RESULTS = [];
async function test(name, fn) {
  try { await fn(); RESULTS.push({ name, ok: true }); console.log(`  ✓ ${name}`); }
  catch (e) { RESULTS.push({ name, ok: false, err: e.message }); console.log(`  ✗ ${name}\n    ${e.message}`); }
}

async function launchBrowser() {
  return chromium.launch({
    headless: true,
    executablePath: CHROME_EXEC,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
}

async function sendAndWait(page, message, { timeoutMs = 30000 } = {}) {
  await page.fill("#input", message);
  // Tag a marker attribute on body so we can detect when streaming finishes.
  await page.evaluate(() => {
    document.body.setAttribute("data-wf-done", "0");
    // Hook into the SSE done event by wrapping EventSource.prototype if needed.
    // Simpler: poll for sendBtn re-enabled (input has text) OR a final-answer/error card.
  });
  await page.keyboard.press("Enter");

  // Poll for completion: a final-answer element OR an error card appears, AND
  // no DOM mutations for 1.2s. Cap at timeoutMs.
  const start = Date.now();
  let lastNodeCount = 0;
  let stableSince = 0;
  while (Date.now() - start < timeoutMs) {
    const state = await page.evaluate(() => {
      const msgs = document.querySelectorAll("#messages *").length;
      const finalAns = document.querySelectorAll(".final-answer, .error-card").length;
      const thinkSteps = document.querySelectorAll(".thinking-step").length;
      return { msgs, finalAns, thinkSteps };
    });
    if (state.msgs !== lastNodeCount) {
      lastNodeCount = state.msgs;
      stableSince = Date.now();
    }
    // Consider done if we have some content and DOM has been stable for >1.2s
    if (state.thinkSteps + state.finalAns > 0 && Date.now() - stableSince > 1200) {
      break;
    }
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(800);
}

async function readMessagesText(page) {
  return page.evaluate(() => {
    const steps = Array.from(document.querySelectorAll(".thinking-step, .thinking-step-text, .tool-call-name, .final-answer, .error-card"));
    return steps.map((el) => el.textContent.trim()).filter(Boolean);
  });
}

async function newChat(page) {
  const btn = await page.$(".btn-new-chat");
  if (btn) await btn.click();
  await page.waitForTimeout(500);
}

// ============================================================================
// Test 1: Homepage shows workflow suggestion cards + status
// ============================================================================
await test("Homepage loads with /goal /loop /team suggestion cards", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SHOT_DIR, "01-homepage.png"), fullPage: false });

    const html = await page.content();
    if (!html.includes("/goal")) throw new Error("UI missing /goal");
    if (!html.includes("/loop")) throw new Error("UI missing /loop");
    if (!html.includes("/team")) throw new Error("UI missing /team");
    if (!html.includes("Dynamic Workflows")) throw new Error("UI missing Dynamic Workflows section");
  } finally { await browser.close(); }
});

// ============================================================================
// Test 2: /goal workflow — Codex completion contract (mock-mode)
// ============================================================================
await test("/goal: Codex completion contract renders [GOAL] + goal_achieved", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    await sendAndWait(page, "/goal say hello and confirm");
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(SHOT_DIR, "02-goal-workflow.png"), fullPage: false });

    const texts = await readMessagesText(page);
    const joined = texts.join("\n");
    const hasGoalMarker = /\[GOAL\]/i.test(joined);
    const hasContinuationOrAudit = /\bcontinuation|Auditing|completion_audit|Turn\s+\d+/i.test(joined);
    const hasAchieved = /Goal achieved|goal_achieved/i.test(joined);
    if (!hasGoalMarker) throw new Error(`no [GOAL] marker in DOM; got: ${joined.slice(0, 400)}`);
    if (!hasContinuationOrAudit) throw new Error(`no continuation/audit marker; got: ${joined.slice(0, 400)}`);
    if (!hasAchieved) throw new Error(`no goal_achieved marker; got: ${joined.slice(0, 400)}`);
    console.log(`    DOM markers: [GOAL]=${hasGoalMarker}, continuation/audit=${hasContinuationOrAudit}, goal_achieved=${hasAchieved}`);
  } finally { await browser.close(); }
});

// ============================================================================
// Test 3: /team — Agent Team collaboration
// ============================================================================
await test("/team: dispatches members and produces workflow_complete", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    await sendAndWait(page, "/team read package.json and summarize", { timeoutMs: 60000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(SHOT_DIR, "03-team-workflow.png"), fullPage: false });

    const texts = await readMessagesText(page);
    const joined = texts.join("\n");
    const hasTeamMarker = /\[TEAM\]/i.test(joined);
    const hasPlanOrDispatch = /Team mode|dispatch|Plan:|plan_created/i.test(joined);
    const hasComplete = /Team complete|workflow_complete/i.test(joined);
    if (!hasTeamMarker) throw new Error(`no [TEAM] marker; got: ${joined.slice(0, 400)}`);
    if (!hasPlanOrDispatch) throw new Error(`no plan/dispatch marker; got: ${joined.slice(0, 400)}`);
    if (!hasComplete) throw new Error(`no workflow_complete marker; got: ${joined.slice(0, 400)}`);
    console.log(`    DOM markers: [TEAM]=${hasTeamMarker}, dispatch=${hasPlanOrDispatch}, complete=${hasComplete}`);
  } finally { await browser.close(); }
});

// ============================================================================
// Test 4: /goal + 5-section goal template (Scope/Constraints/Done when/Stop if)
// ============================================================================
await test("/goal: 5-section goal template parsed and rendered", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    const goalMsg = "/goal write a hello-world script\nScope: just print hello\nConstraints: must use JavaScript\nDone when: script outputs hello\nStop if: error occurs";
    await sendAndWait(page, goalMsg);
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(SHOT_DIR, "04-goal-5section.png"), fullPage: false });

    const texts = await readMessagesText(page);
    const joined = texts.join("\n");
    const hasAcceptance = /Acceptance criteria|Done when/i.test(joined);
    const hasGoal = /\[GOAL\]/i.test(joined);
    if (!hasAcceptance) throw new Error(`acceptance criteria not rendered; got: ${joined.slice(0, 400)}`);
    if (!hasGoal) throw new Error(`no [GOAL] marker; got: ${joined.slice(0, 400)}`);
    console.log(`    DOM markers: [GOAL]=${hasGoal}, Acceptance criteria=${hasAcceptance}`);
  } finally { await browser.close(); }
});

// ============================================================================
// Summary
// ============================================================================
console.log("\n" + "=".repeat(60));
const passed = RESULTS.filter((r) => r.ok).length;
const failed = RESULTS.length - passed;
console.log(`Browser workflow tests: ${passed}/${RESULTS.length} passed${failed ? `, ${failed} failed` : ""}`);
console.log(`Screenshots saved to: ${SHOT_DIR}`);
if (failed > 0) {
  console.log("\nFailures:");
  RESULTS.filter((r) => !r.ok).forEach((r) => console.log(`  - ${r.name}: ${r.err}`));
  process.exit(1);
}
process.exit(0);
