"use strict";

const POLL_INTERVAL_MS = 2000;
const INTENTOS_UI_SEGMENT = "/intentos/ui";
const UI_SUFFIX = "/ui";

function deriveIntentosApiBase(pathname) {
  if (typeof pathname !== "string" || pathname.length === 0) {
    return "";
  }
  const uiIndex = pathname.indexOf(INTENTOS_UI_SEGMENT);
  if (uiIndex === -1) {
    return "";
  }
  const uiPath = pathname.slice(0, uiIndex + INTENTOS_UI_SEGMENT.length);
  return uiPath.endsWith(UI_SUFFIX) ? uiPath.slice(0, -UI_SUFFIX.length) : uiPath;
}

const CURRENT_PATHNAME =
  typeof window !== "undefined" && window.location ? window.location.pathname : "";
const INTENTOS_API_BASE = deriveIntentosApiBase(CURRENT_PATHNAME);

function apiPath(resourcePath) {
  return `${INTENTOS_API_BASE}${resourcePath}`;
}

const state = {
  intents: [],
  tasks: [],
  selectedIntentId: null,
  selectedIntent: null,
  events: [],
  inFlight: false,
  timer: null
};

let currentCapability = null;
let currentCapabilityHeaderValue = "";

function $(id) {
  if (typeof document === "undefined" || !document || typeof document.getElementById !== "function") {
    return null;
  }
  return document.getElementById(id);
}

function setText(id, text) {
  const node = $(id);
  if (node) {
    node.textContent = text;
  }
}

function setVisible(id, visible) {
  const node = $(id);
  if (!node) return;
  node.hidden = !visible;
}

function formatTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function truncate(value, max) {
  const text = value == null ? "" : String(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function queryValue(id, fallback = "") {
  const node = $(id);
  if (!node) return fallback;
  const value = typeof node.value === "string" ? node.value.trim() : "";
  return value || fallback;
}

function canonicalizeJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }
  if (value && typeof value === "object") {
    const sorted = {};
    Object.keys(value)
      .sort()
      .forEach((key) => {
        sorted[key] = canonicalizeJsonValue(value[key]);
      });
    return sorted;
  }
  return value;
}

function isFiniteUnixTimestamp(value) {
  return Number.isFinite(value) && value > 0;
}

function validateCapabilityShape(capability) {
  if (!capability || typeof capability !== "object" || Array.isArray(capability)) {
    return { ok: false, error: "Capability must be a JSON object." };
  }
  if (!Array.isArray(capability.chain) || capability.chain.length === 0) {
    return { ok: false, error: "Capability must include a non-empty chain array." };
  }
  if (
    !capability.signature ||
    typeof capability.signature !== "object" ||
    Array.isArray(capability.signature)
  ) {
    return { ok: false, error: "Capability must include a signature object." };
  }
  return { ok: true, error: "" };
}

function getCapabilityLeaf(capability) {
  if (!capability || !Array.isArray(capability.chain) || capability.chain.length === 0) {
    return null;
  }
  const leaf = capability.chain[capability.chain.length - 1];
  return leaf && typeof leaf === "object" && !Array.isArray(leaf) ? leaf : null;
}

function formatCapabilityExp(expUnix) {
  if (!isFiniteUnixTimestamp(expUnix)) {
    return "?";
  }
  return formatTime(new Date(expUnix * 1000).toISOString());
}

function updateCapabilityStatus(extraMessage) {
  const statusNode = $("capability-status");
  if (!statusNode) {
    return;
  }
  if (!currentCapability) {
    statusNode.textContent = "No capability loaded";
    return;
  }
  const leaf = getCapabilityLeaf(currentCapability);
  const subject = leaf && leaf.subject ? String(leaf.subject) : "?";
  const exp = leaf ? formatCapabilityExp(Number(leaf.exp)) : "?";
  const suffix = extraMessage ? ` (${extraMessage})` : "";
  statusNode.textContent = `Capability loaded (subject=${subject}, exp=${exp})${suffix}`;
}

function setCapabilityError(message) {
  setText("capability-error", message);
  setVisible("capability-error", true);
}

function clearCapabilityError() {
  setVisible("capability-error", false);
}

