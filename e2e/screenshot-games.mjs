import { chromium } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = "/workspace/micro-agent/e2e/shots";
const BASE = "http://localhost:3456";

async function shot(page, name) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, fullPage: false });
  console.log("saved", file, fs.statSync(file).size, "bytes");
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  // Flappy - press space to start and play
  await page.goto(`${BASE}/flappy.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  await shot(page, "06-flappy-menu.png");
  // press space to start
  await page.keyboard.press("Space");
  await page.waitForTimeout(800);
  await shot(page, "07-flappy-playing.png");
  // press space a few more times to keep bird alive
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Space");
    await page.waitForTimeout(400);
  }
  await shot(page, "07b-flappy-action.png");
  // extract score
  const flappyInfo = await page.evaluate(() => {
    const score = document.querySelector("#score, .score");
    const canvas = document.querySelector("canvas");
    return { score: score?.textContent || "n/a", canvasW: canvas?.width || 0, canvasH: canvas?.height || 0 };
  });
  console.log("Flappy info:", JSON.stringify(flappyInfo));

  // Pet game - feed and verify state change
  await page.goto(`${BASE}/pet.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  await shot(page, "08-pet-initial.png");
  // capture initial state
  const petBefore = await page.evaluate(() => {
    const txt = document.body.innerText;
    const hunger = txt.match(/饥饿[^\d]*(\d+)/)?.[1];
    const mood = txt.match(/心情[^\d]*(\d+)/)?.[1];
    return { hunger, mood, textLen: txt.length };
  });
  console.log("Pet before feed:", JSON.stringify(petBefore));
  // click feed button
  const fed = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button")];
    const feed = btns.find(b => b.textContent.includes("喂食") || b.textContent.includes("feed"));
    if (feed) { feed.click(); return feed.textContent; }
    return null;
  });
  console.log("Feed button clicked:", fed);
  await page.waitForTimeout(1200);
  await shot(page, "09-pet-fed.png");
  const petAfter = await page.evaluate(() => {
    const txt = document.body.innerText;
    const hunger = txt.match(/饥饿[^\d]*(\d+)/)?.[1];
    const mood = txt.match(/心情[^\d]*(\d+)/)?.[1];
    const msg = document.querySelector(".pet-message, #message, .msg")?.textContent;
    return { hunger, mood, message: msg };
  });
  console.log("Pet after feed:", JSON.stringify(petAfter));

  await browser.close();
  console.log("GAMES DONE");
}
main().catch((e) => { console.error(e); process.exit(1); });
