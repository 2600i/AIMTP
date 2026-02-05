import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { randomBytes, randomUUID } from "crypto";

export type MailboxLogger = { log: (message: string) => void } | null;

export type MailboxOptions = {
  ttlMs?: number;
  maxQueueLength?: number;
  maxRecipients?: number;
  leaseMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  now?: () => number;
  logger?: MailboxLogger;
};

export type SQLiteMailboxStoreOptions = MailboxOptions & {
  sqlitePath?: string;
};

export type RedisMailboxStoreOptions = MailboxOptions & {
  redisUrl?: string;
  redisHost?: string;
  redisPort?: number;
  redisDb?: number;
  redisUsername?: string;
  redisPassword?: string;
  redisKeyPrefix?: string;
  redisCliPath?: string;
  redisCommandTimeoutMs?: number;
};

export type MailboxStoreType = "memory" | "sqlite" | "redis";

export type MailboxStoreEnqueueResult = { queueDepth: number; dropped: number };

export type MailboxStorePeekResult = {
  count: number;
  pending: number;
  leased: number;
  deadLetters: number;
};

export type MailboxLeaseItem = {
  envelope: unknown;
  leaseId: string;
  leaseExpiresAt: number;
  retryCount: number;
  deliveryAttempt: number;
};

export type MailboxAckResult = {
  ok: boolean;
  status: "acknowledged" | "unknown_lease" | "expired";
};

export type MailboxFailResult = {
  ok: boolean;
  status: "requeued" | "dead_lettered" | "unknown_lease" | "expired";
  retryCount?: number;
};

export type MailboxDeadLetter = {
  envelope: unknown;
  enqueuedAt: number;
  failedAt: number;
  retryCount: number;
  deliveryAttempt: number;
  lastError?: string;
};

export interface MailboxStore {
  enqueue(recipient: string, envelope: unknown): MailboxStoreEnqueueResult;
  peek(recipient: string): MailboxStorePeekResult;
  poll(recipient: string, maxItems: number): MailboxLeaseItem[];
  ack(recipient: string, leaseId: string): MailboxAckResult;
  fail(recipient: string, leaseId: string, reason?: string): MailboxFailResult;
  pollDeadLetters(recipient: string, maxItems: number): MailboxDeadLetter[];
  cleanupExpired?(): number;
  close?(): void;
}

type MailboxEntry = {
  id: string;
  envelope: unknown;
  enqueuedAt: number;
  availableAt: number;
  leaseId: string | null;
  leaseUntil: number;
  attempts: number;
  status: "pending" | "leased";
};

type MailboxDeadLetterEntry = {
  envelope: unknown;
  enqueuedAt: number;
  failedAt: number;
  attempts: number;
  lastError?: string;
};

type RecipientMailbox = {
  queue: MailboxEntry[];
  deadLetters: MailboxDeadLetterEntry[];
  lastActivity: number;
};

type SQLiteStatementResult = {
  changes?: number;
  lastInsertRowid?: number | bigint;
};

type SQLiteStatement = {
  run: (...params: any[]) => SQLiteStatementResult;
  get: (...params: any[]) => Record<string, unknown> | undefined;
  all: (...params: any[]) => Array<Record<string, unknown>>;
};

type SQLiteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => SQLiteStatement;
  close?: () => void;
};

type SQLiteDatabaseCtor = new (filename: string) => SQLiteDatabase;

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_QUEUE_LENGTH = 100;
const DEFAULT_MAX_RECIPIENTS = 1000;
const DEFAULT_LEASE_MS = 30 * 1000;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_BASE_MS = 1000;
const DEFAULT_RETRY_MAX_MS = 30 * 1000;
const DEFAULT_SQLITE_PATH = path.join(process.cwd(), "runtime", "aimtp-mailbox.sqlite");
const DEFAULT_REDIS_CLI_PATH = "redis-cli";
const DEFAULT_REDIS_HOST = "127.0.0.1";
const DEFAULT_REDIS_PORT = 6379;
const DEFAULT_REDIS_DB = 0;
const DEFAULT_REDIS_KEY_PREFIX = "aimtp:mailbox:";
const DEFAULT_REDIS_TIMEOUT_MS = 1000;

export const SQLITE_MAILBOX_SCHEMA = `
CREATE TABLE IF NOT EXISTS mailbox_recipients (
  recipient TEXT PRIMARY KEY,
  last_activity INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mailbox_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL,
  available_at INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  lease_id TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(recipient) REFERENCES mailbox_recipients(recipient) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mailbox_messages_recipient_id
  ON mailbox_messages(recipient, id);

CREATE INDEX IF NOT EXISTS idx_mailbox_messages_status_available
  ON mailbox_messages(status, available_at, id);

CREATE INDEX IF NOT EXISTS idx_mailbox_messages_lease_until
  ON mailbox_messages(status, lease_until);

CREATE INDEX IF NOT EXISTS idx_mailbox_messages_enqueued_at
  ON mailbox_messages(enqueued_at);

CREATE TABLE IF NOT EXISTS mailbox_dead_letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL,
  failed_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_mailbox_dead_letters_recipient_id
  ON mailbox_dead_letters(recipient, id);
`;

function parsePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number") {
    return fallback;
  }
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function parseNonNegativeInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number") {
    return fallback;
  }
  if (!Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}

function generateLeaseId(): string {
  try {
    return randomUUID();
  } catch (_err) {
    return randomBytes(16).toString("hex");
  }
}

function computeBackoffMs(attempts: number, baseMs: number, maxMs: number): number {
  const exponent = Math.max(0, attempts - 1);
  const raw = baseMs * Math.pow(2, exponent);
  return Math.min(maxMs, Math.max(0, Math.floor(raw)));
}

function buildRedisDisplayUrl(options: RedisMailboxStoreOptions): string {
  if (options.redisUrl && options.redisUrl.trim()) {
    return options.redisUrl.trim();
  }
  const host = options.redisHost?.trim() || DEFAULT_REDIS_HOST;
  const port = parsePositiveInt(options.redisPort, DEFAULT_REDIS_PORT);
  const db = parsePositiveInt(options.redisDb, DEFAULT_REDIS_DB);
  return `redis://${host}:${port}/${db}`;
}

function loadSQLiteDatabaseConstructor(): SQLiteDatabaseCtor {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sqlite = require("node:sqlite") as { DatabaseSync?: SQLiteDatabaseCtor };
    if (typeof sqlite.DatabaseSync === "function") {
      return sqlite.DatabaseSync;
    }
  } catch (_err) {
    // Fall through to better-sqlite3.
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const betterSqlite3 = require("better-sqlite3") as SQLiteDatabaseCtor;
    if (typeof betterSqlite3 === "function") {
      return betterSqlite3;
    }
  } catch (_err) {
    // No compatible SQLite backend available.
  }

  throw new Error(
    "SQLite mailbox store unavailable: install better-sqlite3 or run on a Node.js runtime with node:sqlite"
  );
}

