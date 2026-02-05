"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_QUEUE_LENGTH = 100;
const DEFAULT_MAX_RECIPIENTS = 1000;
const DEFAULT_SQLITE_PATH = path.join(process.cwd(), "runtime", "aimtp-mailbox.sqlite");
const DEFAULT_REDIS_CLI_PATH = "redis-cli";
const DEFAULT_REDIS_HOST = "127.0.0.1";
const DEFAULT_REDIS_PORT = 6379;
const DEFAULT_REDIS_DB = 0;
const DEFAULT_REDIS_KEY_PREFIX = "aimtp:mailbox:";
const DEFAULT_REDIS_TIMEOUT_MS = 1000;

const SQLITE_MAILBOX_SCHEMA = `
CREATE TABLE IF NOT EXISTS mailbox_recipients (
  recipient TEXT PRIMARY KEY,
  last_activity INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mailbox_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL,
  FOREIGN KEY(recipient) REFERENCES mailbox_recipients(recipient) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mailbox_messages_recipient_id
  ON mailbox_messages(recipient, id);

CREATE INDEX IF NOT EXISTS idx_mailbox_messages_enqueued_at
  ON mailbox_messages(enqueued_at);
`;

function parsePositiveInt(value, fallback) {
  if (typeof value !== "number") {
    return fallback;
  }
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function buildRedisDisplayUrl(options) {
  if (options.redisUrl && options.redisUrl.trim()) {
    return options.redisUrl.trim();
  }
  const host = (options.redisHost && options.redisHost.trim()) || DEFAULT_REDIS_HOST;
  const port = parsePositiveInt(options.redisPort, DEFAULT_REDIS_PORT);
  const db = parsePositiveInt(options.redisDb, DEFAULT_REDIS_DB);
  return `redis://${host}:${port}/${db}`;
}

function loadSQLiteDatabaseConstructor() {
  try {
    const sqlite = require("node:sqlite");
    if (typeof sqlite.DatabaseSync === "function") {
      return sqlite.DatabaseSync;
    }
  } catch (_err) {
    // Fall through.
  }

  try {
    const betterSqlite3 = require("better-sqlite3");
    if (typeof betterSqlite3 === "function") {
      return betterSqlite3;
    }
  } catch (_err) {
    // No compatible SQLite driver found.
  }

  throw new Error(
    "SQLite mailbox store unavailable: install better-sqlite3 or run on a Node.js runtime with node:sqlite"
  );
}

class InMemoryMailboxStore {
  constructor(options = {}) {
    this.ttlMs = parsePositiveInt(options.ttlMs, DEFAULT_TTL_MS);
    this.maxQueueLength = parsePositiveInt(options.maxQueueLength, DEFAULT_MAX_QUEUE_LENGTH);
    this.maxRecipients = parsePositiveInt(options.maxRecipients, DEFAULT_MAX_RECIPIENTS);
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.logger = options.logger || null;
    this.mailboxes = new Map();
  }

  enqueue(recipient, envelope) {
    const now = this.now();
    let mailbox = this.mailboxes.get(recipient);
    if (!mailbox) {
      mailbox = { queue: [], lastActivity: now };
      this.mailboxes.set(recipient, mailbox);
    }

    this.purgeExpired(mailbox, now);
    mailbox.queue.push({ envelope, enqueuedAt: now });
    mailbox.lastActivity = now;

    let dropped = 0;
    while (mailbox.queue.length > this.maxQueueLength) {
      mailbox.queue.shift();
      dropped += 1;
    }

    if (dropped > 0) {
      this.logDropOldest(recipient, dropped, mailbox.queue.length);
    }

    this.ensureRecipientLimit();

    return { queueDepth: mailbox.queue.length, dropped };
  }

  peek(recipient) {
    const mailbox = this.mailboxes.get(recipient);
    if (!mailbox) {
      return { count: 0 };
    }
    const now = this.now();
    this.purgeExpired(mailbox, now);
    if (mailbox.queue.length === 0) {
      this.mailboxes.delete(recipient);
      return { count: 0 };
    }
    mailbox.lastActivity = now;
    return { count: mailbox.queue.length };
  }

  poll(recipient, maxItems) {
    const mailbox = this.mailboxes.get(recipient);
    if (!mailbox) {
      return [];
    }
    const now = this.now();
    this.purgeExpired(mailbox, now);

    const count = Math.min(Math.max(0, maxItems), mailbox.queue.length);
    const items = [];
    for (let i = 0; i < count; i += 1) {
      const entry = mailbox.queue.shift();
      if (entry) {
        items.push(entry.envelope);
      }
    }

    if (mailbox.queue.length === 0) {
      this.mailboxes.delete(recipient);
    } else {
      mailbox.lastActivity = now;
    }

    return items;
  }

  cleanupExpired() {
    const now = this.now();
    let removed = 0;
    for (const [recipient, mailbox] of this.mailboxes.entries()) {
      const before = mailbox.queue.length;
      this.purgeExpired(mailbox, now);
      removed += before - mailbox.queue.length;
      if (mailbox.queue.length === 0) {
        this.mailboxes.delete(recipient);
      }
    }
    return removed;
  }

  purgeExpired(mailbox, now) {
    while (mailbox.queue.length > 0) {
      const entry = mailbox.queue[0];
      if (now - entry.enqueuedAt < this.ttlMs) {
        break;
      }
      mailbox.queue.shift();
    }
  }

  ensureRecipientLimit() {
    if (this.mailboxes.size <= this.maxRecipients) {
      return;
    }

    for (const [recipient, mailbox] of this.mailboxes.entries()) {
      if (mailbox.queue.length === 0) {
        this.mailboxes.delete(recipient);
      }
    }

    if (this.mailboxes.size <= this.maxRecipients) {
      return;
    }

    const entries = Array.from(this.mailboxes.entries()).sort(
      (a, b) => a[1].lastActivity - b[1].lastActivity
    );

    for (const [recipient] of entries) {
      if (this.mailboxes.size <= this.maxRecipients) {
        break;
      }
      this.mailboxes.delete(recipient);
    }
  }

  logDropOldest(recipient, dropped, queueDepth) {
    if (!this.logger || typeof this.logger.log !== "function") {
      return;
    }
    this.logger.log(
      `mailbox_drop_oldest recipient=${recipient} dropped=${dropped} queue_depth=${queueDepth}`
    );
  }
}

class Mailbox extends InMemoryMailboxStore {
  constructor(options = {}) {
    super(options);
  }
}

class SQLiteMailboxStore {
  constructor(options = {}) {
    this.ttlMs = parsePositiveInt(options.ttlMs, DEFAULT_TTL_MS);
    this.maxQueueLength = parsePositiveInt(options.maxQueueLength, DEFAULT_MAX_QUEUE_LENGTH);
    this.maxRecipients = parsePositiveInt(options.maxRecipients, DEFAULT_MAX_RECIPIENTS);
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.logger = options.logger || null;

    const sqlitePath = options.sqlitePath && options.sqlitePath.trim()
      ? options.sqlitePath.trim()
      : DEFAULT_SQLITE_PATH;
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });

    const SQLiteDatabaseCtor = loadSQLiteDatabaseConstructor();
    this.db = new SQLiteDatabaseCtor(sqlitePath);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SQLITE_MAILBOX_SCHEMA);

    this.selectRecipientCountStatement = this.db.prepare(
      "SELECT COUNT(*) AS count FROM mailbox_recipients"
    );
    this.selectMessageCountByRecipientStatement = this.db.prepare(
      "SELECT COUNT(*) AS count FROM mailbox_messages WHERE recipient = ?"
    );
    this.insertRecipientStatement = this.db.prepare(
      "INSERT INTO mailbox_recipients(recipient, last_activity) VALUES(?, ?) ON CONFLICT(recipient) DO UPDATE SET last_activity = excluded.last_activity"
    );
    this.insertMessageStatement = this.db.prepare(
      "INSERT INTO mailbox_messages(recipient, envelope_json, enqueued_at) VALUES(?, ?, ?)"
    );
    this.deleteOldestByRecipientStatement = this.db.prepare(
      "DELETE FROM mailbox_messages WHERE id IN (SELECT id FROM mailbox_messages WHERE recipient = ? ORDER BY id ASC LIMIT ?)"
    );
    this.deleteEmptyRecipientsStatement = this.db.prepare(
      "DELETE FROM mailbox_recipients WHERE recipient NOT IN (SELECT DISTINCT recipient FROM mailbox_messages)"
    );
    this.selectOldestRecipientsStatement = this.db.prepare(
      "SELECT recipient FROM mailbox_recipients ORDER BY last_activity ASC LIMIT ?"
    );
    this.deleteMessagesForRecipientStatement = this.db.prepare(
      "DELETE FROM mailbox_messages WHERE recipient = ?"
    );
    this.deleteRecipientStatement = this.db.prepare(
      "DELETE FROM mailbox_recipients WHERE recipient = ?"
    );
    this.updateRecipientActivityStatement = this.db.prepare(
      "UPDATE mailbox_recipients SET last_activity = ? WHERE recipient = ?"
    );
    this.selectPollItemsStatement = this.db.prepare(
      "SELECT id, envelope_json FROM mailbox_messages WHERE recipient = ? ORDER BY id ASC LIMIT ?"
    );
    this.deleteExpiredMessagesStatement = this.db.prepare(
      "DELETE FROM mailbox_messages WHERE enqueued_at <= ?"
    );
  }

  enqueue(recipient, envelope) {
    const now = this.now();
    return this.withTransaction(() => {
      this.purgeExpiredInternal(now);

      this.insertRecipientStatement.run(recipient, now);
      this.insertMessageStatement.run(recipient, JSON.stringify(envelope), now);

      const queueDepthRaw = this.selectCountForRecipient(recipient);
      let queueDepth = queueDepthRaw;
      let dropped = 0;

      if (queueDepthRaw > this.maxQueueLength) {
        dropped = queueDepthRaw - this.maxQueueLength;
        this.deleteOldestByRecipientStatement.run(recipient, dropped);
        queueDepth = this.maxQueueLength;
        this.logDropOldest(recipient, dropped, queueDepth);
      }

      this.ensureRecipientLimitInternal();

      return { queueDepth, dropped };
    });
  }

  peek(recipient) {
    const now = this.now();
    return this.withTransaction(() => {
      this.purgeExpiredInternal(now);

      const count = this.selectCountForRecipient(recipient);
      if (count === 0) {
        this.deleteRecipientStatement.run(recipient);
        return { count: 0 };
      }

      this.updateRecipientActivityStatement.run(now, recipient);
      return { count };
    });
  }

  poll(recipient, maxItems) {
    const boundedMax = Math.max(0, maxItems);
    if (boundedMax === 0) {
      return [];
    }

    const now = this.now();
    return this.withTransaction(() => {
      this.purgeExpiredInternal(now);

      const rows = this.selectPollItemsStatement.all(recipient, boundedMax);
      if (rows.length === 0) {
        this.deleteRecipientStatement.run(recipient);
        return [];
      }

      const ids = [];
      const items = [];
      rows.forEach((row) => {
        const id = Number(row.id);
        if (Number.isFinite(id)) {
          ids.push(id);
        }
        const envelopeJson = typeof row.envelope_json === "string" ? row.envelope_json : "";
        if (!envelopeJson) {
          return;
        }
        try {
          items.push(JSON.parse(envelopeJson));
        } catch (_err) {
          // Corrupt payloads are dropped during poll.
        }
      });

      this.deleteMessageIds(ids);

      const remaining = this.selectCountForRecipient(recipient);
      if (remaining === 0) {
        this.deleteRecipientStatement.run(recipient);
      } else {
        this.updateRecipientActivityStatement.run(now, recipient);
      }

      return items;
    });
  }

  cleanupExpired() {
    const now = this.now();
    return this.withTransaction(() => this.purgeExpiredInternal(now));
  }

  close() {
    if (typeof this.db.close === "function") {
      this.db.close();
    }
  }

  purgeExpiredInternal(now) {
    const cutoff = now - this.ttlMs;
    const result = this.deleteExpiredMessagesStatement.run(cutoff);
    this.deleteEmptyRecipientsStatement.run();
    return Number((result && result.changes) || 0);
  }

  ensureRecipientLimitInternal() {
    this.deleteEmptyRecipientsStatement.run();

    const currentCount = Number((this.selectRecipientCountStatement.get() || {}).count || 0);
    if (currentCount <= this.maxRecipients) {
      return;
    }

    const overflow = currentCount - this.maxRecipients;
    const rows = this.selectOldestRecipientsStatement.all(overflow);

    rows.forEach((row) => {
      const recipient = typeof row.recipient === "string" ? row.recipient : "";
      if (!recipient) {
        return;
      }
      this.deleteMessagesForRecipientStatement.run(recipient);
      this.deleteRecipientStatement.run(recipient);
    });
  }

  selectCountForRecipient(recipient) {
    const row = this.selectMessageCountByRecipientStatement.get(recipient);
    return Number((row || {}).count || 0);
  }

  deleteMessageIds(ids) {
    if (ids.length === 0) {
      return;
    }
    const placeholders = ids.map(() => "?").join(",");
    const statement = this.db.prepare(
      `DELETE FROM mailbox_messages WHERE id IN (${placeholders})`
    );
    statement.run(...ids);
  }

  withTransaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch (_rollbackErr) {
        // Ignore rollback failures.
      }
      throw err;
    }
  }

  logDropOldest(recipient, dropped, queueDepth) {
    if (!this.logger || typeof this.logger.log !== "function") {
      return;
    }
    this.logger.log(
      `mailbox_drop_oldest recipient=${recipient} dropped=${dropped} queue_depth=${queueDepth}`
    );
  }
}

