import { chromium } from "playwright";

const BASE = "http://localhost:3456";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  await page.goto(`${BASE}/?v=22`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);

  async function send(text) {
    await page.fill("#input", text);
    await page.click(".btn-send");
    await page.waitForTimeout(5000);
  }

  // Weather
  await send("今天北京是什么天气？");
  const weatherHtml = await page.evaluate(() => {
    const msgs = document.querySelectorAll(".msg.assistant .msg-bubble");
    return msgs.length > 0 ? msgs[msgs.length - 1].innerHTML.slice(0, 600) : "NO ASSISTANT MSG";
  });
  console.log("=== WEATHER rendered HTML (last 600 chars) ===");
  console.log(weatherHtml);
  const weatherToolCall = await page.evaluate(() => {
    const tc = document.querySelectorAll(".tool-call");
    return tc.length > 0 ? tc[tc.length - 1].textContent.slice(0, 100) : "NO TOOL CALL DISPLAYED";
  });
  console.log("Weather tool-call display:", weatherToolCall);

  await page.click(".btn-new");
  await page.waitForTimeout(400);

  // Travel
  await send("新疆6天5晚游，预算15000，2人");
  const travelTable = await page.evaluate(() => {
    const bubble = document.querySelectorAll(".msg.assistant .msg-bubble");
    const last = bubble[bubble.length - 1];
    if (!last) return "NO BUBBLE";
    const table = last.querySelector("table");
    const rows = table ? table.querySelectorAll("tr").length : 0;
    const hasImg = last.querySelectorAll("img").length;
    return `table_rows=${rows}, img_count=${hasImg}, text_len=${last.textContent.length}`;
  });
  console.log("=== TRAVEL render check ===", travelTable);

  await page.click(".btn-new");
  await page.waitForTimeout(400);

  // Image
  await send("生成一张美女图，很漂亮");
  await page.waitForTimeout(3000);
  const imgCheck = await page.evaluate(() => {
    const bubble = document.querySelectorAll(".msg.assistant .msg-bubble");
    const last = bubble[bubble.length - 1];
    if (!last) return "NO BUBBLE";
    const img = last.querySelector("img");
    return img ? `img_src=${img.src.slice(0, 80)}... naturalW=${img.naturalWidth}` : "NO IMG ELEMENT";
  });
  console.log("=== IMAGE render check ===", imgCheck);

  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