export class InMemoryMailboxStore implements MailboxStore {
  private ttlMs: number;
  private maxQueueLength: number;
  private maxRecipients: number;
  private leaseMs: number;
  private maxRetries: number;
  private maxAttempts: number;
  private retryBaseMs: number;
  private retryMaxMs: number;
  private now: () => number;
  private logger: MailboxLogger;
  private mailboxes: Map<string, RecipientMailbox>;

  constructor(options: MailboxOptions = {}) {
    this.ttlMs = parsePositiveInt(options.ttlMs, DEFAULT_TTL_MS);
    this.maxQueueLength = parsePositiveInt(options.maxQueueLength, DEFAULT_MAX_QUEUE_LENGTH);
    this.maxRecipients = parsePositiveInt(options.maxRecipients, DEFAULT_MAX_RECIPIENTS);
    this.leaseMs = parsePositiveInt(options.leaseMs, DEFAULT_LEASE_MS);
    this.maxRetries = parseNonNegativeInt(options.maxRetries, DEFAULT_MAX_RETRIES);
    this.maxAttempts = Math.max(1, this.maxRetries + 1);
    this.retryBaseMs = parseNonNegativeInt(options.retryBaseMs, DEFAULT_RETRY_BASE_MS);
    this.retryMaxMs = parseNonNegativeInt(options.retryMaxMs, DEFAULT_RETRY_MAX_MS);
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.logger = options.logger ?? null;
    this.mailboxes = new Map();
  }