class RedisMailboxStore {
  constructor(options = {}) {
    this.ttlMs = parsePositiveInt(options.ttlMs, DEFAULT_TTL_MS);
    this.maxQueueLength = parsePositiveInt(options.maxQueueLength, DEFAULT_MAX_QUEUE_LENGTH);
    this.maxRecipients = parsePositiveInt(options.maxRecipients, DEFAULT_MAX_RECIPIENTS);
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.logger = options.logger || null;

    this.redisCliPath = (options.redisCliPath && options.redisCliPath.trim()) || DEFAULT_REDIS_CLI_PATH;
    this.redisUrl = (options.redisUrl && options.redisUrl.trim()) || "";
    this.redisHost = (options.redisHost && options.redisHost.trim()) || DEFAULT_REDIS_HOST;
    this.redisPort = parsePositiveInt(options.redisPort, DEFAULT_REDIS_PORT);
    this.redisDb = parsePositiveInt(options.redisDb, DEFAULT_REDIS_DB);
    this.redisUsername = (options.redisUsername && options.redisUsername.trim()) || "";
    this.redisPassword = (options.redisPassword && options.redisPassword.trim()) || "";
    this.redisKeyPrefix = (options.redisKeyPrefix && options.redisKeyPrefix.trim()) || DEFAULT_REDIS_KEY_PREFIX;
    this.redisCommandTimeoutMs = parsePositiveInt(options.redisCommandTimeoutMs, DEFAULT_REDIS_TIMEOUT_MS);

    const pong = this.runRedis(["PING"]);
    if (pong.trim().toUpperCase() !== "PONG") {
      throw new Error("Redis ping failed");
    }
  }

