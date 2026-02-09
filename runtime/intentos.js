"use strict";

const { randomBytes, randomUUID } = require("crypto");

const INTENT_STATUS_VALUES = new Set([
  "submitted",
  "planning",
  "running",
  "completed",
  "failed"
]);

const TASK_STATUS_VALUES = new Set([
  "queued",
  "claimed",
  "completed",
  "failed"
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

function normalizeString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizeLimit(value, fallback, max) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  const parsed = Math.floor(value);
  if (parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function generateId(prefix) {
  try {
    return `${prefix}-${randomUUID()}`;
  } catch (_err) {
    return `${prefix}-${randomBytes(16).toString("hex")}`;
  }
}

function nowIso(nowFn) {
  return new Date(nowFn()).toISOString();
}

class InMemoryIntentStore {
  constructor(options = {}) {
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.boxId = normalizeString(options.boxId) || "default";
    this.intents = new Map();
    this.intentOrder = [];
    this.eventsByIntent = new Map();
    this.intentTasks = new Map();
    this.tasks = new Map();
    this.taskOrder = [];
    this.intentIdempotency = new Map();
    this.sequence = 0;
  }

  submitIntent(intentInput) {
    if (!isPlainObject(intentInput)) {
      throw new Error("intent_input_invalid");
    }

    const goal = normalizeString(intentInput.goal);
    if (!goal) {
      throw new Error("intent_goal_required");
    }

    const explicitId = normalizeString(intentInput.id);
    if (explicitId && this.intents.has(explicitId)) {
      return explicitId;
    }

    const idempotencyKey = normalizeString(intentInput.idempotency_key);
    if (idempotencyKey && this.intentIdempotency.has(idempotencyKey)) {
      return this.intentIdempotency.get(idempotencyKey);
    }

    const intentId = explicitId || generateId("intent");
    const createdAt = normalizeString(intentInput.created_at) || nowIso(this.now);
    const principal = normalizeString(intentInput.principal) || "anonymous";
    const status = "submitted";
    const metadata = isPlainObject(intentInput.metadata) ? cloneJson(intentInput.metadata) : {};

    const intent = {
      id: intentId,
      principal,
      goal,
      created_at: createdAt,
      status,
      metadata
    };
    if (idempotencyKey) {
      intent.idempotency_key = idempotencyKey;
    }

    this.intents.set(intentId, intent);
    this.intentOrder.push(intentId);
    this.eventsByIntent.set(intentId, []);
    this.intentTasks.set(intentId, []);

    if (idempotencyKey) {
      this.intentIdempotency.set(idempotencyKey, intentId);
    }

    this._appendEventInternal(intentId, {
      type: "intent.submit",
      data: {
        intent_id: intentId,
        principal,
        status
      }
    });

    return intentId;
  }

  listIntents(status, limit) {
    const normalizedStatus = normalizeString(status);
    const maxItems = normalizeLimit(limit, 50, 500);
    const items = [];

    for (let i = this.intentOrder.length - 1; i >= 0; i -= 1) {
      const intentId = this.intentOrder[i];
      const intent = this.intents.get(intentId);
      if (!intent) {
        continue;
      }
      if (normalizedStatus && intent.status !== normalizedStatus) {
        continue;
      }
      items.push(cloneJson(intent));
      if (items.length >= maxItems) {
        break;
      }
    }

    return items;
  }

  getIntent(intentId) {
    const normalizedIntentId = normalizeString(intentId);
    if (!normalizedIntentId) {
      return null;
    }
    const intent = this.intents.get(normalizedIntentId);
    if (!intent) {
      return null;
    }

    const events = this.eventsByIntent.get(normalizedIntentId) || [];
    const taskIds = this.intentTasks.get(normalizedIntentId) || [];
    const tasks = taskIds
      .map((taskId) => this.tasks.get(taskId))
      .filter(Boolean)
      .map((task) => cloneJson(task));

    return {
      intent: cloneJson(intent),
      events: cloneJson(events),
      tasks
    };
  }

  appendEvent(intentId, eventInput) {
    const normalizedIntentId = normalizeString(intentId);
    if (!normalizedIntentId || !this.intents.has(normalizedIntentId)) {
      return { ok: false, code: "intent_not_found" };
    }
    if (!isPlainObject(eventInput)) {
      return { ok: false, code: "event_invalid" };
    }

    const type = normalizeString(eventInput.type);
    if (!type) {
      return { ok: false, code: "event_type_required" };
    }

    const entry = this._appendEventInternal(normalizedIntentId, {
      type,
      created_at: normalizeString(eventInput.created_at) || undefined,
      data: isPlainObject(eventInput.data) ? eventInput.data : {}
    });

    if (eventInput.status !== undefined) {
      const nextStatus = normalizeString(eventInput.status);
      if (INTENT_STATUS_VALUES.has(nextStatus)) {
        this._setIntentStatus(normalizedIntentId, nextStatus, "event_status_update");
      }
    }

    return { ok: true, event: cloneJson(entry) };
  }

  enqueueTask(taskInput) {
    if (!isPlainObject(taskInput)) {
      throw new Error("task_input_invalid");
    }

    const intentId = normalizeString(taskInput.intent_id);
    if (!intentId || !this.intents.has(intentId)) {
      throw new Error("task_intent_not_found");
    }

    const type = normalizeString(taskInput.type);
    if (!type) {
      throw new Error("task_type_required");
    }

    const explicitId = normalizeString(taskInput.id);
    if (explicitId && this.tasks.has(explicitId)) {
      return explicitId;
    }

    const taskId = explicitId || generateId("task");
    const createdAt = normalizeString(taskInput.created_at) || nowIso(this.now);
    const assignedTo = normalizeString(taskInput.assigned_to) || "";
    const statusCandidate = normalizeString(taskInput.status) || "queued";
    const status = TASK_STATUS_VALUES.has(statusCandidate) ? statusCandidate : "queued";

    const task = {
      id: taskId,
      intent_id: intentId,
      type,
      input: cloneJson(taskInput.input !== undefined ? taskInput.input : {}),
      status,
      created_at: createdAt
    };
    if (assignedTo) {
      task.assigned_to = assignedTo;
    }

    this.tasks.set(taskId, task);
    this.taskOrder.push(taskId);
    this.intentTasks.get(intentId).push(taskId);

    this._appendEventInternal(intentId, {
      type: "task.create",
      data: {
        task_id: taskId,
        type,
        status
      }
    });

    if (this.intents.get(intentId).status === "submitted") {
      this._setIntentStatus(intentId, "planning", "task_enqueued");
    }

    return taskId;
  }

  claimTask(taskId, agentId) {
    const normalizedTaskId = normalizeString(taskId);
    const normalizedAgentId = normalizeString(agentId);

    if (!normalizedTaskId) {
      return { ok: false, code: "task_id_required" };
    }
    if (!normalizedAgentId) {
      return { ok: false, code: "agent_id_required" };
    }

    const task = this.tasks.get(normalizedTaskId);
    if (!task) {
      return { ok: false, code: "task_not_found" };
    }

    if (task.status === "claimed") {
      if (task.assigned_to === normalizedAgentId) {
        return {
          ok: true,
          status: "claimed",
          idempotent: true,
          task: cloneJson(task)
        };
      }
      return {
        ok: false,
        code: "task_already_claimed",
        status: task.status,
        assigned_to: task.assigned_to
      };
    }

    if (task.status !== "queued") {
      return { ok: false, code: "task_not_claimable", status: task.status };
    }

    task.status = "claimed";
    task.assigned_to = normalizedAgentId;
    task.claimed_at = nowIso(this.now);

    this._appendEventInternal(task.intent_id, {
      type: "task.claim",
      data: {
        task_id: normalizedTaskId,
        agent_id: normalizedAgentId,
        status: "claimed"
      }
    });

    this._setIntentStatus(task.intent_id, "running", "task_claimed");

    return {
      ok: true,
      status: "claimed",
      task: cloneJson(task)
    };
  }

  completeTask(taskId, resultInput = {}) {
    const normalizedTaskId = normalizeString(taskId);
    if (!normalizedTaskId) {
      return { ok: false, code: "task_id_required" };
    }

    const task = this.tasks.get(normalizedTaskId);
    if (!task) {
      return { ok: false, code: "task_not_found" };
    }

    if (task.status === "completed" || task.status === "failed") {
      return {
        ok: true,
        status: task.status,
        idempotent: true,
        task: cloneJson(task)
      };
    }

    if (task.status !== "claimed") {
      return { ok: false, code: "task_not_claimed", status: task.status };
    }

    const normalizedStatus = normalizeString(resultInput.status);
    const finalStatus = normalizedStatus === "failed" ? "failed" : "completed";
    const eventType = finalStatus === "failed" ? "task.fail" : "task.result";

    task.status = finalStatus;
    task.completed_at = nowIso(this.now);
    if (Object.prototype.hasOwnProperty.call(resultInput, "output")) {
      task.output = cloneJson(resultInput.output);
    }
    if (typeof resultInput.error === "string" && resultInput.error.trim()) {
      task.error = resultInput.error.trim();
    }

    this._appendEventInternal(task.intent_id, {
      type: eventType,
      data: {
        task_id: normalizedTaskId,
        status: finalStatus,
        agent_id: normalizeString(resultInput.agent_id) || task.assigned_to || ""
      }
    });

    this._reconcileIntentStatus(task.intent_id);

    return {
      ok: true,
      status: finalStatus,
      task: cloneJson(task)
    };
  }

  listTasks(options = {}) {
    // Task listings are a derived read model over append-only events/state.
    const query = isPlainObject(options) ? options : {};
    const status = normalizeString(query.status);
    const intentId = normalizeString(query.intent_id);
    const assignedTo = normalizeString(query.assigned_to);
    const maxItems = normalizeLimit(query.limit, 50, 500);
    const items = [];

    for (let i = this.taskOrder.length - 1; i >= 0; i -= 1) {
      const task = this.tasks.get(this.taskOrder[i]);
      if (!task) {
        continue;
      }
      if (status && task.status !== status) {
        continue;
      }
      if (intentId && task.intent_id !== intentId) {
        continue;
      }
      if (assignedTo && task.assigned_to !== assignedTo) {
        continue;
      }
      items.push(cloneJson(task));
      if (items.length >= maxItems) {
        break;
      }
    }

    return items;
  }

  getTask(taskId) {
    const normalizedTaskId = normalizeString(taskId);
    if (!normalizedTaskId) {
      return null;
    }
    const task = this.tasks.get(normalizedTaskId);
    return task ? cloneJson(task) : null;
  }

  _appendEventInternal(intentId, eventInput) {
    const events = this.eventsByIntent.get(intentId);
    if (!events) {
      return null;
    }

    this.sequence += 1;
    const event = {
      id: `ev-${this.sequence}`,
      intent_id: intentId,
      type: normalizeString(eventInput.type) || "event",
      created_at: normalizeString(eventInput.created_at) || nowIso(this.now),
      data: isPlainObject(eventInput.data) ? cloneJson(eventInput.data) : {}
    };

    events.push(event);
    return event;
  }

  _setIntentStatus(intentId, status, reasonCode) {
    if (!INTENT_STATUS_VALUES.has(status)) {
      return false;
    }
    const intent = this.intents.get(intentId);
    if (!intent) {
      return false;
    }
    if (intent.status === status) {
      return true;
    }

    intent.status = status;
    intent.updated_at = nowIso(this.now);
    this._appendEventInternal(intentId, {
      type: "intent.status",
      data: {
        status,
        reason_code: normalizeString(reasonCode) || "status_update"
      }
    });
    return true;
  }

  _reconcileIntentStatus(intentId) {
    const taskIds = this.intentTasks.get(intentId) || [];
    if (taskIds.length === 0) {
      return;
    }

    const tasks = taskIds.map((taskId) => this.tasks.get(taskId)).filter(Boolean);
    if (tasks.length === 0) {
      return;
    }

    if (tasks.some((task) => task.status === "failed")) {
      this._setIntentStatus(intentId, "failed", "task_failed");
      return;
    }

    if (tasks.every((task) => task.status === "completed")) {
      this._setIntentStatus(intentId, "completed", "all_tasks_completed");
      return;
    }

    if (tasks.some((task) => task.status === "claimed")) {
      this._setIntentStatus(intentId, "running", "tasks_in_progress");
      return;
    }

    this._setIntentStatus(intentId, "planning", "tasks_pending");
  }
}

function createIntentStore(options = {}) {
  if (options && typeof options.store === "object") {
    return options.store;
  }
  return new InMemoryIntentStore(options);
}

module.exports = {
  InMemoryIntentStore,
  createIntentStore,
  INTENT_STATUS_VALUES,
  TASK_STATUS_VALUES
};