  enqueue(recipient: string, envelope: unknown): MailboxStoreEnqueueResult {
    const now = this.now();
    let mailbox = this.mailboxes.get(recipient);
    if (!mailbox) {
      mailbox = { queue: [], deadLetters: [], lastActivity: now };
      this.mailboxes.set(recipient, mailbox);
    }

    this.purgeExpired(mailbox, now);
    mailbox.queue.push({
      id: generateLeaseId(),
      envelope,
      enqueuedAt: now,
      availableAt: now,
      leaseId: null,
      leaseUntil: 0,
      attempts: 0,
      status: "pending"
    });
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

  peek(recipient: string): MailboxStorePeekResult {
    const mailbox = this.mailboxes.get(recipient);
    if (!mailbox) {
      return { count: 0, pending: 0, leased: 0, deadLetters: 0 };
    }
    const now = this.now();
    this.requeueExpiredLeases(mailbox, now);
    this.purgeExpired(mailbox, now);
    if (mailbox.queue.length === 0) {
      if (mailbox.deadLetters.length === 0) {
        this.mailboxes.delete(recipient);
      }
      return {
        count: 0,
        pending: 0,
        leased: 0,
        deadLetters: mailbox.deadLetters.length
      };
    }
    mailbox.lastActivity = now;
    const { pending, leased } = this.countStates(mailbox);
    return {
      count: mailbox.queue.length,
      pending,
      leased,
      deadLetters: mailbox.deadLetters.length
    };
  }

  poll(recipient: string, maxItems: number): MailboxLeaseItem[] {
    const mailbox = this.mailboxes.get(recipient);
    if (!mailbox) {
      return [];
    }
    const now = this.now();
    this.requeueExpiredLeases(mailbox, now);
    this.purgeExpired(mailbox, now);

    const count = Math.min(Math.max(0, maxItems), mailbox.queue.length);
    const items: MailboxLeaseItem[] = [];
    if (count === 0) {
      return items;
    }
    let i = 0;
    while (i < mailbox.queue.length && items.length < count) {
      const entry = mailbox.queue[i];
      if (!entry || entry.status !== "pending" || entry.availableAt > now) {
        i += 1;
        continue;
      }
      if (entry.attempts >= this.maxAttempts) {
        this.moveToDeadLetter(mailbox, entry, "max_retries_exceeded");
        mailbox.queue.splice(i, 1);
        continue;
      }
      const leaseId = generateLeaseId();
      entry.status = "leased";
      entry.leaseId = leaseId;
      entry.leaseUntil = now + this.leaseMs;
      entry.attempts += 1;
      items.push({
        envelope: entry.envelope,
        leaseId,
        leaseExpiresAt: entry.leaseUntil,
        retryCount: Math.max(0, entry.attempts - 1),
        deliveryAttempt: entry.attempts
      });
      i += 1;
    }

    if (mailbox.queue.length === 0) {
      if (mailbox.deadLetters.length === 0) {
        this.mailboxes.delete(recipient);
      }
    } else {
      mailbox.lastActivity = now;
    }

    return items;
  }

  ack(recipient: string, leaseId: string): MailboxAckResult {
    const mailbox = this.mailboxes.get(recipient);
    if (!mailbox) {
      return { ok: false, status: "unknown_lease" };
    }
    const now = this.now();
    const entry = mailbox.queue.find((item) => item.leaseId === leaseId);
    if (!entry) {
      return { ok: false, status: "unknown_lease" };
    }
    if (entry.status !== "leased" || entry.leaseUntil <= now) {
      this.requeueExpiredLeases(mailbox, now);
      return { ok: false, status: "expired" };
    }
    const index = mailbox.queue.indexOf(entry);
    if (index >= 0) {
      mailbox.queue.splice(index, 1);
    }
    if (mailbox.queue.length === 0) {
      this.mailboxes.delete(recipient);
    } else {
      mailbox.lastActivity = now;
    }
    return { ok: true, status: "acknowledged" };
  }

  fail(recipient: string, leaseId: string, reason?: string): MailboxFailResult {
    const mailbox = this.mailboxes.get(recipient);
    if (!mailbox) {
      return { ok: false, status: "unknown_lease" };
    }
    const now = this.now();
    const entry = mailbox.queue.find((item) => item.leaseId === leaseId);
    if (!entry) {
      return { ok: false, status: "unknown_lease" };
    }
    if (entry.status !== "leased" || entry.leaseUntil <= now) {
      this.requeueExpiredLeases(mailbox, now);
      return { ok: false, status: "expired" };
    }
    entry.status = "pending";
    entry.leaseId = null;
    entry.leaseUntil = 0;
    if (entry.attempts >= this.maxAttempts) {
      this.moveToDeadLetter(mailbox, entry, reason);
      const index = mailbox.queue.indexOf(entry);
      if (index >= 0) {
        mailbox.queue.splice(index, 1);
      }
      return { ok: true, status: "dead_lettered", retryCount: Math.max(0, entry.attempts - 1) };
    }
    entry.availableAt = now + computeBackoffMs(entry.attempts, this.retryBaseMs, this.retryMaxMs);
    mailbox.lastActivity = now;
    return { ok: true, status: "requeued", retryCount: Math.max(0, entry.attempts - 1) };
  }

  pollDeadLetters(recipient: string, maxItems: number): MailboxDeadLetter[] {
    const mailbox = this.mailboxes.get(recipient);
    if (!mailbox) {
      return [];
    }
    const boundedMax = Math.max(0, maxItems);
    if (boundedMax === 0) {
      return [];
    }
    const items = mailbox.deadLetters.splice(0, boundedMax);
    return items.map((entry) => ({
      envelope: entry.envelope,
      enqueuedAt: entry.enqueuedAt,
      failedAt: entry.failedAt,
      retryCount: Math.max(0, entry.attempts - 1),
      deliveryAttempt: entry.attempts,
      lastError: entry.lastError
    }));
  }

  cleanupExpired(): number {
    const now = this.now();
    let removed = 0;
    for (const [recipient, mailbox] of this.mailboxes.entries()) {
      const before = mailbox.queue.length;
      this.requeueExpiredLeases(mailbox, now);
      this.purgeExpired(mailbox, now);
      removed += before - mailbox.queue.length;
      if (mailbox.queue.length === 0 && mailbox.deadLetters.length === 0) {
        this.mailboxes.delete(recipient);
      }
    }
    return removed;
  }

  private purgeExpired(mailbox: RecipientMailbox, now: number): void {
    mailbox.queue = mailbox.queue.filter((entry) => now - entry.enqueuedAt < this.ttlMs);
  }

  private requeueExpiredLeases(mailbox: RecipientMailbox, now: number): void {
    const kept: MailboxEntry[] = [];
    mailbox.queue.forEach((entry) => {
      if (entry.status !== "leased") {
        kept.push(entry);
        return;
      }
      if (entry.leaseUntil > now) {
        kept.push(entry);
        return;
      }
      if (entry.attempts >= this.maxAttempts) {
        this.moveToDeadLetter(mailbox, entry, "lease_expired");
        return;
      }
      entry.status = "pending";
      entry.leaseId = null;
      entry.leaseUntil = 0;
      entry.availableAt =
        now + computeBackoffMs(entry.attempts, this.retryBaseMs, this.retryMaxMs);
      kept.push(entry);
    });
    mailbox.queue = kept;
  }

  private moveToDeadLetter(
    mailbox: RecipientMailbox,
    entry: MailboxEntry,
    reason?: string
  ): void {
    mailbox.deadLetters.push({
      envelope: entry.envelope,
      enqueuedAt: entry.enqueuedAt,
      failedAt: this.now(),
      attempts: entry.attempts,
      lastError: reason
    });
  }

  private countStates(mailbox: RecipientMailbox): { pending: number; leased: number } {
    let pending = 0;
    let leased = 0;
    mailbox.queue.forEach((entry) => {
      if (entry.status === "leased") {
        leased += 1;
      } else {
        pending += 1;
      }
    });
    return { pending, leased };
  }

  private ensureRecipientLimit(): void {
    if (this.mailboxes.size <= this.maxRecipients) {
      return;
    }

    for (const [recipient, mailbox] of this.mailboxes.entries()) {
      if (mailbox.queue.length === 0 && mailbox.deadLetters.length === 0) {
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
      const mailbox = this.mailboxes.get(recipient);
      if (mailbox && mailbox.deadLetters.length > 0) {
        continue;
      }
      this.mailboxes.delete(recipient);
    }
  }

  private logDropOldest(recipient: string, dropped: number, queueDepth: number): void {
    if (!this.logger || typeof this.logger.log !== "function") {
      return;
    }
    this.logger.log(
      `mailbox_drop_oldest recipient=${recipient} dropped=${dropped} queue_depth=${queueDepth}`
    );
  }
}

export class Mailbox extends InMemoryMailboxStore {
  constructor(options: MailboxOptions = {}) {
    super(options);
  }
}

export class SQLiteMailboxStore implements MailboxStore {
  private ttlMs: number;
  private maxQueueLength: number;
  private maxRecipients: number;
  private leaseMs: number;
  private maxRetries: number;
  private maxAttempts: number;
  private retryBaseMs: number;
  private retryMaxMs: number;
  private now: () => number;
  private logger: MailboxLogger;
  private db: SQLiteDatabase;
  private selectRecipientCountStatement: SQLiteStatement;
  private selectMessageCountByRecipientStatement: SQLiteStatement;
  private selectPendingCountByRecipientStatement: SQLiteStatement;
  private selectLeasedCountByRecipientStatement: SQLiteStatement;
  private selectDeadLetterCountByRecipientStatement: SQLiteStatement;
  private insertRecipientStatement: SQLiteStatement;
  private insertMessageStatement: SQLiteStatement;
  private deleteOldestByRecipientStatement: SQLiteStatement;
  private deleteEmptyRecipientsStatement: SQLiteStatement;
  private selectOldestRecipientsStatement: SQLiteStatement;
  private deleteMessagesForRecipientStatement: SQLiteStatement;
  private deleteRecipientStatement: SQLiteStatement;
  private updateRecipientActivityStatement: SQLiteStatement;
  private selectPollItemsStatement: SQLiteStatement;
  private deleteExpiredMessagesStatement: SQLiteStatement;
  private selectExpiredLeasesStatement: SQLiteStatement;
  private updateLeaseStatement: SQLiteStatement;
  private selectByLeaseIdStatement: SQLiteStatement;
  private acknowledgeByLeaseIdStatement: SQLiteStatement;
  private clearLeaseStatement: SQLiteStatement;
  private insertDeadLetterStatement: SQLiteStatement;
  private deleteMessageByIdStatement: SQLiteStatement;
  private selectDeadLettersStatement: SQLiteStatement;

  constructor(options: SQLiteMailboxStoreOptions = {}) {
    this.ttlMs = parsePositiveInt(options.ttlMs, DEFAULT_TTL_MS);
    this.maxQueueLength = parsePositiveInt(options.maxQueueLength, DEFAULT_MAX_QUEUE_LENGTH);
    this.maxRecipients = parsePositiveInt(options.maxRecipients, DEFAULT_MAX_RECIPIENTS);
    this.leaseMs = parsePositiveInt(options.leaseMs, DEFAULT_LEASE_MS);
    this.maxRetries = parseNonNegativeInt(options.maxRetries, DEFAULT_MAX_RETRIES);
    this.maxAttempts = Math.max(1, this.maxRetries + 1);
    this.retryBaseMs = parseNonNegativeInt(options.retryBaseMs, DEFAULT_RETRY_BASE_MS);
    this.retryMaxMs = parseNonNegativeInt(options.retryMaxMs, DEFAULT_RETRY_MAX_MS);
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.logger = options.logger ?? null;

    const sqlitePath = options.sqlitePath?.trim() || DEFAULT_SQLITE_PATH;
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });

    const SQLiteDatabaseCtor = loadSQLiteDatabaseConstructor();
    this.db = new SQLiteDatabaseCtor(sqlitePath);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SQLITE_MAILBOX_SCHEMA);
    this.migrateSchema();

