#!/usr/bin/env node
/**
 * Generate a visual HTML report from full-eval-results.json
 *
 * Output: e2e/FULL-EVAL-REPORT.html
 */
import fs from "node:fs";

const RESULTS_PATH = "/workspace/micro-agent/e2e/full-eval-results.json";
const HTML_PATH = "/workspace/micro-agent/e2e/FULL-EVAL-REPORT.html";

const results = JSON.parse(fs.readFileSync(RESULTS_PATH, "utf8"));

// ---------- stats ----------
const total = results.length;
const passed = results.filter(r => r.status === "PASS").length;
const failed = results.filter(r => r.status === "FAIL").length;
const errored = results.filter(r => r.status === "ERROR").length;
const passRate = ((passed / total) * 100).toFixed(1);
const avgLatency = Math.round(results.reduce((s, r) => s + (r.latencyMs || 0), 0) / total);

function groupStats(items) {
  const t = items.length;
  const p = items.filter(r => r.status === "PASS").length;
  const f = items.filter(r => r.status === "FAIL").length;
  const e = items.filter(r => r.status === "ERROR").length;
  return { total: t, pass: p, fail: f, error: e, rate: t ? ((p / t) * 100).toFixed(1) : "0.0" };
}

const gaia = results.filter(r => r.benchmark === "GAIA");
const ab = results.filter(r => r.benchmark === "AgentBench");
const gaiaStats = groupStats(gaia);
const abStats = groupStats(ab);

// GAIA levels
const levels = [1, 2, 3].map(l => {
  const items = gaia.filter(r => r.level === l);
  return { level: `Level ${l}`, ...groupStats(items) };
});

// AgentBench categories
const categories = ["db_bench", "os_interaction", "knowledge_graph"].map(c => {
  const items = ab.filter(r => r.category === c);
  return {
    category: c === "db_bench" ? "DB-Bench (SQL)" : c === "os_interaction" ? "OS-Interaction" : "Knowledge-Graph",
    raw: c,
    ...groupStats(items),
  };
});

// Tool usage
const toolCounts = {};
for (const r of results) {
  for (const tc of (r.toolCalls || [])) {
    toolCounts[tc.tool] = (toolCounts[tc.tool] || 0) + 1;
  }
}
const tools = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]);
const toolsWithTasks = results.filter(r => (r.toolCalls || []).length > 0).length;

// Latency distribution
const latencies = results.map(r => r.latencyMs || 0).sort((a, b) => a - b);
const p50 = latencies[Math.floor(latencies.length * 0.5)];
const p90 = latencies[Math.floor(latencies.length * 0.9)];
const p99 = latencies[Math.floor(latencies.length * 0.99)];
const maxLat = latencies[latencies.length - 1];

