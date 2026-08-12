/**
 * Context Isolation unit tests
 *
 * Run: npx tsx e2e/test-context-isolation.mjs
 *
 * Coverage:
 *   1. isolated mode: different sources → different sessions
 *   2. main mode: all DMs share main session
 *   3. per-peer mode: same peer → same session, different → different
 *   4. named mode: routes to named sessions
 *   5. filterByVisibility: filters entries by scope rules
 *   6. closeSession: removes session from active tracking
 *   7. convenience factories: createIsolatedRouter / createSharedRouter / createPerPeerRouter
 */

import assert from "node:assert/strict";

const { SessionRouter, filterByVisibility, createIsolatedRouter, createSharedRouter, createPerPeerRouter } =
  await import("../src/session/isolation.ts");

const RESULTS = [];
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { RESULTS.push({ name, ok: true }); console.log(`  ✓ ${name}`); },
    (e) => { RESULTS.push({ name, ok: false, err: e.message }); console.log(`  ✗ ${name}\n    ${e.message}`); },
  );
}

// ============================================================================
// Test 1: isolated mode
// ============================================================================
await test("isolated mode: different sources → different sessions", async () => {
  const router = new SessionRouter({ mode: "isolated" });
  const r1 = router.route({ userId: "u1", channel: "telegram", peerId: "alice", isDM: true, text: "hello" });
  const r2 = router.route({ userId: "u1", channel: "telegram", peerId: "bob", isDM: true, text: "world" });
  assert.notEqual(r1.identity.sessionId, r2.identity.sessionId, "isolated mode should produce different session IDs");
  assert.ok(r1.isNew, "first session should be new");
  assert.ok(r2.isNew, "second session should be new");
  router.closeSession("__all__");
});

// ============================================================================
// Test 2: main mode (shared)
// ============================================================================
await test("main mode: all DMs share main session", async () => {
  const router = new SessionRouter({ mode: "main", mainSessionId: "shared" });
  const r1 = router.route({ userId: "u1", channel: "telegram", peerId: "alice", isDM: true, text: "hi" });
  const r2 = router.route({ userId: "u2", channel: "discord", peerId: "bob", isDM: true, text: "hello" });
  assert.equal(r1.identity.sessionId, r2.identity.sessionId, "main mode should share session");
  assert.equal(r1.identity.sessionId, "shared", "should be the configured main session ID");
  router.closeSession("__all__");
});

// ============================================================================
// Test 3: per-peer mode
// ============================================================================
await test("per-peer mode: same peer → same session, different → different", async () => {
  const router = new SessionRouter({ mode: "per-peer" });
  const r1 = router.route({ userId: "u1", channel: "tg", peerId: "alice", isDM: true, text: "hi" });
  const r2 = router.route({ userId: "u1", channel: "tg", peerId: "alice", isDM: true, text: "hello" });
  const r3 = router.route({ userId: "u1", channel: "tg", peerId: "bob", isDM: true, text: "hi" });
  assert.equal(r1.identity.sessionId, r2.identity.sessionId, "same peer → same session");
  assert.notEqual(r1.identity.sessionId, r3.identity.sessionId, "different peer → different session");
  router.closeSession("__all__");
});

// ============================================================================
// Test 4: named mode
// ============================================================================
await test("named mode: routes to named sessions", async () => {
  const router = new SessionRouter({
    mode: "named",
    namedMappings: { "telegram:alice": "alice-session" },
  });
  const r1 = router.route({ userId: "u1", channel: "telegram", peerId: "alice", isDM: true, text: "hi" });
  assert.equal(r1.identity.sessionId, "alice-session", "telegram:alice should map to alice-session");
  router.closeSession("__all__");
});