    this.selectRecipientCountStatement = this.db.prepare(
      "SELECT COUNT(*) AS count FROM mailbox_recipients"
    );
    this.selectMessageCountByRecipientStatement = this.db.prepare(
      "SELECT COUNT(*) AS count FROM mailbox_messages WHERE recipient = ?"
    );
    this.selectPendingCountByRecipientStatement = this.db.prepare(
      "SELECT COUNT(*) AS count FROM mailbox_messages WHERE recipient = ? AND status = 'pending'"
    );
    this.selectLeasedCountByRecipientStatement = this.db.prepare(
      "SELECT COUNT(*) AS count FROM mailbox_messages WHERE recipient = ? AND status = 'leased'"
    );
    this.selectDeadLetterCountByRecipientStatement = this.db.prepare(
      "SELECT COUNT(*) AS count FROM mailbox_dead_letters WHERE recipient = ?"
    );
    this.insertRecipientStatement = this.db.prepare(
      "INSERT INTO mailbox_recipients(recipient, last_activity) VALUES(?, ?) ON CONFLICT(recipient) DO UPDATE SET last_activity = excluded.last_activity"
    );
    this.insertMessageStatement = this.db.prepare(
      "INSERT INTO mailbox_messages(recipient, envelope_json, enqueued_at, available_at, status, attempts) VALUES(?, ?, ?, ?, 'pending', 0)"
    );
    this.deleteOldestByRecipientStatement = this.db.prepare(
      "DELETE FROM mailbox_messages WHERE id IN (SELECT id FROM mailbox_messages WHERE recipient = ? AND status = 'pending' ORDER BY available_at ASC, id ASC LIMIT ?)"
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
      "SELECT id, envelope_json, attempts FROM mailbox_messages WHERE recipient = ? AND status = 'pending' AND available_at <= ? ORDER BY available_at ASC, id ASC LIMIT ?"
    );
    this.deleteExpiredMessagesStatement = this.db.prepare(
      "DELETE FROM mailbox_messages WHERE enqueued_at <= ?"
    );
    this.selectExpiredLeasesStatement = this.db.prepare(
      "SELECT id, recipient, envelope_json, enqueued_at, attempts FROM mailbox_messages WHERE status = 'leased' AND lease_until <= ?"
    );
    this.updateLeaseStatement = this.db.prepare(
      "UPDATE mailbox_messages SET status = 'leased', lease_id = ?, lease_until = ?, attempts = attempts + 1 WHERE id = ?"
    );
    this.selectByLeaseIdStatement = this.db.prepare(
      "SELECT id, recipient, envelope_json, enqueued_at, attempts, lease_until, status FROM mailbox_messages WHERE lease_id = ? AND recipient = ?"
    );
    this.acknowledgeByLeaseIdStatement = this.db.prepare(
      "DELETE FROM mailbox_messages WHERE lease_id = ? AND recipient = ?"
    );
    this.clearLeaseStatement = this.db.prepare(
      "UPDATE mailbox_messages SET status = 'pending', lease_id = NULL, lease_until = NULL, available_at = ? WHERE id = ?"
    );
    this.insertDeadLetterStatement = this.db.prepare(
      "INSERT INTO mailbox_dead_letters(recipient, envelope_json, enqueued_at, failed_at, attempts, last_error) VALUES(?, ?, ?, ?, ?, ?)"
    );
    this.deleteMessageByIdStatement = this.db.prepare(
      "DELETE FROM mailbox_messages WHERE id = ?"
    );
    this.selectDeadLettersStatement = this.db.prepare(
      "SELECT id, envelope_json, enqueued_at, failed_at, attempts, last_error FROM mailbox_dead_letters WHERE recipient = ? ORDER BY id ASC LIMIT ?"
    );
  }

  enqueue(recipient: string, envelope: unknown): MailboxStoreEnqueueResult {
    const now = this.now();
    return this.withTransaction(() => {
      this.requeueExpiredLeasesInternal(now);
      this.purgeExpiredInternal(now);

      this.insertRecipientStatement.run(recipient, now);
      this.insertMessageStatement.run(recipient, JSON.stringify(envelope), now, now);

      const counts = this.selectCountsForRecipient(recipient);
      let queueDepth = counts.total;
      let dropped = 0;

      if (counts.pending > this.maxQueueLength) {
        dropped = counts.pending - this.maxQueueLength;
        this.deleteOldestByRecipientStatement.run(recipient, dropped);
        queueDepth = Math.max(0, queueDepth - dropped);
        this.logDropOldest(recipient, dropped, queueDepth);
      }

      this.ensureRecipientLimitInternal();

      return { queueDepth, dropped };
    });
  }

  peek(recipient: string): MailboxStorePeekResult {
    const now = this.now();
    return this.withTransaction(() => {
      this.requeueExpiredLeasesInternal(now);
      this.purgeExpiredInternal(now);

      const counts = this.selectCountsForRecipient(recipient);
      if (counts.total === 0) {
        this.deleteRecipientStatement.run(recipient);
        return { count: 0, pending: 0, leased: 0, deadLetters: counts.deadLetters };
      }

      this.updateRecipientActivityStatement.run(now, recipient);
      return {
        count: counts.total,
        pending: counts.pending,
        leased: counts.leased,
        deadLetters: counts.deadLetters
      };
    });
  }

  poll(recipient: string, maxItems: number): MailboxLeaseItem[] {
    const boundedMax = Math.max(0, maxItems);
    if (boundedMax === 0) {
      return [];
    }

    const now = this.now();
    return this.withTransaction(() => {
      this.requeueExpiredLeasesInternal(now);
      this.purgeExpiredInternal(now);

      const rows = this.selectPollItemsStatement.all(recipient, now, boundedMax);
      if (rows.length === 0) {
        this.deleteRecipientStatement.run(recipient);
        return [];
      }

      const items: MailboxLeaseItem[] = [];
      rows.forEach((row) => {
        const id = Number(row.id);
        const attempts = Number(row.attempts || 0);
        if (!Number.isFinite(id)) {
          return;
        }
        if (attempts >= this.maxAttempts) {
          this.moveToDeadLetterInternal(recipient, row, "max_retries_exceeded");
          this.deleteMessageByIdStatement.run(id);
          return;
        }
        const leaseId = generateLeaseId();
        const leaseUntil = now + this.leaseMs;
        this.updateLeaseStatement.run(leaseId, leaseUntil, id);
        const envelopeJson = typeof row.envelope_json === "string" ? row.envelope_json : "";
        if (!envelopeJson) {
          return;
        }
        try {
          const envelope = JSON.parse(envelopeJson);
          items.push({
            envelope,
            leaseId,
            leaseExpiresAt: leaseUntil,
            retryCount: Math.max(0, attempts),
            deliveryAttempt: attempts + 1
          });
        } catch (_err) {
          // Corrupt JSON should not poison mailbox polling.
        }
      });

      const remaining = this.selectCountsForRecipient(recipient);
      if (remaining.total === 0) {
        this.deleteRecipientStatement.run(recipient);
      } else {
        this.updateRecipientActivityStatement.run(now, recipient);
      }

      return items;
    });
  }

  ack(recipient: string, leaseId: string): MailboxAckResult {
    const now = this.now();
    return this.withTransaction(() => {
      this.requeueExpiredLeasesInternal(now);
      const row = this.selectByLeaseIdStatement.get(leaseId, recipient);
      if (!row) {
        return { ok: false, status: "unknown_lease" };
      }
      const leaseUntil = Number(row.lease_until || 0);
      const status = String(row.status || "");
      if (status !== "leased" || leaseUntil <= now) {
        return { ok: false, status: "expired" };
      }
      this.acknowledgeByLeaseIdStatement.run(leaseId, recipient);
      const remaining = this.selectCountsForRecipient(recipient);
      if (remaining.total === 0) {
        this.deleteRecipientStatement.run(recipient);
      }
      return { ok: true, status: "acknowledged" };
    });
  }

  fail(recipient: string, leaseId: string, reason?: string): MailboxFailResult {
    const now = this.now();
    return this.withTransaction(() => {
      this.requeueExpiredLeasesInternal(now);
      const row = this.selectByLeaseIdStatement.get(leaseId, recipient);
      if (!row) {
        return { ok: false, status: "unknown_lease" };
      }
      const leaseUntil = Number(row.lease_until || 0);
      const status = String(row.status || "");
      if (status !== "leased" || leaseUntil <= now) {
        return { ok: false, status: "expired" };
      }
      const id = Number(row.id);
      const attempts = Number(row.attempts || 0);
      if (!Number.isFinite(id)) {
        return { ok: false, status: "unknown_lease" };
      }
      if (attempts >= this.maxAttempts) {
        this.moveToDeadLetterInternal(recipient, row, reason);
        this.deleteMessageByIdStatement.run(id);
        return { ok: true, status: "dead_lettered", retryCount: Math.max(0, attempts - 1) };
      }
      const availableAt =
        now + computeBackoffMs(attempts, this.retryBaseMs, this.retryMaxMs);
      this.clearLeaseStatement.run(availableAt, id);
      return { ok: true, status: "requeued", retryCount: Math.max(0, attempts - 1) };
    });
  }

  pollDeadLetters(recipient: string, maxItems: number): MailboxDeadLetter[] {
    const boundedMax = Math.max(0, maxItems);
    if (boundedMax === 0) {
      return [];
    }
    return this.withTransaction(() => {
      const rows = this.selectDeadLettersStatement.all(recipient, boundedMax);
      if (rows.length === 0) {
        return [];
      }
      const ids: number[] = [];
      const items: MailboxDeadLetter[] = [];
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
          items.push({
            envelope: JSON.parse(envelopeJson),
            enqueuedAt: Number(row.enqueued_at || 0),
            failedAt: Number(row.failed_at || 0),
            retryCount: Math.max(0, Number(row.attempts || 0) - 1),
            deliveryAttempt: Number(row.attempts || 0),
            lastError: typeof row.last_error === "string" ? row.last_error : undefined
          });
        } catch (_err) {
          // Ignore corrupt entries.
        }
      });
      if (ids.length > 0) {
        const placeholders = ids.map(() => "?").join(",");
        const statement = this.db.prepare(
          `DELETE FROM mailbox_dead_letters WHERE id IN (${placeholders})`
        );
        statement.run(...ids);
      }
      return items;
    });
  }

  cleanupExpired(): number {
    const now = this.now();
    return this.withTransaction(() => {
      this.requeueExpiredLeasesInternal(now);
      return this.purgeExpiredInternal(now);
    });
  }

  close(): void {
    if (typeof this.db.close === "function") {
      this.db.close();
    }
  }

  private migrateSchema(): void {
    const columns = [
      "available_at INTEGER NOT NULL DEFAULT 0",
      "status TEXT NOT NULL DEFAULT 'pending'",
      "lease_id TEXT",
      "lease_until INTEGER",
      "attempts INTEGER NOT NULL DEFAULT 0"
    ];
    columns.forEach((column) => {
      try {
        this.db.exec(`ALTER TABLE mailbox_messages ADD COLUMN ${column}`);
      } catch (_err) {
        // Column likely exists.
      }
    });

    try {
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS mailbox_dead_letters (id INTEGER PRIMARY KEY AUTOINCREMENT, recipient TEXT NOT NULL, envelope_json TEXT NOT NULL, enqueued_at INTEGER NOT NULL, failed_at INTEGER NOT NULL, attempts INTEGER NOT NULL, last_error TEXT)"
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_mailbox_dead_letters_recipient_id ON mailbox_dead_letters(recipient, id)"
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_mailbox_messages_status_available ON mailbox_messages(status, available_at, id)"
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_mailbox_messages_lease_until ON mailbox_messages(status, lease_until)"
      );
    } catch (_err) {
      // Ignore migration failures.
    }
  }

  private purgeExpiredInternal(now: number): number {
    const cutoff = now - this.ttlMs;
    const result = this.deleteExpiredMessagesStatement.run(cutoff);
    this.deleteEmptyRecipientsStatement.run();
    return Number(result.changes || 0);
  }

  private requeueExpiredLeasesInternal(now: number): void {
    const expired = this.selectExpiredLeasesStatement.all(now);
    expired.forEach((row) => {
      const id = Number(row.id);
      const attempts = Number(row.attempts || 0);
      if (!Number.isFinite(id)) {
        return;
      }
      if (attempts >= this.maxAttempts) {
        this.moveToDeadLetterInternal("", row, "lease_expired");
        this.deleteMessageByIdStatement.run(id);
        return;
      }
      const availableAt =
        now + computeBackoffMs(attempts, this.retryBaseMs, this.retryMaxMs);
      this.clearLeaseStatement.run(availableAt, id);
    });
  }

  private ensureRecipientLimitInternal(): void {
    this.deleteEmptyRecipientsStatement.run();

    const currentCount = Number(this.selectRecipientCountStatement.get()?.count || 0);
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

  private selectCountsForRecipient(recipient: string): {
    total: number;
    pending: number;
    leased: number;
    deadLetters: number;
  } {
    const total = Number(this.selectMessageCountByRecipientStatement.get(recipient)?.count || 0);
    const pending = Number(
      this.selectPendingCountByRecipientStatement.get(recipient)?.count || 0
    );
    const leased = Number(
      this.selectLeasedCountByRecipientStatement.get(recipient)?.count || 0
    );
    const deadLetters = Number(
      this.selectDeadLetterCountByRecipientStatement.get(recipient)?.count || 0
    );
    return { total, pending, leased, deadLetters };
  }

  private moveToDeadLetterInternal(
    recipient: string,
    row: Record<string, unknown>,
    reason?: string
  ): void {
    const envelopeJson = typeof row.envelope_json === "string" ? row.envelope_json : "";
    if (!envelopeJson) {
      return;
    }
    const enqueuedAt = Number(row.enqueued_at || 0);
    const attempts = Number(row.attempts || 0);
    const targetRecipient =
      recipient || (typeof row.recipient === "string" ? row.recipient : "");
    if (!targetRecipient) {
      return;
    }
    this.insertDeadLetterStatement.run(
      targetRecipient,
      envelopeJson,
      enqueuedAt,
      this.now(),
      attempts,
      reason || null
    );
  }

  private withTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch (_rollbackErr) {
        // Ignore rollback failures and rethrow original error.
      }
      throw err;
    }
  }

  private logDropOldest(recipient: string, dropped: number, queueDepth: number): void {
    if (!this.logger || typeof this.logger.log !== "function") {
      return;
    }
    this.logger.log(
      `mailbox_drop_oldest recipient=${recipient} dropped=${dropped} queue_depth=${queueDepth}`
    );
  }
}