  enqueue(recipient, envelope) {
    const now = this.now();
    const key = this.queueKey(recipient);
    const ttlSeconds = this.ttlSeconds();

    this.purgeExpiredForRecipient(recipient, now);

    const before = this.readInteger(["LLEN", key]);
    const payload = `${now}|${JSON.stringify(envelope)}`;
    this.runRedis(["RPUSH", key, payload]);

    let queueDepth = before + 1;
    let dropped = 0;

    if (queueDepth > this.maxQueueLength) {
      dropped = queueDepth - this.maxQueueLength;
      this.runRedis(["LTRIM", key, String(-this.maxQueueLength), String(-1)]);
      queueDepth = this.maxQueueLength;
      this.logDropOldest(recipient, dropped, queueDepth);
    }

    this.runRedis(["EXPIRE", key, String(ttlSeconds)]);
    this.touchRecipient(recipient, now);
    this.enforceRecipientLimit();

    return { queueDepth, dropped };
  }

  peek(recipient) {
    const now = this.now();
    this.purgeExpiredForRecipient(recipient, now);

    const key = this.queueKey(recipient);
    const count = this.readInteger(["LLEN", key]);

    if (count === 0) {
      this.runRedis(["DEL", key]);
      this.removeRecipient(recipient);
      return { count: 0 };
    }

    this.runRedis(["EXPIRE", key, String(this.ttlSeconds())]);
    this.touchRecipient(recipient, now);
    return { count };
  }

