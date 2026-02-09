"use strict";

const assert = require("assert");
const { createIntentStore } = require("../runtime/intentos");

function main() {
  let nowMs = Date.parse("2026-02-09T00:00:00Z");
  const store = createIntentStore({
    now: () => nowMs,
    boxId: "default"
  });

  const firstIntentId = store.submitIntent({
    principal: "did:aimtp:user.alice",
    goal: "Summarize launch blockers",
    idempotency_key: "idem-001",
    metadata: { source: "test" }
  });
  assert.ok(firstIntentId.startsWith("intent-"));

  const duplicateIntentId = store.submitIntent({
    principal: "did:aimtp:user.alice",
    goal: "Summarize launch blockers",
    idempotency_key: "idem-001"
  });
  assert.strictEqual(duplicateIntentId, firstIntentId, "idempotency key should dedupe submitIntent");

  const listedSubmitted = store.listIntents("submitted", 10);
  assert.strictEqual(listedSubmitted.length, 1);
  assert.strictEqual(listedSubmitted[0].id, firstIntentId);

  nowMs += 1000;
  const taskA = store.enqueueTask({
    intent_id: firstIntentId,
    type: "classify",
    input: { goal: "Summarize launch blockers" }
  });
  nowMs += 1000;
  const taskB = store.enqueueTask({
    intent_id: firstIntentId,
    type: "draft_reply",
    input: { goal: "Summarize launch blockers" }
  });

  const afterEnqueue = store.getIntent(firstIntentId);
  assert.ok(afterEnqueue);
  assert.strictEqual(afterEnqueue.intent.status, "planning");
  assert.strictEqual(afterEnqueue.tasks.length, 2);

  const claimA = store.claimTask(taskA, "did:aimtp:agent.worker-1");
  assert.strictEqual(claimA.ok, true);
  assert.strictEqual(claimA.status, "claimed");

  const claimADuplicate = store.claimTask(taskA, "did:aimtp:agent.worker-1");
  assert.strictEqual(claimADuplicate.ok, true);
  assert.strictEqual(claimADuplicate.idempotent, true);

  const claimAConflict = store.claimTask(taskA, "did:aimtp:agent.worker-2");
  assert.strictEqual(claimAConflict.ok, false);
  assert.strictEqual(claimAConflict.code, "task_already_claimed");

  const completeA = store.completeTask(taskA, {
    agent_id: "did:aimtp:agent.worker-1",
    status: "completed",
    output: { category: "analysis" }
  });
  assert.strictEqual(completeA.ok, true);
  assert.strictEqual(completeA.status, "completed");

  const completeBWithoutClaim = store.completeTask(taskB, {
    agent_id: "did:aimtp:agent.worker-1",
    status: "completed",
    output: { template: "ok" }
  });
  assert.strictEqual(completeBWithoutClaim.ok, false);
  assert.strictEqual(completeBWithoutClaim.code, "task_not_claimed");

  const claimB = store.claimTask(taskB, "did:aimtp:agent.worker-1");
  assert.strictEqual(claimB.ok, true);

  const completeB = store.completeTask(taskB, {
    agent_id: "did:aimtp:agent.worker-1",
    status: "completed",
    output: { template: "Thanks, working on it." }
  });
  assert.strictEqual(completeB.ok, true);

  const completedIntent = store.getIntent(firstIntentId);
  assert.ok(completedIntent);
  assert.strictEqual(completedIntent.intent.status, "completed");
  assert.ok(completedIntent.events.length >= 6, "append-only events should be recorded");

  const secondIntentId = store.submitIntent({
    principal: "did:aimtp:user.bob",
    goal: "Investigate production incident"
  });
  const failedTask = store.enqueueTask({
    intent_id: secondIntentId,
    type: "classify",
    input: { goal: "Investigate production incident" }
  });
  const failedClaim = store.claimTask(failedTask, "did:aimtp:agent.worker-2");
  assert.strictEqual(failedClaim.ok, true);
  const failResult = store.completeTask(failedTask, {
    agent_id: "did:aimtp:agent.worker-2",
    status: "failed",
    error: "tool_error"
  });
  assert.strictEqual(failResult.ok, true);
  assert.strictEqual(failResult.status, "failed");

  const failedIntent = store.getIntent(secondIntentId);
  assert.ok(failedIntent);
  assert.strictEqual(failedIntent.intent.status, "failed");

  console.log("OK: intentos store tests");
}

main();
