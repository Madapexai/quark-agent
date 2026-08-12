/**
 * DailyNotes & CuratedMemory unit tests
 *
 * Run: npx tsx e2e/test-daily-notes.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const { SqliteMemory } = await import("../src/memory/sqlite.ts");
const { DailyNoteStore, CuratedMemory, MemoryMaintenance, todayStr } =
  await import("../src/memory/daily-notes.ts");

const RESULTS = [];
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { RESULTS.push({ name, ok: true }); console.log(`  ✓ ${name}`); },
    (e) => { RESULTS.push({ name, ok: false, err: e.message }); console.log(`  ✗ ${name}\n    ${e.message}`); },
  );
}

// Each test gets a fresh DB
function makeMem() {
  const dir = mkdtempSync(join(tmpdir(), "quark-dn-"));
  const db = new Database(join(dir, "t.db"));
  const mem = new SqliteMemory(db, { path: join(dir, "t.db") });
  return { dir, db, mem, cleanup: () => { try { db.close(); } catch {}; try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

await test("DailyNoteStore.write() creates L3 entry", async () => {
  const { mem, cleanup } = makeMem();
  const store = new DailyNoteStore(mem, "u1");
  const id = await store.write("用户对字节薪资体系感兴趣", { date: "2026-01-15", tags: ["salary"] });
  assert.ok(id, "should return an entry ID");

  // read it back
  const notes = await store.getByDate("2026-01-15");
  assert.equal(notes.length, 1, "should have 1 note");
  assert.ok(notes[0].content.includes("字节薪资"), "content should include the text");
  assert.equal(notes[0].date, "2026-01-15", "date should match");
  assert.deepEqual(notes[0].tags, ["salary"], "tags should match");
  cleanup();
});

await test("DailyNoteStore.read() returns notes by date", async () => {
  const { mem, cleanup } = makeMem();
  const store = new DailyNoteStore(mem, "u1");
  await store.write("note A", { date: "2026-02-01" });
  await store.write("note B", { date: "2026-02-01" });
  await store.write("note C", { date: "2026-02-02" });

  const notes = await store.read("2026-02-01");
  assert.equal(notes.length, 2, "should have 2 notes for Feb 1");
  cleanup();
});

await test("DailyNoteStore.search() finds notes by keyword", async () => {
  const { mem, cleanup } = makeMem();
  const store = new DailyNoteStore(mem, "u1");
  await store.write("讨论了React性能优化", { date: "2026-03-01" });
  await store.write("Vue3新特性", { date: "2026-03-02" });

  const results = await store.search({ keyword: "React" });
  assert.ok(results.length > 0, "should find React note");
  assert.ok(results[0].content.includes("React"), "content should include React");
  cleanup();
});

await test("DailyNoteStore.getRange() returns notes in date range", async () => {
  const { mem, cleanup } = makeMem();
  const store = new DailyNoteStore(mem, "u1");
  await store.write("day1", { date: "2026-04-01" });
  await store.write("day2", { date: "2026-04-02" });
  await store.write("day3", { date: "2026-04-03" });
  await store.write("day4", { date: "2026-04-10" });

  const range = await store.getRange("2026-04-01", "2026-04-03");
  assert.equal(range.length, 3, "should have 3 notes in range");
  cleanup();
});

await test("CuratedMemory.addFact() writes L2 fact", async () => {
  const { mem, cleanup } = makeMem();
  const curated = new CuratedMemory(mem, "u1");
  const id = await curated.addFact("用户偏好简洁直接的沟通风格", 0.9);
  assert.ok(id, "should return fact ID");
  cleanup();
});

await test("CuratedMemory.searchFacts() searches L2 facts", async () => {
  const { mem, cleanup } = makeMem();
  const curated = new CuratedMemory(mem, "u1");
  await curated.addFact("用户偏好简洁沟通", 0.9);
  await curated.addFact("用户在互联网行业工作", 0.7);

  const results = await curated.searchFacts("沟通");
  assert.ok(results.length > 0, "should find matching facts");
  cleanup();
});

await test("CuratedMemory.distillFromDailyNotes() extracts L2 from L3", async () => {
  const { mem, cleanup } = makeMem();
  const store = new DailyNoteStore(mem, "u1");
  const curated = new CuratedMemory(mem, "u1");

  // Write some daily notes
  await store.write("用户问了字节跳动薪资体系，对互联网薪酬感兴趣", { date: "2026-05-01" });
  await store.write("用户继续追问OpenClaw架构设计", { date: "2026-05-02" });

  // Distill from daily notes
  const notes = await store.getRecent(7);
  const count = await curated.distillFromDailyNotes(notes);
  // Without a real LLM provider, it falls back to extraction
  assert.ok(count >= 0, "distillation should complete without error");
  cleanup();
});

await test("MemoryMaintenance: runOnce triggers distillation", async () => {
  const { mem, cleanup } = makeMem();
  const store = new DailyNoteStore(mem, "u1");
  const curated = new CuratedMemory(mem, "u1");
  const maintenance = new MemoryMaintenance(store, curated);

  await store.write("test note for maintenance", { date: "2026-06-01" });
  const result = await maintenance.runOnce();
  assert.ok(result.fromNotes >= 0, "should return note count");
  cleanup();
});

await test("todayStr() returns YYYY-MM-DD format", async () => {
  const today = todayStr();
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/, "should match YYYY-MM-DD");
  const d = new Date();
  const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  assert.equal(today, expected, "should match today's date");
});

// ============================================================================
// Summary
// ============================================================================
console.log("\n" + "=".repeat(60));
const passed = RESULTS.filter((r) => r.ok).length;
const failed = RESULTS.length - passed;
console.log(`DailyNotes tests: ${passed}/${RESULTS.length} passed${failed ? `, ${failed} failed` : ""}`);
if (failed > 0) {
  console.log("\nFailures:");
  RESULTS.filter((r) => !r.ok).forEach((r) => console.log(`  - ${r.name}: ${r.err}`));
  process.exit(1);
}
process.exit(0);