  poll(recipient, maxItems) {
    const boundedMax = Math.max(0, maxItems);
    if (boundedMax === 0) {
      return [];
    }

    const now = this.now();
    this.purgeExpiredForRecipient(recipient, now);

    const key = this.queueKey(recipient);
    const items = [];

    for (let i = 0; i < boundedMax; i += 1) {
      const popped = this.runRedis(["LPOP", key]).trim();
      if (!popped) {
        break;
      }
      const separator = popped.indexOf("|");
      if (separator < 0) {
        continue;
      }
      const envelopeJson = popped.slice(separator + 1);
      if (!envelopeJson) {
        continue;
      }
      try {
        items.push(JSON.parse(envelopeJson));
      } catch (_err) {
        // Drop corrupt payloads.
      }
    }

    const remaining = this.readInteger(["LLEN", key]);
    if (remaining === 0) {
      this.runRedis(["DEL", key]);
      this.removeRecipient(recipient);
    } else {
      this.runRedis(["EXPIRE", key, String(this.ttlSeconds())]);
      this.touchRecipient(recipient, now);
    }

    return items;
  }

  cleanupExpired() {
    const now = this.now();
    const recipients = this.readList(["ZRANGE", this.recipientsKey(), "0", "-1"]);
    let removed = 0;
    recipients.forEach((recipient) => {
      if (!recipient) {
        return;
      }
      removed += this.purgeExpiredForRecipient(recipient, now);
    });
    return removed;
  }

