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
  assert.strictEqual(sqlite.poll("agent-a", 1)[0].id, "env-001");
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
  assert.strictEqual(polled[0].id, "env-redis-fallback");
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

  console.log("OK: mailbox store tests");
}

main();
