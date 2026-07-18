import { chromium } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = "/workspace/micro-agent/e2e/shots";
fs.mkdirSync(OUT, { recursive: true });
const BASE = "http://localhost:3456";

async function shot(page, name) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, fullPage: false });
  console.log("saved", file, fs.statSync(file).size, "bytes");
}

async function sendMsg(page, text) {
  // type into textarea
  await page.fill("#input", text);
  await page.click(".btn-send");
  // wait for assistant reply (toolCalls may take a couple seconds)
  await page.waitForTimeout(4500);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("[browser err]", m.text().slice(0,200)); });

  // 0. Initial UI
  await page.goto(`${BASE}/?v=21`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await shot(page, "01-initial-ui.png");

  // 1. Weather
  await sendMsg(page, "今天北京是什么天气？");
  await shot(page, "02-weather-reply.png");

  // new session to avoid history clutter
  await page.click(".btn-new");
  await page.waitForTimeout(500);

  // 2. Travel
  await sendMsg(page, "新疆6天5晚游，预算15000，2人");
  await shot(page, "03-travel-reply.png");

  await page.click(".btn-new");
  await page.waitForTimeout(500);

  // 3. Image gen
  await sendMsg(page, "生成一张美女图，很漂亮");
  await page.waitForTimeout(5000); // extra wait for image load
  await shot(page, "04-image-gen.png");

  await page.click(".btn-new");
  await page.waitForTimeout(500);

  // 4. Code / game
  await sendMsg(page, "给我看看代码能力和游戏");
  await shot(page, "05-code-reply.png");

  // 5. Flappy game
  await page.goto(`${BASE}/flappy.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  await shot(page, "06-flappy-menu.png");
  // try clicking start
  try {
    await page.click("canvas", { timeout: 1500 });
    await page.waitForTimeout(1200);
    await shot(page, "07-flappy-playing.png");
  } catch { /* menu may not need click */ }

  // 6. Pet game
  await page.goto(`${BASE}/pet.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  await shot(page, "08-pet-initial.png");
  // feed the pet
  try {
    const feedBtn = await page.$("text=喂食") || await page.$("[data-action=feed]") || await page.$("button:nth-child(1)");
    if (feedBtn) { await feedBtn.click(); await page.waitForTimeout(1000); await shot(page, "09-pet-fed.png"); }
  } catch (e) { console.log("pet feed click failed:", e.message); }

  await browser.close();
  console.log("ALL DONE");
}

main().catch((e) => { console.error(e); process.exit(1); });