// ---------- HTML escape ----------
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncate(s, n) {
  s = String(s == null ? "" : s);
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// ---------- task cards ----------
function taskCard(r) {
  const statusClass = r.status === "PASS" ? "pass" : r.status === "FAIL" ? "fail" : "error";
  const toolSummary = (r.toolCalls || []).map(tc => tc.tool).join(", ") || "(no tools)";
  const toolCallsHtml = (r.toolCalls || []).map((tc, i) => {
    const argsStr = typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args, null, 2);
    const result = r.toolResults?.[i]?.result || "";
    return `
      <div class="toolcall">
        <div class="toolcall-head" onclick="this.parentElement.classList.toggle('expanded')">
          <span class="toolcall-idx">#${i + 1}</span>
          <span class="toolcall-name">${esc(tc.tool)}</span>
          <span class="toolcall-toggle">▾</span>
        </div>
        <div class="toolcall-body">
          <div class="toolcall-args"><pre>${esc(truncate(argsStr, 2000))}</pre></div>
          ${result ? `<div class="toolcall-result"><pre>${esc(truncate(result, 2000))}</pre></div>` : ""}
        </div>
      </div>`;
  }).join("");

  return `
    <div class="card ${statusClass}" data-benchmark="${r.benchmark}" data-status="${r.status}" data-category="${r.category || ""}" data-level="${r.level || ""}">
      <div class="card-head">
        <span class="status-badge ${statusClass}">${r.status}</span>
        <span class="task-id">${esc(r.id)}</span>
        <span class="task-meta">${esc(r.benchmark)} · ${esc(r.category || "")}</span>
        <span class="task-latency">${r.latencyMs || 0}ms</span>
      </div>
      <div class="card-section">
        <div class="section-label">Input</div>
        <div class="section-content input-text">${esc(r.input)}</div>
      </div>
      ${toolCallsHtml ? `
      <div class="card-section">
        <div class="section-label">Tool Calls <span class="tool-summary">[${esc(toolSummary)}]</span></div>
        <div class="toolcalls">${toolCallsHtml}</div>
      </div>` : ""}
      ${r.thinkingSteps?.length ? `
      <div class="card-section">
        <div class="section-label">Thinking</div>
        <div class="section-content thinking-text">${esc(r.thinkingSteps.join(" → "))}</div>
      </div>` : ""}
      <div class="card-section grid-2">
        <div>
          <div class="section-label">Output</div>
          <div class="section-content output-text">${esc(truncate(r.output, 800))}</div>
        </div>
        <div>
          <div class="section-label">Expected</div>
          <div class="section-content expected-text">${esc(truncate(r.expected, 400))}</div>
        </div>
      </div>
      <div class="card-foot">
        <span class="match-reason">Match: ${esc(r.matchReason || "-")}</span>
        ${r.error ? `<span class="err-msg">Error: ${esc(r.error)}</span>` : ""}
      </div>
    </div>`;
}

const cardsHtml = results.map(taskCard).join("\n");

// ---------- bar svg ----------
function barSvg(pct, color = "#10b981") {
  return `<div class="bar"><div class="bar-fill" style="width:${pct}%;background:${color}"></div><span class="bar-label">${pct}%</span></div>`;
}

function colorByRate(rate) {
  const r = parseFloat(rate);
  if (r >= 90) return "#10b981";
  if (r >= 80) return "#22c55e";
  if (r >= 70) return "#f59e0b";
  return "#ef4444";
}

