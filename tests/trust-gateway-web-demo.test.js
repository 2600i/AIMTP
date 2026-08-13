"use strict";

const assert = require("assert");
const {
  createDemoController,
  createDemoServer,
  createSessionRegistry
} = require("../examples/trust-gateway-web-demo/server");

const SESSION_HEADER = "x-aimtp-demo-session";

/**
 * The eleven-step story the demo tells, in order, asserted on the real Gateway.
 *
 * Execution counts are asserted at every step rather than only at the end,
 * because the claim the demo makes is about *when* the protected action runs —
 * a held request that executes early and a duplicate approval that executes
 * again both leave the same final count as a correct run if you only look once.
 */
async function assertStoryInOrder(controller) {
  // 1-3. A signed request from a trusted agent asks to spend $25 and executes.
  let state = await controller.run("allow");
  assert.equal(state.last_result.decision, "ALLOW");
  assert.equal(state.executions.length, 1);
  assert.equal(state.executions[0].simulated, true, "the protected action must be labelled simulated");

  // 4-5. The same agent asks to spend $250 and is held.
  state = await controller.run("approval");
  assert.equal(state.last_result.decision, "REQUIRE_APPROVAL");
  assert.equal(state.executions.length, 1, "pending purchase must not execute");
  assert.ok(state.pending_approval_id, "a held request must expose an approval id");

  // 6-7. A human approves the original request; it executes.
  state = await controller.run("approve");
  assert.equal(state.last_result.status, "completed");
  assert.equal(state.executions.length, 2);

  // 8. A duplicate approval is blocked.
  state = await controller.run("duplicate");
  assert.equal(state.last_result.decision, "DENY");
  assert.equal(state.executions.length, 2, "duplicate approval must not execute again");

  // 9. A replayed signed request is denied.
  state = await controller.run("replay");
  assert.equal(state.last_result.decision, "DENY");
  assert.match(state.last_result.reason, /already been processed/i);
  assert.equal(state.executions.length, 2, "replay must not execute again");

  // 10. A validly signed but unknown agent is denied.
  state = await controller.run("unknown");
  assert.equal(state.last_result.decision, "DENY");
  assert.match(state.last_result.reason, /unknown agent identity/i);
  assert.equal(state.executions.length, 2, "unknown agent must not execute");

  // 11. The run leaves audit evidence for every one of those decisions.
  assert.ok(state.audit.length >= 6, `expected an audit event per decision, got ${state.audit.length}`);
  return state;
}

async function testStory() {
  await assertStoryInOrder(createDemoController());
}

/**
 * Ordering guards. `approve` before `approval` has nothing to claim, and the
 * demo must say so rather than approving whatever is lying around.
 */
async function testOutOfOrderIsRefused() {
  const controller = createDemoController();
  await assert.rejects(() => controller.run("approve"), /Create an approval request first/);
  await assert.rejects(() => controller.run("replay"), /Run the low-value request first/);
  await assert.rejects(() => controller.run("nope"), /Unknown scenario/);
}

async function testResetClearsState() {
  const controller = createDemoController();
  await controller.run("allow");
  const state = controller.reset();
  assert.equal(state.executions.length, 0);
  assert.equal(state.audit.length, 0);
  assert.equal(state.pending_approval_id, null);
}

/**
 * The property that makes the demo safe to expose publicly: one visitor's
 * pending approval is not claimable by another. Before sessions existed, the
 * second caller's `approve` would settle the first caller's request.
 */
async function testSessionsAreIsolated() {
  const registry = createSessionRegistry();
  const alice = registry.get("a".repeat(32)).controller;
  const bob = registry.get("b".repeat(32)).controller;

  await alice.run("allow");
  await alice.run("approval");

  const bobState = bob.snapshot();
  assert.equal(bobState.executions.length, 0, "one visitor's purchases must not appear for another");
  assert.equal(bobState.pending_approval_id, null, "one visitor's held request must not be visible to another");
  await assert.rejects(() => bob.run("approve"), /Create an approval request first/);

  const aliceAfter = await alice.run("approve");
  assert.equal(aliceAfter.last_result.status, "completed");
  assert.equal(bob.snapshot().executions.length, 0);
}

function testSessionRegistryIsBounded() {
  let clock = 0;
  const registry = createSessionRegistry({ ttlMs: 100, maxSessions: 3, now: () => clock });

  const first = registry.get("1".repeat(32)).controller;
  assert.equal(registry.get("1".repeat(32)).controller, first, "the same id must return the same Gateway");

  registry.get("2".repeat(32));
  registry.get("3".repeat(32));
  registry.get("4".repeat(32));
  assert.equal(registry.size, 3, "the session cap must evict rather than grow");
  assert.notEqual(registry.get("1".repeat(32)).controller, first, "the least recently used session is the one dropped");

  clock += 1000;
  registry.sweep();
  assert.equal(registry.size, 0, "idle sessions must expire");
}

/** The HTTP surface: session minting, method and scenario validation, limits. */
async function testHttpSurface() {
  const server = createDemoServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const base = `http://127.0.0.1:${server.address().port}`;

    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Agent Trust Gateway/);

    // A caller with no session gets one minted and handed back.
    const first = await fetch(`${base}/api/scenarios/allow`, { method: "POST" });
    assert.equal(first.status, 200);
    const session = first.headers.get(SESSION_HEADER);
    assert.match(session || "", /^[0-9a-f]{32}$/, "the server must mint a session id");
    assert.equal((await first.json()).last_result.decision, "ALLOW");

    // Echoing it back continues the same Gateway.
    const continued = await fetch(`${base}/api/state`, { headers: { [SESSION_HEADER]: session } });
    assert.equal((await continued.json()).executions.length, 1);

    // Omitting it starts a fresh one rather than joining somebody else's.
    const stranger = await fetch(`${base}/api/state`);
    assert.equal((await stranger.json()).executions.length, 0);

    // A caller cannot pick an id and land on another visitor's Gateway: the
    // format is enforced, so an invented id is replaced with a minted one.
    const forged = await fetch(`${base}/api/state`, { headers: { [SESSION_HEADER]: "not-a-session" } });
    assert.notEqual(forged.headers.get(SESSION_HEADER), "not-a-session");
    assert.equal((await forged.json()).executions.length, 0);

    const wrongMethod = await fetch(`${base}/api/state`, { method: "POST" });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "GET");

    const unknownScenario = await fetch(`${base}/api/scenarios/drop-tables`, { method: "POST" });
    assert.equal(unknownScenario.status, 404);

    const oversized = await fetch(`${base}/api/scenarios/allow`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(4096) })
    });
    assert.equal(oversized.status, 413);

    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ok");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** A pinned controller keeps the single-Gateway behaviour a local run wants. */
async function testPinnedControllerServer() {
  const server = createDemoServer(createDemoController());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await fetch(`${base}/api/scenarios/allow`, { method: "POST" });
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.executions.length, 1, "a pinned controller is shared across callers by design");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  await testStory();
  await testOutOfOrderIsRefused();
  await testResetClearsState();
  await testSessionsAreIsolated();
  testSessionRegistryIsBounded();
  await testHttpSurface();
  await testPinnedControllerServer();
  console.log("OK: trust gateway web demo tests");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