export class RedisMailboxStore implements MailboxStore {
  private ttlMs: number;
  private maxQueueLength: number;
  private maxRecipients: number;
  private leaseMs: number;
  private maxRetries: number;
  private maxAttempts: number;
  private retryBaseMs: number;
  private retryMaxMs: number;
  private now: () => number;
  private logger: MailboxLogger;
  private redisCliPath: string;
  private redisUrl: string;
  private redisHost: string;
  private redisPort: number;
  private redisDb: number;
  private redisUsername: string;
  private redisPassword: string;
  private redisKeyPrefix: string;
  private redisCommandTimeoutMs: number;

  constructor(options: RedisMailboxStoreOptions = {}) {
    this.ttlMs = parsePositiveInt(options.ttlMs, DEFAULT_TTL_MS);
    this.maxQueueLength = parsePositiveInt(options.maxQueueLength, DEFAULT_MAX_QUEUE_LENGTH);
    this.maxRecipients = parsePositiveInt(options.maxRecipients, DEFAULT_MAX_RECIPIENTS);
    this.leaseMs = parsePositiveInt(options.leaseMs, DEFAULT_LEASE_MS);
    this.maxRetries = parseNonNegativeInt(options.maxRetries, DEFAULT_MAX_RETRIES);
    this.maxAttempts = Math.max(1, this.maxRetries + 1);
    this.retryBaseMs = parseNonNegativeInt(options.retryBaseMs, DEFAULT_RETRY_BASE_MS);
    this.retryMaxMs = parseNonNegativeInt(options.retryMaxMs, DEFAULT_RETRY_MAX_MS);
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.logger = options.logger ?? null;

    this.redisCliPath = options.redisCliPath?.trim() || DEFAULT_REDIS_CLI_PATH;
    this.redisUrl = options.redisUrl?.trim() || "";
    this.redisHost = options.redisHost?.trim() || DEFAULT_REDIS_HOST;
    this.redisPort = parsePositiveInt(options.redisPort, DEFAULT_REDIS_PORT);
    this.redisDb = parsePositiveInt(options.redisDb, DEFAULT_REDIS_DB);
    this.redisUsername = options.redisUsername?.trim() || "";
    this.redisPassword = options.redisPassword?.trim() || "";
    this.redisKeyPrefix = options.redisKeyPrefix?.trim() || DEFAULT_REDIS_KEY_PREFIX;
    this.redisCommandTimeoutMs = parsePositiveInt(
      options.redisCommandTimeoutMs,
      DEFAULT_REDIS_TIMEOUT_MS
    );

    const pong = this.runRedis(["PING"]);
    if (pong.trim().toUpperCase() !== "PONG") {
      throw new Error("Redis ping failed");
    }
  }