  ttlSeconds() {
    return Math.max(1, Math.ceil(this.ttlMs / 1000));
  }

  queueKey(recipient) {
    return `${this.redisKeyPrefix}${recipient}`;
  }

  recipientsKey() {
    return `${this.redisKeyPrefix}__recipients`;
  }

  touchRecipient(recipient, now) {
    this.runRedis(["ZADD", this.recipientsKey(), String(now), recipient]);
  }

  removeRecipient(recipient) {
    this.runRedis(["ZREM", this.recipientsKey(), recipient]);
  }

  enforceRecipientLimit() {
    const recipientsKey = this.recipientsKey();
    const count = this.readInteger(["ZCARD", recipientsKey]);
    if (count <= this.maxRecipients) {
      return;
    }

    const overflow = count - this.maxRecipients;
    const evicted = this.readList([
      "ZRANGE",
      recipientsKey,
      "0",
      String(Math.max(0, overflow - 1))
    ]);
    evicted.forEach((recipient) => {
      if (!recipient) {
        return;
      }
      this.runRedis(["DEL", this.queueKey(recipient)]);
      this.removeRecipient(recipient);
    });
  }

  purgeExpiredForRecipient(recipient, now) {
    const key = this.queueKey(recipient);
    let removed = 0;

    while (true) {
      const head = this.runRedis(["LINDEX", key, "0"]).trim();
      if (!head) {
        break;
      }
      const separator = head.indexOf("|");
      if (separator < 0) {
        this.runRedis(["LPOP", key]);
        removed += 1;
        continue;
      }
      const enqueuedAt = Number.parseInt(head.slice(0, separator), 10);
      if (!Number.isFinite(enqueuedAt)) {
        this.runRedis(["LPOP", key]);
        removed += 1;
        continue;
      }
      if (now - enqueuedAt < this.ttlMs) {
        break;
      }
      this.runRedis(["LPOP", key]);
      removed += 1;
    }

    if (this.readInteger(["LLEN", key]) === 0) {
      this.runRedis(["DEL", key]);
      this.removeRecipient(recipient);
    }

    return removed;
  }