// ============================================================================
// Test 5: filterByVisibility
// ============================================================================
await test("filterByVisibility: filters entries by scope rules", async () => {
  const entries = [
    { id: "1", userId: "u1", sessionId: "s1", kind: "chat", layer: "L0", content: "msg1", importance: 0.5, createdAt: Date.now() },
    { id: "2", userId: "u1", sessionId: "s2", kind: "chat", layer: "L0", content: "msg2", importance: 0.5, createdAt: Date.now() },
    { id: "3", userId: "u1", sessionId: undefined, kind: "fact", layer: "L2", content: "fact1", importance: 0.9, createdAt: Date.now() },
    { id: "4", userId: "u2", sessionId: undefined, kind: "fact", layer: "L2", content: "fact2", importance: 0.9, createdAt: Date.now() },
  ];

  // L0 session-scoped: only same session
  const isolated = filterByVisibility(entries, { L0: "session", L1: "session", L2: "user", L3: "user" }, "u1", "s1");
  // Should see: own L0 from s1 (entry 1) + own L2 (entry 3), NOT entry 2 (different session) or entry 4 (different user)
  assert.equal(isolated.length, 2, "isolated should see own L0 + own L2");

  // L0 user-scoped: same user's L0 from any session
  const userScoped = filterByVisibility(entries, { L0: "user", L1: "user", L2: "user", L3: "user" }, "u1", "s1");
  // Should see: entries 1, 2, 3 (all from u1), NOT entry 4
  assert.equal(userScoped.length, 3, "user-scoped should see all u1 entries");

  // Global: everything
  const globalScope = filterByVisibility(entries, { L0: "global", L1: "global", L2: "global", L3: "global" }, "u1", "s1");
  assert.equal(globalScope.length, 4, "global should see all entries");
});

// ============================================================================
// Test 6: closeSession
// ============================================================================
await test("closeSession: removes session from active tracking", async () => {
  const router = new SessionRouter({ mode: "isolated" });
  router.route({ userId: "u1", channel: "tg", peerId: "a", isDM: true, text: "hi" });
  router.route({ userId: "u1", channel: "tg", peerId: "b", isDM: true, text: "hi" });
  assert.equal(router.getActiveSessions().length, 2, "should have 2 active sessions");

  router.closeSession("__all__");
  assert.equal(router.getActiveSessions().length, 0, "should have 0 after closeAll");
});

// ============================================================================
// Test 7: convenience factories
// ============================================================================
await test("convenience factories: create correct mode routers", async () => {
  const isolated = createIsolatedRouter();
  const r1 = isolated.route({ userId: "u1", channel: "tg", peerId: "a", isDM: true, text: "hi" });
  const r2 = isolated.route({ userId: "u1", channel: "tg", peerId: "b", isDM: true, text: "hi" });
  assert.notEqual(r1.identity.sessionId, r2.identity.sessionId, "createIsolatedRouter should isolate");

  const shared = createSharedRouter("main-test");
  const r3 = shared.route({ userId: "u1", channel: "tg", peerId: "a", isDM: true, text: "hi" });
  const r4 = shared.route({ userId: "u2", channel: "tg", peerId: "b", isDM: true, text: "hi" });
  assert.equal(r3.identity.sessionId, r4.identity.sessionId, "createSharedRouter should share");
  assert.equal(r3.identity.sessionId, "main-test", "should use configured main session ID");

  const perPeer = createPerPeerRouter();
  const r5 = perPeer.route({ userId: "u1", channel: "tg", peerId: "x", isDM: true, text: "hi" });
  const r6 = perPeer.route({ userId: "u1", channel: "tg", peerId: "x", isDM: true, text: "hi" });
  const r7 = perPeer.route({ userId: "u1", channel: "tg", peerId: "y", isDM: true, text: "hi" });
  assert.equal(r5.identity.sessionId, r6.identity.sessionId, "same peer → same session");
  assert.notEqual(r5.identity.sessionId, r7.identity.sessionId, "different peer → different session");

  isolated.closeSession("__all__");
  shared.closeSession("__all__");
  perPeer.closeSession("__all__");
});

// ============================================================================
// Summary
// ============================================================================
console.log("\n" + "=".repeat(60));
const passed = RESULTS.filter((r) => r.ok).length;
const failed = RESULTS.length - passed;
console.log(`Context Isolation tests: ${passed}/${RESULTS.length} passed${failed ? `, ${failed} failed` : ""}`);
if (failed > 0) {
  console.log("\nFailures:");
  RESULTS.filter((r) => !r.ok).forEach((r) => console.log(`  - ${r.name}: ${r.err}`));
  process.exit(1);
}
process.exit(0);