// ---------- HTML ----------
const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>Agent Evaluation Report — AgentBench + GAIA (200 Tasks)</title>
<style>
  :root {
    --bg: #0f172a;
    --card-bg: #1e293b;
    --border: #334155;
    --text: #e2e8f0;
    --text-muted: #94a3b8;
    --pass: #10b981;
    --fail: #ef4444;
    --error: #f59e0b;
    --accent: #3b82f6;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue",
      Arial, "Noto Sans", sans-serif;
    background: var(--bg); color: var(--text); line-height: 1.6;
  }
  .container { max-width: 1400px; margin: 0 auto; padding: 24px; }
  h1 { margin: 0 0 8px; font-size: 28px; }
  h2 { margin: 32px 0 12px; font-size: 22px; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
  .subtitle { color: var(--text-muted); margin-bottom: 24px; font-size: 14px; }

  /* overview cards */
  .overview { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 32px; }
  .stat-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 18px; }
  .stat-card .label { color: var(--text-muted); font-size: 13px; }
  .stat-card .value { font-size: 28px; font-weight: 700; margin-top: 4px; }
  .stat-card.pass .value { color: var(--pass); }
  .stat-card.fail .value { color: var(--fail); }
  .stat-card.error .value { color: var(--error); }
  .stat-card.rate .value { color: var(--accent); }

  /* tables */
  table { width: 100%; border-collapse: collapse; margin-bottom: 24px; background: var(--card-bg); border-radius: 8px; overflow: hidden; }
  th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid var(--border); font-size: 14px; }
  th { background: #0f172a; color: var(--text-muted); font-weight: 600; }
  tr:last-child td { border-bottom: none; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .pill { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .pill.pass { background: rgba(16,185,129,.15); color: var(--pass); }
  .pill.fail { background: rgba(239,68,68,.15); color: var(--fail); }
  .pill.error { background: rgba(245,158,11,.15); color: var(--error); }

  /* bar */
  .bar { position: relative; height: 24px; background: #0f172a; border-radius: 6px; overflow: hidden; min-width: 120px; }
  .bar-fill { height: 100%; transition: width .5s; }
  .bar-label { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); font-size: 12px; font-weight: 600; color: #fff; }

  /* tool usage */
  .tool-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
  .tool-row { display: flex; align-items: center; gap: 12px; background: var(--card-bg); padding: 10px 14px; border-radius: 8px; border: 1px solid var(--border); }
  .tool-row .tname { flex: 1; font-weight: 500; }
  .tool-row .tcount { font-variant-numeric: tabular-nums; color: var(--accent); font-weight: 600; }

  /* latency */
  .latency-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
  .lat-card { background: var(--card-bg); padding: 14px; border-radius: 8px; border: 1px solid var(--border); text-align: center; }
  .lat-card .l-val { font-size: 22px; font-weight: 700; color: var(--accent); }
  .lat-card .l-label { font-size: 12px; color: var(--text-muted); }

  /* filters */
  .filters { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-bottom: 20px; display: flex; flex-wrap: wrap; gap: 12px; align-items: center; position: sticky; top: 0; z-index: 10; }
  .filters label { font-size: 13px; color: var(--text-muted); margin-right: 6px; }
  .filters select, .filters input { background: #0f172a; color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 13px; }
  .filters .count { margin-left: auto; color: var(--text-muted); font-size: 13px; }

  /* task cards */
  .cards { display: grid; grid-template-columns: 1fr; gap: 14px; }
  .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; padding: 16px; border-left: 4px solid var(--text-muted); }
  .card.pass { border-left-color: var(--pass); }
  .card.fail { border-left-color: var(--fail); }
  .card.error { border-left-color: var(--error); }
  .card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
  .status-badge { padding: 3px 10px; border-radius: 6px; font-size: 11px; font-weight: 700; letter-spacing: .5px; }
  .status-badge.pass { background: var(--pass); color: #052e1f; }
  .status-badge.fail { background: var(--fail); color: #fff; }
  .status-badge.error { background: var(--error); color: #2a1a00; }
  .task-id { font-weight: 700; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .task-meta { color: var(--text-muted); font-size: 13px; }
  .task-latency { margin-left: auto; color: var(--text-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .card-section { margin-bottom: 10px; }
  .section-label { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: var(--text-muted); margin-bottom: 4px; }
  .section-content { background: #0f172a; border: 1px solid var(--border); border-radius: 6px; padding: 10px; font-size: 13px; white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow-y: auto; }
  .input-text { color: #c4b5fd; }
  .output-text { color: #86efac; }
  .expected-text { color: #fcd34d; }
  .thinking-text { color: var(--text-muted); font-style: italic; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .tool-summary { color: var(--accent); font-weight: 400; text-transform: none; }
  .toolcalls { display: flex; flex-direction: column; gap: 6px; }
  .toolcall { background: #0f172a; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  .toolcall-head { display: flex; align-items: center; gap: 10px; padding: 6px 10px; cursor: pointer; user-select: none; }
  .toolcall-head:hover { background: #1e293b; }
  .toolcall-idx { font-size: 11px; color: var(--text-muted); }
  .toolcall-name { font-family: ui-monospace, monospace; font-weight: 600; color: var(--accent); }
  .toolcall-toggle { margin-left: auto; color: var(--text-muted); }
  .toolcall-body { display: none; padding: 0 10px 8px; }
  .toolcall.expanded .toolcall-body { display: block; }
  .toolcall-args pre, .toolcall-result pre { margin: 4px 0; padding: 8px; background: #0a0f1d; border-radius: 4px; font-size: 12px; overflow-x: auto; max-height: 200px; overflow-y: auto; }
  .toolcall-result { margin-top: 6px; }
  .toolcall-result pre { color: #a3e635; }
  .card-foot { display: flex; gap: 12px; margin-top: 8px; font-size: 12px; color: var(--text-muted); flex-wrap: wrap; }
  .match-reason { color: var(--accent); }
  .err-msg { color: var(--error); }
  .hidden { display: none !important; }
  footer { text-align: center; color: var(--text-muted); padding: 24px 0; font-size: 12px; }
</style>
</head>
<body>
<div class="container">
  <h1>Agent Evaluation Report</h1>
  <div class="subtitle">AgentBench (THUDM) + GAIA (Meta/HF) · ${total} tasks · ${new Date().toISOString().slice(0, 10)} · env: Node.js + real LLM</div>

  <h2>Overview</h2>
  <div class="overview">
    <div class="stat-card rate"><div class="label">Pass Rate</div><div class="value">${passRate}%</div></div>
    <div class="stat-card"><div class="label">Total Tasks</div><div class="value">${total}</div></div>
    <div class="stat-card pass"><div class="label">Passed</div><div class="value">${passed}</div></div>
    <div class="stat-card fail"><div class="label">Failed</div><div class="value">${failed}</div></div>
    <div class="stat-card error"><div class="label">Errored</div><div class="value">${errored}</div></div>
    <div class="stat-card"><div class="label">Avg Latency</div><div class="value">${(avgLatency / 1000).toFixed(1)}s</div></div>
    <div class="stat-card"><div class="label">Tool-Using Tasks</div><div class="value">${toolsWithTasks}/${total}</div></div>
  </div>

  <h2>By Benchmark</h2>
  <table>
    <thead><tr><th>Benchmark</th><th class="num">Total</th><th class="num">Pass</th><th class="num">Fail</th><th class="num">Error</th><th>Pass Rate</th></tr></thead>
    <tbody>
      <tr><td>GAIA (Meta/HF)</td><td class="num">${gaiaStats.total}</td><td class="num">${gaiaStats.pass}</td><td class="num">${gaiaStats.fail}</td><td class="num">${gaiaStats.error}</td><td>${barSvg(gaiaStats.rate, colorByRate(gaiaStats.rate))}</td></tr>
      <tr><td>AgentBench (THUDM)</td><td class="num">${abStats.total}</td><td class="num">${abStats.pass}</td><td class="num">${abStats.fail}</td><td class="num">${abStats.error}</td><td>${barSvg(abStats.rate, colorByRate(abStats.rate))}</td></tr>
    </tbody>
  </table>

  <h2>GAIA by Difficulty Level</h2>
  <table>
    <thead><tr><th>Level</th><th class="num">Total</th><th class="num">Pass</th><th class="num">Fail</th><th class="num">Error</th><th>Pass Rate</th></tr></thead>
    <tbody>
      ${levels.map(l => `<tr><td>${l.level}</td><td class="num">${l.total}</td><td class="num">${l.pass}</td><td class="num">${l.fail}</td><td class="num">${l.error}</td><td>${barSvg(l.rate, colorByRate(l.rate))}</td></tr>`).join("")}
    </tbody>
  </table>

  <h2>AgentBench by Category</h2>
  <table>
    <thead><tr><th>Category</th><th class="num">Total</th><th class="num">Pass</th><th class="num">Fail</th><th class="num">Error</th><th>Pass Rate</th></tr></thead>
    <tbody>
      ${categories.map(c => `<tr><td>${c.category}</td><td class="num">${c.total}</td><td class="num">${c.pass}</td><td class="num">${c.fail}</td><td class="num">${c.error}</td><td>${barSvg(c.rate, colorByRate(c.rate))}</td></tr>`).join("")}
    </tbody>
  </table>

  <h2>Tool Usage</h2>
  <div class="tool-grid">
    ${tools.map(([name, cnt]) => `<div class="tool-row"><span class="tname">${esc(name)}</span><span class="tcount">${cnt}</span></div>`).join("")}
  </div>

  <h2>Latency Distribution</h2>
  <div class="latency-grid">
    <div class="lat-card"><div class="l-val">${(p50 / 1000).toFixed(1)}s</div><div class="l-label">P50</div></div>
    <div class="lat-card"><div class="l-val">${(p90 / 1000).toFixed(1)}s</div><div class="l-label">P90</div></div>
    <div class="lat-card"><div class="l-val">${(p99 / 1000).toFixed(1)}s</div><div class="l-label">P99</div></div>
    <div class="lat-card"><div class="l-val">${(maxLat / 1000).toFixed(1)}s</div><div class="l-label">Max</div></div>
    <div class="lat-card"><div class="l-val">${(avgLatency / 1000).toFixed(1)}s</div><div class="l-label">Avg</div></div>
  </div>

  <h2>Task Details <span style="font-size:14px;color:var(--text-muted);font-weight:400">(${total} tasks · click tool call to expand)</span></h2>
  <div class="filters">
    <label>Benchmark:</label>
    <select id="f-bench">
      <option value="">All</option>
      <option value="GAIA">GAIA</option>
      <option value="AgentBench">AgentBench</option>
    </select>
    <label>Status:</label>
    <select id="f-status">
      <option value="">All</option>
      <option value="PASS">PASS</option>
      <option value="FAIL">FAIL</option>
      <option value="ERROR">ERROR</option>
    </select>
    <label>Category:</label>
    <select id="f-cat">
      <option value="">All</option>
      <option value="Level 1">GAIA L1</option>
      <option value="Level 2">GAIA L2</option>
      <option value="Level 3">GAIA L3</option>
      <option value="db_bench">AB DB-Bench</option>
      <option value="os_interaction">AB OS-Interaction</option>
      <option value="knowledge_graph">AB Knowledge-Graph</option>
    </select>
    <label>Search:</label>
    <input id="f-search" type="text" placeholder="task id / input / output…" size="30">
    <span class="count" id="f-count"></span>
  </div>
  <div class="cards" id="cards">
    ${cardsHtml}
  </div>

  <footer>Generated by micro-agent · ${new Date().toISOString()}</footer>
</div>

<script>
  const cards = document.querySelectorAll('.card');
  const fBench = document.getElementById('f-bench');
  const fStatus = document.getElementById('f-status');
  const fCat = document.getElementById('f-cat');
  const fSearch = document.getElementById('f-search');
  const fCount = document.getElementById('f-count');

  function applyFilter() {
    const bench = fBench.value;
    const status = fStatus.value;
    const cat = fCat.value;
    const q = fSearch.value.toLowerCase().trim();
    let shown = 0;
    cards.forEach(c => {
      const matchBench = !bench || c.dataset.benchmark === bench;
      const matchStatus = !status || c.dataset.status === status;
      const matchCat = !cat || c.dataset.category === cat;
      const text = c.textContent.toLowerCase();
      const matchQ = !q || text.includes(q);
      const ok = matchBench && matchStatus && matchCat && matchQ;
      c.classList.toggle('hidden', !ok);
      if (ok) shown++;
    });
    fCount.textContent = shown + ' / ${total} shown';
  }
  [fBench, fStatus, fCat].forEach(el => el.addEventListener('change', applyFilter));
  fSearch.addEventListener('input', applyFilter);
  applyFilter();
</script>
</body>
</html>`;

fs.writeFileSync(HTML_PATH, html);
console.log(`HTML report saved: ${HTML_PATH}`);
console.log(`Size: ${(fs.statSync(HTML_PATH).size / 1024).toFixed(1)} KB`);
console.log(`Pass rate: ${passRate}% (${passed}/${total})`);
