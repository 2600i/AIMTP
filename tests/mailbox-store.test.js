"use strict";

const assert = require("assert");
const os = require("os");
const path = require("path");
const fs = require("fs");
const {
  createMailboxStore,
  parseMailboxStoreType,
  RedisMailboxStore,
  SQLiteMailboxStore,
  InMemoryMailboxStore
} = require("../runtime/mailbox");

function main() {
  assert.strictEqual(parseMailboxStoreType("sqlite"), "sqlite");
  assert.strictEqual(parseMailboxStoreType("redis"), "redis");
  assert.strictEqual(parseMailboxStoreType("memory"), "memory");
  assert.strictEqual(parseMailboxStoreType(""), "sqlite");

  const memory = createMailboxStore({ type: "memory" });
  assert.ok(memory instanceof InMemoryMailboxStore);

  const sqlitePath = path.join(
    os.tmpdir(),
    `aimtp-mailbox-test-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`
  );
  const sqlite = createMailboxStore({ type: "sqlite", sqlitePath });
  assert.ok(sqlite instanceof SQLiteMailboxStore);
  sqlite.enqueue("agent-a", { id: "env-001" });
  assert.strictEqual(sqlite.peek("agent-a").count, 1);
  const sqliteLease = sqlite.poll("agent-a", 1)[0];
  assert.strictEqual(sqliteLease.envelope.id, "env-001");
  sqlite.ack("agent-a", sqliteLease.leaseId);
  if (typeof sqlite.close === "function") {
    sqlite.close();
  }
  fs.rmSync(sqlitePath, { force: true });

  const fallbackPath = path.join(
    os.tmpdir(),
    `aimtp-mailbox-fallback-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`
  );
  const logs = [];
  const fallback = createMailboxStore({
    type: "redis",
    redisHost: "127.0.0.1",
    redisPort: 1,
    redisCommandTimeoutMs: 200,
    sqlitePath: fallbackPath,
    logger: { log: (line) => logs.push(line) }
  });
  assert.ok(
    fallback instanceof SQLiteMailboxStore,
    "redis unavailable should gracefully fallback to sqlite"
  );
  assert.ok(logs.some((line) => line.includes("mailbox_store_fallback from=redis to=sqlite")));

  fallback.enqueue("agent-b", { id: "env-redis-fallback" });
  const polled = fallback.poll("agent-b", 1);
  assert.strictEqual(polled.length, 1);
  assert.strictEqual(polled[0].envelope.id, "env-redis-fallback");
  fallback.ack("agent-b", polled[0].leaseId);
  if (typeof fallback.close === "function") {
    fallback.close();
  }
  fs.rmSync(fallbackPath, { force: true });

  let redisUsable = true;
  try {
    const redis = new RedisMailboxStore({ redisCommandTimeoutMs: 200 });
    redis.close && redis.close();
  } catch (_err) {
    redisUsable = false;
  }

  if (redisUsable) {
    const redisStore = createMailboxStore({ type: "redis", redisCommandTimeoutMs: 200 });
    assert.ok(redisStore instanceof RedisMailboxStore);
  }

  let now = 0;
  const leasing = createMailboxStore({
    type: "memory",
    now: () => now,
    leaseMs: 1000,
    maxRetries: 2,
    retryBaseMs: 1000,
    retryMaxMs: 1000
  });
  leasing.enqueue("agent-c", { id: "env-lease" });
  const lease1 = leasing.poll("agent-c", 1)[0];
  assert.strictEqual(lease1.deliveryAttempt, 1);
  const fail1 = leasing.fail("agent-c", lease1.leaseId, "boom");
  assert.strictEqual(fail1.status, "requeued");
  const immediate = leasing.poll("agent-c", 1);
  assert.strictEqual(immediate.length, 0);
  now += 1000;
  const lease2 = leasing.poll("agent-c", 1)[0];
  assert.strictEqual(lease2.deliveryAttempt, 2);
  const ack2 = leasing.ack("agent-c", lease2.leaseId);
  assert.strictEqual(ack2.status, "acknowledged");

  let now2 = 0;
  const expiring = createMailboxStore({
    type: "memory",
    now: () => now2,
    leaseMs: 500,
    maxRetries: 1,
    retryBaseMs: 0,
    retryMaxMs: 0
  });
  expiring.enqueue("agent-d", { id: "env-expire" });
  const expLease = expiring.poll("agent-d", 1)[0];
  now2 += 1000;
  const expLease2 = expiring.poll("agent-d", 1)[0];
  assert.strictEqual(expLease2.deliveryAttempt, 2);
  const fail2 = expiring.fail("agent-d", expLease2.leaseId, "boom");
  assert.strictEqual(fail2.status, "dead_lettered");
  const dead = expiring.pollDeadLetters("agent-d", 1);
  assert.strictEqual(dead.length, 1);
  assert.strictEqual(dead[0].envelope.id, "env-expire");

  console.log("OK: mailbox store tests");
}

main();
