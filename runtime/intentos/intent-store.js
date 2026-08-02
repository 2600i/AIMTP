"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_MAX_INTENTS = 500;
const DEFAULT_MAX_EVENTS_PER_INTENT = 100;
const DEFAULT_LIST_LIMIT = 100;
const DEFAULT_SQLITE_PATH = "runtime/aimtp-intentos.sqlite";
const GOAL_MAX_LENGTH = 500;
const EVENT_MESSAGE_MAX_LENGTH = 500;

const SQLITE_INTENTOS_SCHEMA = `
CREATE TABLE IF NOT EXISTS intentos_intents (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  sender TEXT NOT NULL DEFAULT '',
  recipient TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_intentos_intents_created_at
  ON intentos_intents(created_at DESC);

CREATE TABLE IF NOT EXISTS intentos_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  envelope_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  FOREIGN KEY(intent_id) REFERENCES intentos_intents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_intentos_events_intent_seq
  ON intentos_events(intent_id, seq);

CREATE TABLE IF NOT EXISTS intentos_tasks (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  assigned_to TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(intent_id) REFERENCES intentos_intents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_intentos_tasks_created_at
  ON intentos_tasks(created_at DESC);
`;

function loadSQLiteDatabaseConstructor() {
  try {
    const sqlite = require("node:sqlite");
    if (sqlite && typeof sqlite.DatabaseSync === "function") {
      return sqlite.DatabaseSync;
    }
  } catch (_err) {
    // Fall through to better-sqlite3.
  }

  try {
    const betterSqlite3 = require("better-sqlite3");
    if (typeof betterSqlite3 === "function") {
      return betterSqlite3;
    }
  } catch (_err) {
    // No compatible SQLite backend available.
  }

  throw new Error(
    "SQLite IntentOS store unavailable: install better-sqlite3 or run on a Node.js runtime with node:sqlite"
  );
}

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function truncate(value, max) {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function parsePositiveInt(value, fallback) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function toEpochMs(value, fallback) {
  const raw = asString(value);
  if (!raw) {
    return fallback;
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function toIso(epochMs) {
  return new Date(epochMs).toISOString();
}

function summarizeContent(content) {
  if (typeof content === "string") {
    return truncate(content.trim(), GOAL_MAX_LENGTH);
  }
  if (content === null || content === undefined) {
    return "";
  }
  try {
    return truncate(JSON.stringify(content), GOAL_MAX_LENGTH);
  } catch (_err) {
    return "";
  }
}

function readThreadId(metadata) {
  if (!metadata || typeof metadata !== "object") {
    return "";
  }
  const aimtp = metadata.aimtp;
  if (!aimtp || typeof aimtp !== "object") {
    return "";
  }
  return asString(aimtp.thread_id);
}

/**
 * Projection of an accepted envelope onto the IntentOS model.
 *
 * Envelopes carry `intent` as a label, not an identifier, so intents are keyed
 * by thread: `metadata.aimtp.thread_id` when present, else the envelope id. A
 * request and its response therefore collapse onto one intent, and the response
 * advances that intent's status rather than creating a second one.
 */
function projectEnvelope(envelope, nowMs) {
  if (!envelope || typeof envelope !== "object") {
    return null;
  }
  const envelopeId = asString(envelope.id);
  const threadId = readThreadId(envelope.metadata);
  const intentId = threadId || envelopeId;
  if (!intentId) {
    return null;
  }

  const rawTask = envelope.task && typeof envelope.task === "object" ? envelope.task : null;
  const taskKind = rawTask ? asString(rawTask.kind) : "";
  const taskStatus = rawTask ? asString(rawTask.status) : "";
  const intentLabel = asString(envelope.intent);
  const message =
    envelope.message && typeof envelope.message === "object" ? envelope.message : null;
  const summary = summarizeContent(message ? message.content : undefined);

  let status = "received";
  if (taskStatus) {
    status = taskStatus;
  } else if (taskKind === "request") {
    status = "in_progress";
  }

  const eventType = intentLabel || (taskKind ? `task.${taskKind}` : "message");

  let task = null;
  if (rawTask) {
    // A response collapses onto the task it answers so the Tasks view shows one
    // row per unit of work rather than one per envelope.
    const taskId = asString(rawTask.in_response_to) || asString(rawTask.id);
    if (taskId) {
      const defaultStatus = taskKind === "response" ? "completed" : "requested";
      task = {
        id: taskId,
        type: asString(rawTask.type) || taskKind || "task",
        status: taskStatus || defaultStatus,
        assignedTo: asString(envelope.recipient)
      };
    }
  }

  return {
    intentId,
    status,
    goal: summary,
    sender: asString(envelope.sender),
    recipient: asString(envelope.recipient),
    createdAtMs: toEpochMs(envelope.timestamp, nowMs),
    event: {
      type: eventType,
      status: taskStatus,
      message: truncate(summary, EVENT_MESSAGE_MAX_LENGTH),
      envelopeId
    },
    task
  };
}

class InMemoryIntentStore {
  constructor(options = {}) {
    this.maxIntents = parsePositiveInt(options.maxIntents, DEFAULT_MAX_INTENTS);
    this.maxEventsPerIntent = parsePositiveInt(
      options.maxEventsPerIntent,
      DEFAULT_MAX_EVENTS_PER_INTENT
    );
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.intents = new Map();
    this.events = new Map();
    this.tasks = new Map();
    this.seq = 0;
  }

  recordEnvelope(envelope) {
    const nowMs = this.now();
    const projection = projectEnvelope(envelope, nowMs);
    if (!projection) {
      return;
    }

    const existing = this.intents.get(projection.intentId);
    if (existing) {
      existing.status = projection.status;
      existing.updated_at = toIso(nowMs);
      if (!existing.goal && projection.goal) {
        existing.goal = projection.goal;
      }
    } else {
      this.intents.set(projection.intentId, {
        id: projection.intentId,
        status: projection.status,
        goal: projection.goal,
        sender: projection.sender,
        recipient: projection.recipient,
        created_at: toIso(projection.createdAtMs),
        updated_at: toIso(nowMs)
      });
    }

    this.seq += 1;
    const eventList = this.events.get(projection.intentId) || [];
    eventList.push({
      intent_id: projection.intentId,
      seq: this.seq,
      type: projection.event.type,
      status: projection.event.status,
      message: projection.event.message,
      envelope_id: projection.event.envelopeId,
      created_at: toIso(projection.createdAtMs)
    });
    if (eventList.length > this.maxEventsPerIntent) {
      eventList.splice(0, eventList.length - this.maxEventsPerIntent);
    }
    this.events.set(projection.intentId, eventList);

    if (projection.task) {
      const existingTask = this.tasks.get(projection.task.id);
      if (existingTask) {
        existingTask.status = projection.task.status;
        existingTask.updated_at = toIso(nowMs);
      } else {
        this.tasks.set(projection.task.id, {
          id: projection.task.id,
          intent_id: projection.intentId,
          type: projection.task.type,
          status: projection.task.status,
          assigned_to: projection.task.assignedTo,
          created_at: toIso(projection.createdAtMs),
          updated_at: toIso(nowMs)
        });
      }
    }

    this.prune();
  }

  listIntents(limit = DEFAULT_LIST_LIMIT) {
    const max = parsePositiveInt(limit, DEFAULT_LIST_LIMIT);
    return Array.from(this.intents.values())
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, max)
      .map((intent) => ({ ...intent }));
  }

  getIntent(intentId) {
    const intent = this.intents.get(intentId);
    if (!intent) {
      return null;
    }
    const events = this.events.get(intentId) || [];
    return { intent: { ...intent }, events: events.map((event) => ({ ...event })) };
  }

  listTasks(limit = DEFAULT_LIST_LIMIT) {
    const max = parsePositiveInt(limit, DEFAULT_LIST_LIMIT);
    return Array.from(this.tasks.values())
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, max)
      .map((task) => ({ ...task }));
  }

  close() {
    this.intents.clear();
    this.events.clear();
    this.tasks.clear();
  }

  prune() {
    if (this.intents.size <= this.maxIntents) {
      return;
    }
    const ordered = Array.from(this.intents.values()).sort(
      (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)
    );
    const excess = this.intents.size - this.maxIntents;
    for (let index = 0; index < excess; index += 1) {
      const victim = ordered[index];
      if (!victim) {
        continue;
      }
      this.intents.delete(victim.id);
      this.events.delete(victim.id);
      for (const [taskId, task] of this.tasks) {
        if (task.intent_id === victim.id) {
          this.tasks.delete(taskId);
        }
      }
    }
  }
}

class SQLiteIntentStore {
  constructor(options = {}) {
    this.maxIntents = parsePositiveInt(options.maxIntents, DEFAULT_MAX_INTENTS);
    this.maxEventsPerIntent = parsePositiveInt(
      options.maxEventsPerIntent,
      DEFAULT_MAX_EVENTS_PER_INTENT
    );
    this.now = typeof options.now === "function" ? options.now : () => Date.now();

    const sqlitePath =
      (options.sqlitePath && options.sqlitePath.trim()) || DEFAULT_SQLITE_PATH;
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });

    const SQLiteDatabaseCtor = loadSQLiteDatabaseConstructor();
    this.db = new SQLiteDatabaseCtor(sqlitePath);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SQLITE_INTENTOS_SCHEMA);

    this.selectIntentStatement = this.db.prepare(
      "SELECT id, status, goal, sender, recipient, created_at, updated_at FROM intentos_intents WHERE id = ?"
    );
    this.insertIntentStatement = this.db.prepare(
      "INSERT INTO intentos_intents(id, status, goal, sender, recipient, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)"
    );
    this.updateIntentStatement = this.db.prepare(
      "UPDATE intentos_intents SET status = ?, updated_at = ?, goal = CASE WHEN goal = '' THEN ? ELSE goal END WHERE id = ?"
    );
    this.selectIntentsStatement = this.db.prepare(
      "SELECT id, status, goal, sender, recipient, created_at, updated_at FROM intentos_intents ORDER BY created_at DESC, id DESC LIMIT ?"
    );
    this.insertEventStatement = this.db.prepare(
      "INSERT INTO intentos_events(intent_id, type, status, message, envelope_id, created_at) VALUES(?, ?, ?, ?, ?, ?)"
    );
    this.selectEventsStatement = this.db.prepare(
      "SELECT intent_id, seq, type, status, message, envelope_id, created_at FROM intentos_events WHERE intent_id = ? ORDER BY seq ASC"
    );
    this.deleteExcessEventsStatement = this.db.prepare(
      "DELETE FROM intentos_events WHERE intent_id = ? AND seq NOT IN (SELECT seq FROM intentos_events WHERE intent_id = ? ORDER BY seq DESC LIMIT ?)"
    );
    this.upsertTaskStatement = this.db.prepare(
      "INSERT INTO intentos_tasks(id, intent_id, type, status, assigned_to, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at"
    );
    this.selectTasksStatement = this.db.prepare(
      "SELECT id, intent_id, type, status, assigned_to, created_at, updated_at FROM intentos_tasks ORDER BY created_at DESC, id DESC LIMIT ?"
    );
    this.countIntentsStatement = this.db.prepare(
      "SELECT COUNT(*) AS count FROM intentos_intents"
    );
    this.deleteOldestIntentsStatement = this.db.prepare(
      "DELETE FROM intentos_intents WHERE id IN (SELECT id FROM intentos_intents ORDER BY created_at ASC, id ASC LIMIT ?)"
    );
  }

  recordEnvelope(envelope) {
    const nowMs = this.now();
    const projection = projectEnvelope(envelope, nowMs);
    if (!projection) {
      return;
    }

    const existing = this.selectIntentStatement.get(projection.intentId);
    if (existing) {
      this.updateIntentStatement.run(
        projection.status,
        nowMs,
        projection.goal,
        projection.intentId
      );
    } else {
      this.insertIntentStatement.run(
        projection.intentId,
        projection.status,
        projection.goal,
        projection.sender,
        projection.recipient,
        projection.createdAtMs,
        nowMs
      );
    }

    this.insertEventStatement.run(
      projection.intentId,
      projection.event.type,
      projection.event.status,
      projection.event.message,
      projection.event.envelopeId,
      projection.createdAtMs
    );
    this.deleteExcessEventsStatement.run(
      projection.intentId,
      projection.intentId,
      this.maxEventsPerIntent
    );

    if (projection.task) {
      this.upsertTaskStatement.run(
        projection.task.id,
        projection.intentId,
        projection.task.type,
        projection.task.status,
        projection.task.assignedTo,
        projection.createdAtMs,
        nowMs
      );
    }

    this.prune();
  }

  listIntents(limit = DEFAULT_LIST_LIMIT) {
    const max = parsePositiveInt(limit, DEFAULT_LIST_LIMIT);
    return this.selectIntentsStatement.all(max).map((row) => this.toIntentRecord(row));
  }

  getIntent(intentId) {
    const row = this.selectIntentStatement.get(intentId);
    if (!row) {
      return null;
    }
    const events = this.selectEventsStatement.all(intentId).map((eventRow) => ({
      intent_id: String(eventRow.intent_id || ""),
      seq: Number(eventRow.seq || 0),
      type: String(eventRow.type || ""),
      status: String(eventRow.status || ""),
      message: String(eventRow.message || ""),
      envelope_id: String(eventRow.envelope_id || ""),
      created_at: toIso(Number(eventRow.created_at || 0))
    }));
    return { intent: this.toIntentRecord(row), events };
  }

  listTasks(limit = DEFAULT_LIST_LIMIT) {
    const max = parsePositiveInt(limit, DEFAULT_LIST_LIMIT);
    return this.selectTasksStatement.all(max).map((row) => ({
      id: String(row.id || ""),
      intent_id: String(row.intent_id || ""),
      type: String(row.type || ""),
      status: String(row.status || ""),
      assigned_to: String(row.assigned_to || ""),
      created_at: toIso(Number(row.created_at || 0)),
      updated_at: toIso(Number(row.updated_at || 0))
    }));
  }

  close() {
    if (this.db && typeof this.db.close === "function") {
      this.db.close();
    }
  }

  toIntentRecord(row) {
    return {
      id: String(row.id || ""),
      status: String(row.status || ""),
      goal: String(row.goal || ""),
      sender: String(row.sender || ""),
      recipient: String(row.recipient || ""),
      created_at: toIso(Number(row.created_at || 0)),
      updated_at: toIso(Number(row.updated_at || 0))
    };
  }

  prune() {
    const row = this.countIntentsStatement.get();
    const count = Number((row && row.count) || 0);
    if (count <= this.maxIntents) {
      return;
    }
    this.deleteOldestIntentsStatement.run(count - this.maxIntents);
  }
}

function parseIntentStoreType(value) {
  const normalized = value ? value.trim().toLowerCase() : "";
  // Redis-backed mailboxes keep IntentOS projections local rather than adding a
  // second remote dependency for a read-only view.
  return normalized === "memory" || normalized === "redis" ? "memory" : "sqlite";
}

function createIntentStore(options = {}) {
  if (options.type === "memory") {
    return new InMemoryIntentStore(options);
  }
  try {
    return new SQLiteIntentStore(options);
  } catch (_err) {
    return new InMemoryIntentStore(options);
  }
}

module.exports = {
  SQLITE_INTENTOS_SCHEMA,
  InMemoryIntentStore,
  SQLiteIntentStore,
  createIntentStore,
  parseIntentStoreType,
  projectEnvelope
};
