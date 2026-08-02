"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  InMemoryIntentStore,
  SQLiteIntentStore,
  createIntentStore,
  parseIntentStoreType,
  projectEnvelope
} = require("../runtime/intentos/intent-store");

const REQUEST_ENVELOPE = {
  spec: "aimtp/0.1",
  id: "env-req-1",
  timestamp: "2026-08-02T12:30:00Z",
  sender: "agent-a",
  recipient: "agent-b",
  intent: "task.request",
  message: { id: "m1", role: "user", content: "Summarize the Q3 pipeline" },
  task: { kind: "request", id: "task-001", input: { q: "Q3" } },
  metadata: { aimtp: { thread_id: "task-task-001" } }
};

const RESPONSE_ENVELOPE = {
  spec: "aimtp/0.1",
  id: "env-resp-1",
  timestamp: "2026-08-02T12:31:00Z",
  sender: "agent-b",
  recipient: "agent-a",
  intent: "task.response",
  message: { id: "m2", role: "assistant", content: "Pipeline summary ready" },
  task: {
    kind: "response",
    id: "task-001-resp-001",
    in_response_to: "task-001",
    status: "succeeded"
  },
  metadata: { aimtp: { thread_id: "task-task-001" } }
};

function testProjection() {
  const request = projectEnvelope(REQUEST_ENVELOPE, 1000);
  assert.strictEqual(request.intentId, "task-task-001", "thread_id keys the intent");
  assert.strictEqual(request.status, "in_progress");
  assert.strictEqual(request.goal, "Summarize the Q3 pipeline");
  assert.strictEqual(request.task.id, "task-001");
  assert.strictEqual(request.task.status, "requested");

  const response = projectEnvelope(RESPONSE_ENVELOPE, 2000);
  assert.strictEqual(response.intentId, "task-task-001", "response joins the same intent");
  assert.strictEqual(response.status, "succeeded");
  assert.strictEqual(response.task.id, "task-001", "response collapses onto the request task");

  const withoutThread = projectEnvelope({ id: "env-only" }, 3000);
  assert.strictEqual(withoutThread.intentId, "env-only", "falls back to envelope id");

  assert.strictEqual(projectEnvelope(null, 0), null);
  assert.strictEqual(projectEnvelope({}, 0), null, "an envelope with no id is skipped");
  assert.strictEqual(projectEnvelope("nope", 0), null);
}

function testStoreBehavior(label, store) {
  store.recordEnvelope(REQUEST_ENVELOPE);
  store.recordEnvelope(RESPONSE_ENVELOPE);

  const intents = store.listIntents();
  assert.strictEqual(intents.length, 1, `${label}: request and response share one intent`);
  assert.strictEqual(intents[0].id, "task-task-001");
  assert.strictEqual(intents[0].status, "succeeded", `${label}: response advances status`);
  assert.strictEqual(intents[0].goal, "Summarize the Q3 pipeline");
  assert.ok(
    !Number.isNaN(Date.parse(intents[0].created_at)),
    `${label}: created_at parses as a date`
  );

  const tasks = store.listTasks();
  assert.strictEqual(tasks.length, 1, `${label}: one task row per unit of work`);
  assert.strictEqual(tasks[0].id, "task-001");
  assert.strictEqual(tasks[0].status, "succeeded");
  assert.strictEqual(tasks[0].intent_id, "task-task-001");
  assert.strictEqual(tasks[0].assigned_to, "agent-b");

  const detail = store.getIntent("task-task-001");
  assert.ok(detail, `${label}: intent detail is retrievable`);
  assert.strictEqual(detail.events.length, 2, `${label}: both envelopes recorded as events`);
  assert.strictEqual(detail.events[0].type, "task.request");
  assert.strictEqual(detail.events[0].envelope_id, "env-req-1");
  assert.strictEqual(detail.events[1].type, "task.response");
  assert.strictEqual(detail.events[1].status, "succeeded");

  assert.strictEqual(store.getIntent("missing"), null, `${label}: unknown intent returns null`);

  // Payloads with no usable id must not create phantom intents.
  store.recordEnvelope({ text: "raw mailbox payload" });
  assert.strictEqual(store.listIntents().length, 1, `${label}: id-less payloads are skipped`);
}

function testPruning() {
  const store = new InMemoryIntentStore({ maxIntents: 2 });
  for (let index = 0; index < 5; index += 1) {
    store.recordEnvelope({
      id: `env-${index}`,
      timestamp: new Date(1000 + index * 1000).toISOString(),
      sender: "agent-a",
      recipient: "agent-b",
      message: { content: `msg ${index}` }
    });
  }
  const intents = store.listIntents();
  assert.strictEqual(intents.length, 2, "pruning caps stored intents");
  assert.strictEqual(intents[0].id, "env-4", "newest intent is retained");
  assert.strictEqual(store.getIntent("env-0"), null, "oldest intent is evicted");
}

function testStoreTypeParsing() {
  assert.strictEqual(parseIntentStoreType("memory"), "memory");
  assert.strictEqual(parseIntentStoreType("sqlite"), "sqlite");
  assert.strictEqual(parseIntentStoreType(undefined), "sqlite");
  assert.strictEqual(
    parseIntentStoreType("redis"),
    "memory",
    "redis mailboxes keep the IntentOS projection local"
  );
}

function main() {
  testProjection();
  testStoreBehavior("memory", new InMemoryIntentStore());

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimtp-intentos-"));
  const sqlitePath = path.join(dir, "intentos.sqlite");
  const sqliteStore = new SQLiteIntentStore({ sqlitePath });
  try {
    testStoreBehavior("sqlite", sqliteStore);

    // Records must survive a reopen of the same file.
    sqliteStore.close();
    const reopened = new SQLiteIntentStore({ sqlitePath });
    try {
      const intents = reopened.listIntents();
      assert.strictEqual(intents.length, 1, "sqlite: intents persist across restarts");
      assert.strictEqual(intents[0].status, "succeeded");
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const memoryStore = createIntentStore({ type: "memory" });
  assert.ok(memoryStore instanceof InMemoryIntentStore, "factory honors the memory type");
  memoryStore.close();

  testPruning();
  testStoreTypeParsing();

  console.log("OK: intentos intent store tests");
}

main();