  enqueue(recipient: string, envelope: unknown): MailboxStoreEnqueueResult {
    const now = this.now();
    this.requeueExpiredLeasesForRecipient(recipient, now);
    this.purgeExpiredForRecipient(recipient, now);

    const messageId = generateLeaseId();
    const payload = JSON.stringify({ envelope, enqueuedAt: now, attempts: 0 });
    this.runRedis(["HSET", this.payloadKey(recipient), messageId, payload]);
    this.runRedis(["ZADD", this.pendingKey(recipient), String(now), messageId]);

    let dropped = 0;
    const pendingCount = this.readInteger(["ZCARD", this.pendingKey(recipient)]);
    if (pendingCount > this.maxQueueLength) {
      dropped = pendingCount - this.maxQueueLength;
      const evicted = this.readList([
        "ZRANGE",
        this.pendingKey(recipient),
        "0",
        String(Math.max(0, dropped - 1))
      ]);
      evicted.forEach((id) => {
        if (!id) {
          return;
        }
        this.runRedis(["ZREM", this.pendingKey(recipient), id]);
        this.runRedis(["HDEL", this.payloadKey(recipient), id]);
      });
      this.logDropOldest(recipient, dropped, Math.max(0, pendingCount - dropped));
    }

    const leasedCount = this.readInteger(["ZCARD", this.leaseKey(recipient)]);
    const queueDepth = this.readInteger(["ZCARD", this.pendingKey(recipient)]) + leasedCount;

    this.touchRecipient(recipient, now);
    this.enforceRecipientLimit();
    this.extendRecipientTtl(recipient);

    return { queueDepth, dropped };
  }

  peek(recipient: string): MailboxStorePeekResult {
    const now = this.now();
    this.requeueExpiredLeasesForRecipient(recipient, now);
    this.purgeExpiredForRecipient(recipient, now);

    const pending = this.readInteger(["ZCARD", this.pendingKey(recipient)]);
    const leased = this.readInteger(["ZCARD", this.leaseKey(recipient)]);
    const deadLetters = this.readInteger(["LLEN", this.deadLetterKey(recipient)]);
    const count = pending + leased;

    if (count === 0) {
      if (deadLetters === 0) {
        this.clearRecipient(recipient);
      }
      return { count: 0, pending: 0, leased: 0, deadLetters };
    }

    this.touchRecipient(recipient, now);
    this.extendRecipientTtl(recipient);
    return { count, pending, leased, deadLetters };
  }

  poll(recipient: string, maxItems: number): MailboxLeaseItem[] {
    const boundedMax = Math.max(0, maxItems);
    if (boundedMax === 0) {
      return [];
    }

    const now = this.now();
    this.requeueExpiredLeasesForRecipient(recipient, now);
    this.purgeExpiredForRecipient(recipient, now);

    const items: MailboxLeaseItem[] = [];
    const ids = this.readList([
      "ZRANGEBYSCORE",
      this.pendingKey(recipient),
      "-inf",
      String(now),
      "LIMIT",
      "0",
      String(boundedMax)
    ]);

    ids.forEach((id) => {
      if (!id) {
        return;
      }
      const payload = this.readPayload(recipient, id);
      if (!payload) {
        this.runRedis(["ZREM", this.pendingKey(recipient), id]);
        return;
      }
      if (payload.attempts >= this.maxAttempts) {
        this.moveToDeadLetter(recipient, payload, "max_retries_exceeded");
        this.runRedis(["ZREM", this.pendingKey(recipient), id]);
        this.runRedis(["HDEL", this.payloadKey(recipient), id]);
        return;
      }
      const leaseId = generateLeaseId();
      const leaseUntil = now + this.leaseMs;
      payload.attempts += 1;
      this.writePayload(recipient, id, payload);
      this.runRedis(["ZREM", this.pendingKey(recipient), id]);
      this.runRedis(["HSET", this.leaseMapKey(recipient), leaseId, id]);
      this.runRedis(["HSET", this.messageLeaseKey(recipient), id, leaseId]);
      this.runRedis(["ZADD", this.leaseKey(recipient), String(leaseUntil), leaseId]);
      items.push({
        envelope: payload.envelope,
        leaseId,
        leaseExpiresAt: leaseUntil,
        retryCount: Math.max(0, payload.attempts - 1),
        deliveryAttempt: payload.attempts
      });
    });

    const pending = this.readInteger(["ZCARD", this.pendingKey(recipient)]);
    const leased = this.readInteger(["ZCARD", this.leaseKey(recipient)]);
    if (pending + leased === 0) {
      const deadLetters = this.readInteger(["LLEN", this.deadLetterKey(recipient)]);
      if (deadLetters === 0) {
        this.clearRecipient(recipient);
      }
    } else {
      this.touchRecipient(recipient, now);
      this.extendRecipientTtl(recipient);
    }

    return items;
  }