  readInteger(args) {
    const output = this.runRedis(args).trim();
    if (!output) {
      return 0;
    }
    const parsed = Number.parseInt(output, 10);
    if (!Number.isFinite(parsed)) {
      return 0;
    }
    return parsed;
  }

  readList(args) {
    const output = this.runRedis(args).trim();
    if (!output) {
      return [];
    }
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  runRedis(args) {
    const connectionArgs = ["--raw"];

    if (this.redisUrl) {
      connectionArgs.push("-u", this.redisUrl);
    } else {
      connectionArgs.push("-h", this.redisHost, "-p", String(this.redisPort));
      connectionArgs.push("-n", String(this.redisDb));
      if (this.redisUsername) {
        connectionArgs.push("--user", this.redisUsername);
      }
      if (this.redisPassword) {
        connectionArgs.push("-a", this.redisPassword);
      }
    }

    try {
      return execFileSync(this.redisCliPath, [...connectionArgs, ...args], {
        encoding: "utf8",
        timeout: this.redisCommandTimeoutMs
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Redis command failed (${args[0]}): ${reason}`);
    }
  }

  logDropOldest(recipient, dropped, queueDepth) {
    if (!this.logger || typeof this.logger.log !== "function") {
      return;
    }
    this.logger.log(
      `mailbox_drop_oldest recipient=${recipient} dropped=${dropped} queue_depth=${queueDepth}`
    );
  }
}

function parseMailboxStoreType(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "memory") {
    return "memory";
  }
  if (normalized === "redis") {
    return "redis";
  }
  return "sqlite";
}

function createMailboxStore(options = {}) {
  if (options.type === "memory") {
    return new InMemoryMailboxStore(options);
  }
  if (options.type === "redis") {
    const logger = options.logger || null;
    if (logger && typeof logger.log === "function") {
      logger.log(`Connecting to Redis at ${buildRedisDisplayUrl(options)}`);
    }
    try {
      return new RedisMailboxStore(options);
    } catch (err) {
      if (logger && typeof logger.log === "function") {
        const message = err instanceof Error ? err.message : String(err);
        logger.log(`mailbox_store_fallback from=redis to=sqlite reason=${message}`);
      }
      return new SQLiteMailboxStore(options);
    }
  }
  return new SQLiteMailboxStore(options);
}

module.exports = {
  Mailbox,
  InMemoryMailboxStore,
  SQLiteMailboxStore,
  RedisMailboxStore,
  SQLITE_MAILBOX_SCHEMA,
  createMailboxStore,
  parseMailboxStoreType
};