function loadCapabilityFromInput(rawText) {
  const trimmed = typeof rawText === "string" ? rawText.trim() : "";
  if (!trimmed) {
    currentCapability = null;
    currentCapabilityHeaderValue = "";
    clearCapabilityError();
    updateCapabilityStatus();
    return { ok: true, error: "" };
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (_err) {
    return { ok: false, error: "Capability is not valid JSON." };
  }
  const validation = validateCapabilityShape(parsed);
  if (!validation.ok) {
    return validation;
  }
  const canonical = canonicalizeJsonValue(parsed);
  currentCapability = canonical;
  currentCapabilityHeaderValue = JSON.stringify(canonical);
  clearCapabilityError();
  updateCapabilityStatus();
  return { ok: true, error: "" };
}

function buildIntentosRequestHeaders() {
  const headers = {
    Accept: "application/json"
  };
  if (currentCapabilityHeaderValue) {
    headers["X-AIMTP-Capability"] = currentCapabilityHeaderValue;
  }
  return headers;
}

function handleCapabilityResponseError(payload) {
  if (!payload || typeof payload !== "object") {
    return;
  }
  if (payload.code === "capability_required") {
    updateCapabilityStatus("required by relay");
    setCapabilityError("Capability required. Load a valid capability JSON.");
    return;
  }
  if (payload.code === "capability_invalid") {
    const details = payload.details && typeof payload.details === "object" ? payload.details : null;
    const errors = details && Array.isArray(details.errors) ? details.errors : [];
    const expired = errors.some((entry) => String(entry).toLowerCase().includes("expired"));
    if (expired) {
      updateCapabilityStatus("expired");
      setCapabilityError("Loaded capability is expired. Mint and load a fresh capability.");
      return;
    }
    updateCapabilityStatus("invalid");
    setCapabilityError("Loaded capability is invalid for this endpoint.");
  }
}

function readIntentsFilters() {
  const status = queryValue("intents-status", "all");
  const rawLimit = queryValue("intents-limit", "50");
  const parsedLimit = Number.parseInt(rawLimit, 10);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50;
  return { status, limit };
}

function readTasksFilters() {
  return {
    status: queryValue("tasks-status", "all"),
    assigned_to: queryValue("tasks-assigned", ""),
    intent_id: queryValue("tasks-intent-id", "")
  };
}

async function fetchJson(path, params = {}) {
  const url = new URL(path, window.location.origin);
  Object.keys(params).forEach((key) => {
    const value = params[key];
    if (value !== undefined && value !== null && value !== "" && value !== "all") {
      url.searchParams.set(key, String(value));
    }
  });

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: buildIntentosRequestHeaders()
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch (_err) {
    payload = null;
  }

  if (!response.ok) {
    handleCapabilityResponseError(payload);
    const code = payload && payload.code ? `${payload.code}: ` : "";
    const message =
      payload && payload.message
        ? payload.message
        : `Request failed with status ${response.status}`;
    throw new Error(`${code}${message}`);
  }

  return payload;
}

function normalizeIntents(payload) {
  if (payload && Array.isArray(payload.intents)) return payload.intents;
  if (Array.isArray(payload)) return payload;
  return [];
}

function normalizeTasks(payload) {
  if (payload && Array.isArray(payload.tasks)) return payload.tasks;
  if (Array.isArray(payload)) return payload;
  return [];
}

function normalizeIntentDetail(payload) {
  const intent =
    payload && payload.intent && typeof payload.intent === "object"
      ? payload.intent
      : payload && typeof payload === "object"
      ? payload
      : null;
  const events =
    payload && Array.isArray(payload.events)
      ? payload.events
      : payload && Array.isArray(payload.runlog)
      ? payload.runlog
      : intent && Array.isArray(intent.events)
      ? intent.events
      : [];
  return { intent, events };
}

function renderIntents() {
  const list = $("intents-list");
  if (!list) return;
  list.textContent = "";

  state.intents.forEach((intent) => {
    const id = intent && intent.id ? String(intent.id) : "(missing-id)";
    const button = document.createElement("button");
    button.type = "button";
    button.className = state.selectedIntentId === id ? "active" : "";
    button.addEventListener("click", () => {
      state.selectedIntentId = id;
      void loadSelectedIntent();
      renderIntents();
    });

    const top = document.createElement("div");
    top.className = "mono";
    top.textContent = id;
    const mid = document.createElement("div");
    mid.textContent = `${intent.status || "-"} • ${formatTime(intent.created_at)}`;
    const goal = document.createElement("div");
    goal.textContent = truncate(intent.goal || "", 120);

    button.appendChild(top);
    button.appendChild(mid);
    button.appendChild(goal);
    list.appendChild(button);
  });
}

function renderIntentDetail() {
  const detail = $("intent-detail");
  const eventsList = $("events-list");
  if (!detail || !eventsList) return;

  detail.textContent = "";
  eventsList.textContent = "";

  if (!state.selectedIntent) {
    detail.textContent = "No intent selected.";
    return;
  }

  const intent = state.selectedIntent;

  const dl = document.createElement("dl");
  dl.className = "detail-grid";

  const rows = [
    ["intent_id", intent.id || "-"],
    ["status", intent.status || "-"],
    ["created_at", formatTime(intent.created_at)],
    ["goal", truncate(intent.goal || "", 300)]
  ];

  rows.forEach(([label, value]) => {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    if (label === "intent_id") {
      dd.className = "mono";
    }
    dd.textContent = value;
    dl.appendChild(dt);
    dl.appendChild(dd);
  });
  detail.appendChild(dl);

  state.events.forEach((event, index) => {
    const item = document.createElement("li");
    const eventType =
      event && (event.type || event.event || event.name || event.kind)
        ? String(event.type || event.event || event.name || event.kind)
        : "event";
    const eventTime = formatTime(event && (event.created_at || event.timestamp || event.at));
    const eventStatus = event && event.status ? ` • ${event.status}` : "";
    const summarySource =
      event &&
      (event.message || event.reason || event.note || event.description || event.detail || event.code);
    const summary = truncate(summarySource || "", 180);

    const head = document.createElement("div");
    head.className = "mono";
    head.textContent = `${index + 1}. ${eventType} • ${eventTime}${eventStatus}`;
    item.appendChild(head);

    if (summary) {
      const body = document.createElement("div");
      body.textContent = summary;
      item.appendChild(body);
    }
    eventsList.appendChild(item);
  });
}

function renderTasks() {
  const tbody = $("tasks-body");
  if (!tbody) return;
  tbody.textContent = "";

  state.tasks.forEach((task) => {
    const tr = document.createElement("tr");
    const cells = [
      task.id || "-",
      task.intent_id || "-",
      task.type || "-",
      task.status || "-",
      task.assigned_to || "-",
      formatTime(task.created_at)
    ];
    cells.forEach((value, idx) => {
      const td = document.createElement("td");
      if (idx === 0 || idx === 1) {
        td.className = "mono";
      }
      td.textContent = value;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

async function loadIntents() {
  setVisible("intents-loading", true);
  setVisible("intents-error", false);
  const filters = readIntentsFilters();
  try {
    const payload = await fetchJson(apiPath("/intents"), filters);
    state.intents = normalizeIntents(payload);
    if (!state.selectedIntentId && state.intents.length > 0) {
      state.selectedIntentId = String(state.intents[0].id || "");
    }
    if (
      state.selectedIntentId &&
      !state.intents.some((intent) => String(intent.id || "") === state.selectedIntentId)
    ) {
      state.selectedIntentId = state.intents.length > 0 ? String(state.intents[0].id || "") : null;
    }
    renderIntents();
  } catch (err) {
    setText("intents-error", err.message || "Failed to load intents");
    setVisible("intents-error", true);
  } finally {
    setVisible("intents-loading", false);
  }
}

async function loadSelectedIntent() {
  if (!state.selectedIntentId) {
    state.selectedIntent = null;
    state.events = [];
    renderIntentDetail();
    return;
  }
  setVisible("detail-loading", true);
  setVisible("detail-error", false);
  try {
    const payload = await fetchJson(apiPath(`/intent/${encodeURIComponent(state.selectedIntentId)}`));
    const normalized = normalizeIntentDetail(payload);
    state.selectedIntent = normalized.intent;
    state.events = normalized.events;
    renderIntentDetail();
  } catch (err) {
    state.selectedIntent = null;
    state.events = [];
    renderIntentDetail();
    setText("detail-error", err.message || "Failed to load intent detail");
    setVisible("detail-error", true);
  } finally {
    setVisible("detail-loading", false);
  }
}

async function loadTasks() {
  setVisible("tasks-loading", true);
  setVisible("tasks-error", false);
  const filters = readTasksFilters();
  try {
    const payload = await fetchJson(apiPath("/tasks"), filters);
    state.tasks = normalizeTasks(payload);
    renderTasks();
  } catch (err) {
    state.tasks = [];
    renderTasks();
    setText("tasks-error", err.message || "Failed to load tasks");
    setVisible("tasks-error", true);
  } finally {
    setVisible("tasks-loading", false);
  }
}

async function refresh() {
  if (state.inFlight) return;
  state.inFlight = true;
  try {
    await Promise.all([loadIntents(), loadTasks()]);
    await loadSelectedIntent();
    setText("last-updated", `Last updated: ${new Date().toLocaleTimeString()}`);
  } finally {
    state.inFlight = false;
  }
}

function init() {
  const triggerRefresh = () => {
    void refresh();
  };
  const loadCapability = () => {
    const raw = queryValue("capability-input", "");
    const result = loadCapabilityFromInput(raw);
    if (!result.ok) {
      setCapabilityError(result.error || "Capability failed validation.");
      return;
    }
    void refresh();
  };
  updateCapabilityStatus();
  $("capability-load").addEventListener("click", loadCapability);
  $("refresh-all").addEventListener("click", triggerRefresh);
  $("intents-status").addEventListener("change", triggerRefresh);
  $("intents-limit").addEventListener("change", triggerRefresh);
  $("tasks-status").addEventListener("change", triggerRefresh);
  $("tasks-assigned").addEventListener("change", triggerRefresh);
  $("tasks-intent-id").addEventListener("change", triggerRefresh);

  void refresh();
  state.timer = setInterval(() => {
    void refresh();
  }, POLL_INTERVAL_MS);
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("DOMContentLoaded", init);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    deriveIntentosApiBase,
    canonicalizeJsonValue,
    validateCapabilityShape,
    loadCapabilityFromInput,
    buildIntentosRequestHeaders
  };
}