  ack(recipient: string, leaseId: string): MailboxAckResult {
    const now = this.now();
    const leaseUntilRaw = this.runRedis(["ZSCORE", this.leaseKey(recipient), leaseId]).trim();
    if (!leaseUntilRaw) {
      return { ok: false, status: "unknown_lease" };
    }
    const leaseUntil = Number.parseInt(leaseUntilRaw, 10);
    if (!Number.isFinite(leaseUntil) || leaseUntil <= now) {
      this.requeueExpiredLeasesForRecipient(recipient, now);
      return { ok: false, status: "expired" };
    }
    const messageId = this.runRedis([
      "HGET",
      this.leaseMapKey(recipient),
      leaseId
    ]).trim();
    if (!messageId) {
      return { ok: false, status: "unknown_lease" };
    }
    this.runRedis(["ZREM", this.leaseKey(recipient), leaseId]);
    this.runRedis(["HDEL", this.leaseMapKey(recipient), leaseId]);
    this.runRedis(["HDEL", this.messageLeaseKey(recipient), messageId]);
    this.runRedis(["HDEL", this.payloadKey(recipient), messageId]);
    return { ok: true, status: "acknowledged" };
  }

  fail(recipient: string, leaseId: string, reason?: string): MailboxFailResult {
    const now = this.now();
    const leaseUntilRaw = this.runRedis(["ZSCORE", this.leaseKey(recipient), leaseId]).trim();
    if (!leaseUntilRaw) {
      return { ok: false, status: "unknown_lease" };
    }
    const leaseUntil = Number.parseInt(leaseUntilRaw, 10);
    if (!Number.isFinite(leaseUntil) || leaseUntil <= now) {
      this.requeueExpiredLeasesForRecipient(recipient, now);
      return { ok: false, status: "expired" };
    }
    const messageId = this.runRedis([
      "HGET",
      this.leaseMapKey(recipient),
      leaseId
    ]).trim();
    if (!messageId) {
      return { ok: false, status: "unknown_lease" };
    }
    const payload = this.readPayload(recipient, messageId);
    if (!payload) {
      return { ok: false, status: "unknown_lease" };
    }
    this.runRedis(["ZREM", this.leaseKey(recipient), leaseId]);
    this.runRedis(["HDEL", this.leaseMapKey(recipient), leaseId]);
    this.runRedis(["HDEL", this.messageLeaseKey(recipient), messageId]);
    if (payload.attempts >= this.maxAttempts) {
      this.moveToDeadLetter(recipient, payload, reason);
      this.runRedis(["HDEL", this.payloadKey(recipient), messageId]);
      return {
        ok: true,
        status: "dead_lettered",
        retryCount: Math.max(0, payload.attempts - 1)
      };
    }
    const availableAt =
      now + computeBackoffMs(payload.attempts, this.retryBaseMs, this.retryMaxMs);
    this.writePayload(recipient, messageId, payload);
    this.runRedis(["ZADD", this.pendingKey(recipient), String(availableAt), messageId]);
    return { ok: true, status: "requeued", retryCount: Math.max(0, payload.attempts - 1) };
  }

  pollDeadLetters(recipient: string, maxItems: number): MailboxDeadLetter[] {
    const boundedMax = Math.max(0, maxItems);
    if (boundedMax === 0) {
      return [];
    }
    const items: MailboxDeadLetter[] = [];
    for (let i = 0; i < boundedMax; i += 1) {
      const raw = this.runRedis(["LPOP", this.deadLetterKey(recipient)]).trim();
      if (!raw) {
        break;
      }
      try {
        const parsed = JSON.parse(raw);
        items.push({
          envelope: parsed.envelope,
          enqueuedAt: Number(parsed.enqueuedAt || 0),
          failedAt: Number(parsed.failedAt || 0),
          retryCount: Math.max(0, Number(parsed.attempts || 0) - 1),
          deliveryAttempt: Number(parsed.attempts || 0),
          lastError: typeof parsed.lastError === "string" ? parsed.lastError : undefined
        });
      } catch (_err) {
        // Ignore corrupt items.
      }
    }
    return items;
  }

  cleanupExpired(): number {
    const now = this.now();
    const recipients = this.readList(["ZRANGE", this.recipientsKey(), "0", "-1"]);
    let removed = 0;
    recipients.forEach((recipient) => {
      if (!recipient) {
        return;
      }
      this.requeueExpiredLeasesForRecipient(recipient, now);
      removed += this.purgeExpiredForRecipient(recipient, now);
    });
    return removed;
  }

  private ttlSeconds(): number {
    const horizon = this.ttlMs + this.retryMaxMs + this.leaseMs;
    return Math.max(1, Math.ceil(horizon / 1000));
  }

  private pendingKey(recipient: string): string {
    return `${this.redisKeyPrefix}${recipient}:pending`;
  }

  private leaseKey(recipient: string): string {
    return `${this.redisKeyPrefix}${recipient}:lease`;
  }

  private payloadKey(recipient: string): string {
    return `${this.redisKeyPrefix}${recipient}:payload`;
  }

  private leaseMapKey(recipient: string): string {
    return `${this.redisKeyPrefix}${recipient}:lease_map`;
  }

  private messageLeaseKey(recipient: string): string {
    return `${this.redisKeyPrefix}${recipient}:message_lease`;
  }

  private deadLetterKey(recipient: string): string {
    return `${this.redisKeyPrefix}${recipient}:dead`;
  }

  private recipientsKey(): string {
    return `${this.redisKeyPrefix}__recipients`;
  }

  private touchRecipient(recipient: string, now: number): void {
    this.runRedis(["ZADD", this.recipientsKey(), String(now), recipient]);
  }

  private removeRecipient(recipient: string): void {
    this.runRedis(["ZREM", this.recipientsKey(), recipient]);
  }

  private enforceRecipientLimit(): void {
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
      const deadLetters = this.readInteger(["LLEN", this.deadLetterKey(recipient)]);
      if (deadLetters > 0) {
        return;
      }
      this.clearRecipient(recipient);
    });
  }

  private purgeExpiredForRecipient(recipient: string, now: number): number {
    let removed = 0;
    const cutoff = now - this.ttlMs;
    const pendingIds = this.readList(["ZRANGE", this.pendingKey(recipient), "0", "-1"]);
    pendingIds.forEach((id) => {
      if (!id) {
        return;
      }
      const payload = this.readPayload(recipient, id);
      if (!payload || payload.enqueuedAt <= cutoff) {
        this.runRedis(["ZREM", this.pendingKey(recipient), id]);
        this.runRedis(["HDEL", this.payloadKey(recipient), id]);
        removed += 1;
      }
    });

    const leaseIds = this.readList(["ZRANGE", this.leaseKey(recipient), "0", "-1"]);
    leaseIds.forEach((leaseId) => {
      if (!leaseId) {
        return;
      }
      const messageId = this.runRedis([
        "HGET",
        this.leaseMapKey(recipient),
        leaseId
      ]).trim();
      if (!messageId) {
        this.runRedis(["ZREM", this.leaseKey(recipient), leaseId]);
        this.runRedis(["HDEL", this.leaseMapKey(recipient), leaseId]);
        removed += 1;
        return;
      }
      const payload = this.readPayload(recipient, messageId);
      if (!payload || payload.enqueuedAt <= cutoff) {
        this.runRedis(["ZREM", this.leaseKey(recipient), leaseId]);
        this.runRedis(["HDEL", this.leaseMapKey(recipient), leaseId]);
        this.runRedis(["HDEL", this.messageLeaseKey(recipient), messageId]);
        this.runRedis(["HDEL", this.payloadKey(recipient), messageId]);
        removed += 1;
      }
    });

    const pending = this.readInteger(["ZCARD", this.pendingKey(recipient)]);
    const leased = this.readInteger(["ZCARD", this.leaseKey(recipient)]);
    if (pending + leased === 0) {
      const deadLetters = this.readInteger(["LLEN", this.deadLetterKey(recipient)]);
      if (deadLetters === 0) {
        this.clearRecipient(recipient);
      }
    }
    return removed;
  }

  private requeueExpiredLeasesForRecipient(recipient: string, now: number): void {
    const leaseIds = this.readList([
      "ZRANGEBYSCORE",
      this.leaseKey(recipient),
      "-inf",
      String(now)
    ]);
    leaseIds.forEach((leaseId) => {
      if (!leaseId) {
        return;
      }
      const messageId = this.runRedis([
        "HGET",
        this.leaseMapKey(recipient),
        leaseId
      ]).trim();
      if (!messageId) {
        this.runRedis(["ZREM", this.leaseKey(recipient), leaseId]);
        this.runRedis(["HDEL", this.leaseMapKey(recipient), leaseId]);
        return;
      }
      const payload = this.readPayload(recipient, messageId);
      this.runRedis(["ZREM", this.leaseKey(recipient), leaseId]);
      this.runRedis(["HDEL", this.leaseMapKey(recipient), leaseId]);
      this.runRedis(["HDEL", this.messageLeaseKey(recipient), messageId]);
      if (!payload) {
        return;
      }
      if (payload.attempts >= this.maxAttempts) {
        this.moveToDeadLetter(recipient, payload, "lease_expired");
        this.runRedis(["HDEL", this.payloadKey(recipient), messageId]);
        return;
      }
      const availableAt =
        now + computeBackoffMs(payload.attempts, this.retryBaseMs, this.retryMaxMs);
      this.runRedis(["ZADD", this.pendingKey(recipient), String(availableAt), messageId]);
    });
  }

  private readPayload(
    recipient: string,
    messageId: string
  ): { envelope: unknown; enqueuedAt: number; attempts: number } | null {
    const raw = this.runRedis(["HGET", this.payloadKey(recipient), messageId]).trim();
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw);
      return {
        envelope: parsed.envelope,
        enqueuedAt: Number(parsed.enqueuedAt || 0),
        attempts: Number(parsed.attempts || 0)
      };
    } catch (_err) {
      return null;
    }
  }

  private writePayload(
    recipient: string,
    messageId: string,
    payload: { envelope: unknown; enqueuedAt: number; attempts: number }
  ): void {
    const raw = JSON.stringify(payload);
    this.runRedis(["HSET", this.payloadKey(recipient), messageId, raw]);
  }

  private moveToDeadLetter(
    recipient: string,
    payload: { envelope: unknown; enqueuedAt: number; attempts: number },
    reason?: string
  ): void {
    const dead = JSON.stringify({
      envelope: payload.envelope,
      enqueuedAt: payload.enqueuedAt,
      failedAt: this.now(),
      attempts: payload.attempts,
      lastError: reason || null
    });
    this.runRedis(["RPUSH", this.deadLetterKey(recipient), dead]);
  }

  private clearRecipient(recipient: string): void {
    this.runRedis(["DEL", this.pendingKey(recipient)]);
    this.runRedis(["DEL", this.leaseKey(recipient)]);
    this.runRedis(["DEL", this.payloadKey(recipient)]);
    this.runRedis(["DEL", this.leaseMapKey(recipient)]);
    this.runRedis(["DEL", this.messageLeaseKey(recipient)]);
    this.runRedis(["DEL", this.deadLetterKey(recipient)]);
    this.removeRecipient(recipient);
  }

  private extendRecipientTtl(recipient: string): void {
    const ttlSeconds = this.ttlSeconds();
    this.runRedis(["EXPIRE", this.pendingKey(recipient), String(ttlSeconds)]);
    this.runRedis(["EXPIRE", this.leaseKey(recipient), String(ttlSeconds)]);
    this.runRedis(["EXPIRE", this.payloadKey(recipient), String(ttlSeconds)]);
    this.runRedis(["EXPIRE", this.leaseMapKey(recipient), String(ttlSeconds)]);
    this.runRedis(["EXPIRE", this.messageLeaseKey(recipient), String(ttlSeconds)]);
    this.runRedis(["EXPIRE", this.deadLetterKey(recipient), String(ttlSeconds)]);
  }

  private readInteger(args: string[]): number {
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

  private readList(args: string[]): string[] {
    const output = this.runRedis(args).trim();
    if (!output) {
      return [];
    }
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  private runRedis(args: string[]): string {
    const connectionArgs: string[] = ["--raw"];

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

  private logDropOldest(recipient: string, dropped: number, queueDepth: number): void {
    if (!this.logger || typeof this.logger.log !== "function") {
      return;
    }
    this.logger.log(
      `mailbox_drop_oldest recipient=${recipient} dropped=${dropped} queue_depth=${queueDepth}`
    );
  }
}

export type CreateMailboxStoreOptions = MailboxOptions & {
  type?: MailboxStoreType;
  sqlitePath?: string;
  redisUrl?: string;
  redisHost?: string;
  redisPort?: number;
  redisDb?: number;
  redisUsername?: string;
  redisPassword?: string;
  redisKeyPrefix?: string;
  redisCliPath?: string;
  redisCommandTimeoutMs?: number;
};

export function createMailboxStore(options: CreateMailboxStoreOptions = {}): MailboxStore {
  if (options.type === "memory") {
    return new InMemoryMailboxStore(options);
  }

  if (options.type === "redis") {
    const logger = options.logger ?? null;
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

export function parseMailboxStoreType(value: string | undefined): MailboxStoreType {
  const normalized = value ? value.trim().toLowerCase() : "";
  if (normalized === "memory") {
    return "memory";
  }
  if (normalized === "redis") {
    return "redis";
  }
  return "sqlite";
}
