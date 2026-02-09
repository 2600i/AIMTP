"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { RelayError } = require("./relay");
const { createMailboxStore, parseMailboxStoreType } = require("./mailbox");
const { validateEnvelope } = require("./validation");
const {
  createSignatureTrustConfig,
  evaluateEnvelopeSignaturePolicy
} = require("./signature");
const packageJson = require("../package.json");

const DEFAULT_PATH = "/aimtp";
const DEFAULT_HEALTH_PATH = "/healthz";
const DEFAULT_READY_PATH = "/readyz";
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_POLL_MAX = 1;
const MAX_POLL_LIMIT = 50;
const DEFAULT_CORS_ORIGINS = [
  "http://localhost:8080",
  "http://127.0.0.1:8080"
];
const RECIPIENT_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/;
const INTENTOS_UI_PATH = "/intentos/ui";
const INTENTOS_UI_APP_PATH = "/intentos/ui/app.js";
const INTENTOS_UI_STYLES_PATH = "/intentos/ui/styles.css";
const INTENTOS_UI_BASE_PLACEHOLDER = "__INTENTOS_UI_BASE_PATH__";

const trackedServers = new Set();
let shutdownHandlersRegistered = false;
let shutdownInProgress = false;

function registerShutdownHandlers() {
  if (shutdownHandlersRegistered) {
    return;
  }
  shutdownHandlersRegistered = true;
  ["SIGINT", "SIGTERM"].forEach((signal) => {
    process.on(signal, () => {
      shutdown(signal);
    });
  });
}

function shutdown(reason) {
  if (shutdownInProgress) {
    return;
  }
  shutdownInProgress = true;
  console.log(JSON.stringify({ event: "shutdown", reason }));

  const closePromises = Array.from(trackedServers).map(
    (server) =>
      new Promise((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        try {
          server.close(() => resolve());
        } catch (_err) {
          resolve();
        }
      })
  );

  Promise.all(closePromises)
    .then(() => {
      process.exit(0);
    })
    .catch(() => {
      process.exit(1);
    });
}

function parseEnvInt(value, fallback) {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseOptionalEnvInt(value, fallback) {
  if (typeof value !== "string" || value.trim() === "") {
    return fallback;
  }
  return parseEnvInt(value, fallback);
}

function parseOptionalNonNegativeEnvInt(value, fallback) {
  if (typeof value !== "string" || value.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function parseMailboxStoreOptions(options) {
  const storeEnv =
    process.env.AIMTP_STORE ||
    process.env.AIMTP_MAILBOX_STORE;
  const storeType = parseMailboxStoreType(
    options.mailboxStoreType || storeEnv
  );
  const sqlitePath =
    options.mailboxSqlitePath ||
    (process.env.AIMTP_MAILBOX_SQLITE_PATH && process.env.AIMTP_MAILBOX_SQLITE_PATH.trim());
  const ttlMs =
    typeof options.mailboxTtlMs === "number"
      ? options.mailboxTtlMs
      : parseOptionalEnvInt(process.env.AIMTP_MAILBOX_TTL_MS, undefined);
  const maxQueueLength =
    typeof options.mailboxMaxQueueLength === "number"
      ? options.mailboxMaxQueueLength
      : parseOptionalEnvInt(process.env.AIMTP_MAILBOX_MAX_QUEUE_LENGTH, undefined);
  const maxRecipients =
    typeof options.mailboxMaxRecipients === "number"
      ? options.mailboxMaxRecipients
      : parseOptionalEnvInt(process.env.AIMTP_MAILBOX_MAX_RECIPIENTS, undefined);
  const cleanupIntervalMs =
    typeof options.mailboxCleanupIntervalMs === "number"
      ? options.mailboxCleanupIntervalMs
      : parseOptionalEnvInt(process.env.AIMTP_MAILBOX_CLEANUP_INTERVAL_MS, 0);
  const leaseMs =
    typeof options.mailboxLeaseMs === "number"
      ? options.mailboxLeaseMs
      : parseOptionalEnvInt(process.env.AIMTP_MAILBOX_LEASE_MS, undefined);
  const maxRetries =
    typeof options.mailboxMaxRetries === "number"
      ? options.mailboxMaxRetries
      : parseOptionalNonNegativeEnvInt(process.env.AIMTP_MAILBOX_MAX_RETRIES, undefined);
  const retryBaseMs =
    typeof options.mailboxRetryBaseMs === "number"
      ? options.mailboxRetryBaseMs
      : parseOptionalNonNegativeEnvInt(process.env.AIMTP_MAILBOX_RETRY_BASE_MS, undefined);
  const retryMaxMs =
    typeof options.mailboxRetryMaxMs === "number"
      ? options.mailboxRetryMaxMs
      : parseOptionalNonNegativeEnvInt(process.env.AIMTP_MAILBOX_RETRY_MAX_MS, undefined);
  const redisUrl =
    options.redisUrl ||
    (process.env.AIMTP_REDIS_URL && process.env.AIMTP_REDIS_URL.trim());
  const redisHost =
    options.redisHost ||
    (process.env.AIMTP_REDIS_HOST && process.env.AIMTP_REDIS_HOST.trim());
  const redisPort =
    typeof options.redisPort === "number"
      ? options.redisPort
      : parseOptionalEnvInt(process.env.AIMTP_REDIS_PORT, undefined);
  const redisDb =
    typeof options.redisDb === "number"
      ? options.redisDb
      : parseOptionalEnvInt(process.env.AIMTP_REDIS_DB, undefined);
  const redisUsername =
    options.redisUsername ||
    (process.env.AIMTP_REDIS_USERNAME && process.env.AIMTP_REDIS_USERNAME.trim());
  const redisPassword =
    options.redisPassword ||
    (process.env.AIMTP_REDIS_PASSWORD && process.env.AIMTP_REDIS_PASSWORD.trim());
  const redisKeyPrefix =
    options.redisKeyPrefix ||
    (process.env.AIMTP_REDIS_KEY_PREFIX && process.env.AIMTP_REDIS_KEY_PREFIX.trim());
  const redisCliPath =
    options.redisCliPath ||
    (process.env.AIMTP_REDIS_CLI_PATH && process.env.AIMTP_REDIS_CLI_PATH.trim());
  const redisCommandTimeoutMs =
    typeof options.redisCommandTimeoutMs === "number"
      ? options.redisCommandTimeoutMs
      : parseOptionalEnvInt(process.env.AIMTP_REDIS_TIMEOUT_MS, undefined);
  const redisLockTtlMs =
    typeof options.redisLockTtlMs === "number"
      ? options.redisLockTtlMs
      : parseOptionalEnvInt(process.env.AIMTP_REDIS_LOCK_TTL_MS, undefined);
  const redisLockAcquireTimeoutMs =
    typeof options.redisLockAcquireTimeoutMs === "number"
      ? options.redisLockAcquireTimeoutMs
      : parseOptionalEnvInt(process.env.AIMTP_REDIS_LOCK_ACQUIRE_TIMEOUT_MS, undefined);
  const redisLockRetryDelayMs =
    typeof options.redisLockRetryDelayMs === "number"
      ? options.redisLockRetryDelayMs
      : parseOptionalEnvInt(process.env.AIMTP_REDIS_LOCK_RETRY_DELAY_MS, undefined);
  const redisLeaseResultTtlMs =
    typeof options.redisLeaseResultTtlMs === "number"
      ? options.redisLeaseResultTtlMs
      : parseOptionalEnvInt(process.env.AIMTP_REDIS_LEASE_RESULT_TTL_MS, undefined);
  const relayInstanceId =
    options.relayInstanceId ||
    (process.env.AIMTP_RELAY_INSTANCE_ID && process.env.AIMTP_RELAY_INSTANCE_ID.trim());

  return {
    storeType,
    sqlitePath,
    ttlMs,
    maxQueueLength,
    maxRecipients,
    cleanupIntervalMs,
    leaseMs,
    maxRetries,
    retryBaseMs,
    retryMaxMs,
    redisUrl,
    redisHost,
    redisPort,
    redisDb,
    redisUsername,
    redisPassword,
    redisKeyPrefix,
    redisCliPath,
    redisCommandTimeoutMs,
    redisLockTtlMs,
    redisLockAcquireTimeoutMs,
    redisLockRetryDelayMs,
    redisLeaseResultTtlMs,
    relayInstanceId
  };
}

function parseSignatureOptions(options) {
  return {
    policy: options.signaturePolicy,
    trustedKeys: options.trustedKeys,
    trustedKeysFile: options.trustedKeysFile,
    clockSkewSec:
      typeof options.signatureClockSkewSec === "number" ? options.signatureClockSkewSec : undefined
  };
}

function parseAllowlist(value) {
  if (typeof value !== "string") {
    return { enabled: false, set: new Set() };
  }
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return { enabled: entries.length > 0, set: new Set(entries) };
}

function parseRecipientKeys(value) {
  if (typeof value !== "string") {
    return { enabled: false, keyToRecipients: new Map() };
  }
  const keyToRecipients = new Map();
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  entries.forEach((entry) => {
    const separator = entry.indexOf(":");
    if (separator <= 0 || separator === entry.length - 1) {
      return;
    }
    const recipient = entry.slice(0, separator).trim();
    const key = entry.slice(separator + 1).trim();
    if (!recipient || !key) {
      return;
    }
    if (!keyToRecipients.has(key)) {
      keyToRecipients.set(key, new Set());
    }
    keyToRecipients.get(key).add(recipient);
  });
  return { enabled: keyToRecipients.size > 0, keyToRecipients };
}

function parseKeyRecipients(value) {
  if (typeof value !== "string") {
    return { enabled: false, keyToRecipients: new Map() };
  }
  const keyToRecipients = new Map();
  const entries = value
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  entries.forEach((entry) => {
    const separator = entry.indexOf("=");
    if (separator <= 0 || separator === entry.length - 1) {
      return;
    }
    const key = entry.slice(0, separator).trim();
    const recipientsRaw = entry.slice(separator + 1).trim();
    if (!key || !recipientsRaw) {
      return;
    }
    const recipients = recipientsRaw
      .split(",")
      .map((recipient) => recipient.trim())
      .filter((recipient) => recipient.length > 0);
    if (recipients.length === 0) {
      return;
    }
    if (!keyToRecipients.has(key)) {
      keyToRecipients.set(key, new Set());
    }
    const bucket = keyToRecipients.get(key);
    recipients.forEach((recipient) => bucket.add(recipient));
  });
  return { enabled: keyToRecipients.size > 0, keyToRecipients };
}

function mergeRecipientKeys() {
  const keyToRecipients = new Map();
  for (let i = 0; i < arguments.length; i += 1) {
    const entry = arguments[i];
    entry.keyToRecipients.forEach((recipients, key) => {
      if (!keyToRecipients.has(key)) {
        keyToRecipients.set(key, new Set());
      }
      const target = keyToRecipients.get(key);
      recipients.forEach((recipient) => target.add(recipient));
    });
  }
  return { enabled: keyToRecipients.size > 0, keyToRecipients };
}

function parseCorsOrigins(value) {
  if (typeof value !== "string") {
    return new Set(DEFAULT_CORS_ORIGINS);
  }
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return new Set(entries);
}

function appendVaryHeader(res, value) {
  const existing = res.getHeader("Vary");
  if (typeof existing === "string") {
    const values = existing.split(",").map((part) => part.trim());
    if (!values.includes(value)) {
      res.setHeader("Vary", `${existing}, ${value}`);
    }
    return;
  }
  if (Array.isArray(existing)) {
    const values = existing.map((part) => String(part).trim());
    if (!values.includes(value)) {
      values.push(value);
      res.setHeader("Vary", values.join(", "));
    }
    return;
  }
  res.setHeader("Vary", value);
}

function resolveAllowedOrigin(req, allowedOrigins) {
  const headerValue = firstHeaderValue(req.headers.origin);
  if (typeof headerValue !== "string") {
    return "";
  }
  const origin = headerValue.trim();
  if (!origin) {
    return "";
  }
  return allowedOrigins.has(origin) ? origin : "";
}

function setCorsHeaders(res, origin) {
  if (!origin) {
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  appendVaryHeader(res, "Origin");
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

function sendError(res, status, code, message, details) {
  const payload = { code, message };
  if (details !== undefined) {
    payload.details = details;
  }
  sendJson(res, status, payload);
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function extractAuthKey(req) {
  const direct = firstHeaderValue(req.headers["x-aimtp-key"]);
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  const authorization = firstHeaderValue(req.headers.authorization);
  if (typeof authorization !== "string") {
    return "";
  }
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return "";
  }
  const token = match[1].trim();
  return token ? token : "";
}

function evaluateAuth(req, authConfig) {
  const provided = extractAuthKey(req);
  if (!authConfig.enabled) {
    return {
      enabled: true,
      status: provided ? "invalid" : "missing",
      ok: false,
      allowedRecipients: null
    };
  }
  if (!provided) {
    return { enabled: true, status: "missing", ok: false, allowedRecipients: null };
  }
  if (authConfig.adminKey && provided === authConfig.adminKey) {
    return { enabled: true, status: "ok", ok: true, allowedRecipients: null };
  }
  const recipients = authConfig.keyToRecipients.get(provided);
  if (recipients) {
    return { enabled: true, status: "ok", ok: true, allowedRecipients: recipients };
  }
  return { enabled: true, status: "invalid", ok: false, allowedRecipients: null };
}

function isRecipientAuthorized(authResult, recipient) {
  if (!authResult.ok) {
    return false;
  }
  if (!authResult.allowedRecipients) {
    return true;
  }
  return authResult.allowedRecipients.has(recipient);
}

function parseMaxParam(value) {
  if (!value) {
    return DEFAULT_POLL_MAX;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_POLL_MAX;
  }
  return Math.min(parsed, MAX_POLL_LIMIT);
}

function buildAuthConfig(apiKey, recipientKeys) {
  return {
    enabled: Boolean(apiKey) || recipientKeys.enabled,
    adminKey: apiKey || "",
    keyToRecipients: recipientKeys.keyToRecipients
  };
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let finished = false;

    const cleanup = () => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
    };

    const drainRequest = () => {
      req.on("error", () => {});
      req.resume();
    };

    const onData = (chunk) => {
      if (finished) {
        return;
      }
      size += chunk.length;
      if (size > maxBytes) {
        finished = true;
        cleanup();
        reject(new RelayError("payload_too_large", "Request body too large"));
        drainRequest();
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf-8"));
    };

    const onError = (err) => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      reject(err);
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

function loadIntentosUiAssets() {
  const base = path.join(__dirname, "static", "intentos");
  return {
    indexTemplate: fs.readFileSync(path.join(base, "index.html"), "utf-8"),
    app: {
      contentType: "application/javascript; charset=utf-8",
      body: fs.readFileSync(path.join(base, "app.js"))
    },
    styles: {
      contentType: "text/css; charset=utf-8",
      body: fs.readFileSync(path.join(base, "styles.css"))
    }
  };
}

function trimTrailingSlash(pathname) {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function resolveIntentosUiBasePath(pathname) {
  if (typeof pathname !== "string" || pathname.length === 0) {
    return INTENTOS_UI_PATH;
  }
  let basePath = pathname;
  const indexSuffix = "/index.html";
  const appSuffix = "/app.js";
  const stylesSuffix = "/styles.css";
  if (basePath.endsWith(indexSuffix)) {
    basePath = basePath.slice(0, -indexSuffix.length);
  } else if (basePath.endsWith(appSuffix)) {
    basePath = basePath.slice(0, -appSuffix.length);
  } else if (basePath.endsWith(stylesSuffix)) {
    basePath = basePath.slice(0, -stylesSuffix.length);
  }
  basePath = trimTrailingSlash(basePath);
  if (!basePath.endsWith(INTENTOS_UI_PATH)) {
    return INTENTOS_UI_PATH;
  }
  return basePath;
}

function renderIntentosUiIndex(template, basePath) {
  const safeBasePath = trimTrailingSlash(basePath || INTENTOS_UI_PATH);
  return Buffer.from(
    template.split(INTENTOS_UI_BASE_PLACEHOLDER).join(safeBasePath),
    "utf-8"
  );
}

function resolveIntentosUiAsset(pathname, rawPath, assets) {
  if (
    pathname === INTENTOS_UI_PATH ||
    pathname === `${INTENTOS_UI_PATH}/` ||
    pathname === `${INTENTOS_UI_PATH}/index.html`
  ) {
    return {
      contentType: "text/html; charset=utf-8",
      body: renderIntentosUiIndex(
        assets.indexTemplate,
        resolveIntentosUiBasePath(rawPath)
      )
    };
  }
  if (pathname === INTENTOS_UI_APP_PATH) {
    return assets.app;
  }
  if (pathname === INTENTOS_UI_STYLES_PATH) {
    return assets.styles;
  }
  return null;
}

function isIntentosUiPath(pathname) {
  return (
    pathname === INTENTOS_UI_PATH ||
    pathname === `${INTENTOS_UI_PATH}/` ||
    pathname.startsWith(`${INTENTOS_UI_PATH}/`)
  );
}

function normalizePathname(pathname, relayPath) {
  if (typeof pathname !== "string" || pathname.length === 0) {
    return "/";
  }
  const cleanedRelayPath =
    relayPath && relayPath.length > 1 && relayPath.endsWith("/")
      ? relayPath.slice(0, -1)
      : relayPath;
  if (!cleanedRelayPath || cleanedRelayPath === "/") {
    return pathname;
  }
  if (pathname === cleanedRelayPath) {
    return "/";
  }
  const relayPrefix = `${cleanedRelayPath}/`;
  if (!pathname.startsWith(relayPrefix)) {
    return pathname;
  }
  return `/${pathname.slice(relayPrefix.length)}`;
}

function createWebhookRelayServer(relay, options = {}) {
  const relayBasePath =
    options.path ||
    (process.env.AIMTP_RELAY_PATH && process.env.AIMTP_RELAY_PATH.trim()) ||
    DEFAULT_PATH;
  const relayPath =
    relayBasePath.length > 1 && relayBasePath.endsWith("/")
      ? relayBasePath.slice(0, -1)
      : relayBasePath;
  const peekPath = `${relayPath}/peek`;
  const pollPath = `${relayPath}/poll`;
  const mailboxPath = `${relayPath}/mailbox`;
  const ackPath = `${relayPath}/ack`;
  const failPath = `${relayPath}/fail`;
  const deadPath = `${relayPath}/dead`;
  const healthPath =
    options.healthPath ||
    (process.env.AIMTP_HEALTH_PATH && process.env.AIMTP_HEALTH_PATH.trim()) ||
    DEFAULT_HEALTH_PATH;
  const readyPath =
    options.readyPath ||
    (process.env.AIMTP_READY_PATH && process.env.AIMTP_READY_PATH.trim()) ||
    DEFAULT_READY_PATH;
  const normalizedRelayPath = normalizePathname(relayPath, relayPath);
  const normalizedPeekPath = normalizePathname(peekPath, relayPath);
  const normalizedPollPath = normalizePathname(pollPath, relayPath);
  const normalizedMailboxPath = normalizePathname(mailboxPath, relayPath);
  const normalizedAckPath = normalizePathname(ackPath, relayPath);
  const normalizedFailPath = normalizePathname(failPath, relayPath);
  const normalizedDeadPath = normalizePathname(deadPath, relayPath);
  const normalizedHealthPath = normalizePathname(healthPath, relayPath);
  const normalizedReadyPath = normalizePathname(readyPath, relayPath);
  const maxBytes =
    typeof options.maxBytes === "number"
      ? options.maxBytes
      : parseEnvInt(process.env.AIMTP_MAX_BODY_BYTES, DEFAULT_MAX_BYTES);
  const apiKey = process.env.AIMTP_API_KEY ? process.env.AIMTP_API_KEY.trim() : "";
  const legacyRecipientKeys = parseRecipientKeys(process.env.AIMTP_RECIPIENT_KEYS);
  const keyedRecipientKeys = parseKeyRecipients(process.env.AIMTP_KEY_RECIPIENTS);
  const recipientKeys = mergeRecipientKeys(legacyRecipientKeys, keyedRecipientKeys);
  const authConfig = buildAuthConfig(apiKey, recipientKeys);
  const corsOrigins = parseCorsOrigins(process.env.AIMTP_CORS_ORIGINS);
  const allowlistDisabled = process.env.AIMTP_ALLOWLIST_RECIPIENTS === "0";
  const parsedAllowlist = parseAllowlist(process.env.AIMTP_ALLOWED_RECIPIENTS);
  const recipientAllowlist = allowlistDisabled
    ? { enabled: false, set: new Set() }
    : parsedAllowlist;
  const senderAllowlist = parseAllowlist(process.env.AIMTP_ALLOWED_SENDERS);
  const mailboxStoreOptions = parseMailboxStoreOptions(options);
  const signatureOptions = parseSignatureOptions(options);
  const signatureConfig = createSignatureTrustConfig({
    ...signatureOptions,
    logger: options.logger || console
  });
  const relayInstanceId = mailboxStoreOptions.relayInstanceId || `relay-${process.pid}`;
  const mailbox =
    options.mailbox ||
    options.mailboxStore ||
    createMailboxStore({
      type: mailboxStoreOptions.storeType,
      sqlitePath: mailboxStoreOptions.sqlitePath,
      ttlMs: mailboxStoreOptions.ttlMs,
      maxQueueLength: mailboxStoreOptions.maxQueueLength,
      maxRecipients: mailboxStoreOptions.maxRecipients,
      leaseMs: mailboxStoreOptions.leaseMs,
      maxRetries: mailboxStoreOptions.maxRetries,
      retryBaseMs: mailboxStoreOptions.retryBaseMs,
      retryMaxMs: mailboxStoreOptions.retryMaxMs,
      redisUrl: mailboxStoreOptions.redisUrl,
      redisHost: mailboxStoreOptions.redisHost,
      redisPort: mailboxStoreOptions.redisPort,
      redisDb: mailboxStoreOptions.redisDb,
      redisUsername: mailboxStoreOptions.redisUsername,
      redisPassword: mailboxStoreOptions.redisPassword,
      redisKeyPrefix: mailboxStoreOptions.redisKeyPrefix,
      redisCliPath: mailboxStoreOptions.redisCliPath,
      redisCommandTimeoutMs: mailboxStoreOptions.redisCommandTimeoutMs,
      redisLockTtlMs: mailboxStoreOptions.redisLockTtlMs,
      redisLockAcquireTimeoutMs: mailboxStoreOptions.redisLockAcquireTimeoutMs,
      redisLockRetryDelayMs: mailboxStoreOptions.redisLockRetryDelayMs,
      redisLeaseResultTtlMs: mailboxStoreOptions.redisLeaseResultTtlMs,
      relayInstanceId,
      now: options.now,
      logger: options.logger || console
    });
  const summaryIntervalMs =
    typeof options.logSummaryIntervalMs === "number"
      ? options.logSummaryIntervalMs
      : parseOptionalNonNegativeEnvInt(process.env.AIMTP_LOG_SUMMARY_INTERVAL_MS, undefined);
  const counters = {
    enqueue: 0,
    poll: 0,
    ack: 0,
    fail: 0,
    dead_letter: 0
  };
  const recordCounter = (name, value, fields) => {
    if (!Number.isFinite(value) || value <= 0) {
      return;
    }
    counters[name] += value;
    const record = {
      event: "counter",
      name,
      value,
      relay_instance_id: relayInstanceId
    };
    if (fields && typeof fields === "object") {
      Object.assign(record, fields);
    }
    console.log(JSON.stringify(record));
  };
  let summaryTimer = null;
  if (summaryIntervalMs && summaryIntervalMs > 0) {
    summaryTimer = setInterval(() => {
      console.log(
        JSON.stringify({
          event: "summary",
          relay_instance_id: relayInstanceId,
          uptime_sec: Math.floor(process.uptime()),
          counters: { ...counters }
        })
      );
    }, summaryIntervalMs);
    summaryTimer.unref();
  }
  let cleanupTimer = null;
  const defaultHandler = (envelope, context) => ({
    __aimtpAccepted: true,
    status: "accepted",
    id: envelope.id,
    recipient: context.recipient
  });
  defaultHandler.__aimtpDefault = true;

  console.log(
    JSON.stringify({
      event: "allowlist_state",
      enabled: recipientAllowlist.enabled,
      key_count: recipientKeys.keyToRecipients.size,
      relay_instance_id: relayInstanceId,
      signature_policy: signatureConfig.policy,
      trusted_key_count: signatureConfig.trustedKeys.size
    })
  );

  if (recipientAllowlist.enabled) {
    recipientAllowlist.set.forEach((recipient) => {
      if (!relay.registry.get(recipient)) {
        relay.registerAgent(recipient, defaultHandler);
      }
    });
    console.log(
      JSON.stringify({
        event: "allowlist_recipients",
        count: recipientAllowlist.set.size
      })
    );
  }

  const intentosEnabled = String(process.env.INTENTOS || "").trim().toLowerCase() === "on";
  let intentosUiAssets = null;
  if (intentosEnabled) {
    try {
      intentosUiAssets = loadIntentosUiAssets();
    } catch (_err) {
      intentosUiAssets = null;
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const rawPath = url.pathname;
    const requestPath = normalizePathname(rawPath, relayPath);

    if (requestPath === normalizedHealthPath) {
      if (req.method !== "GET") {
        sendError(res, 405, "method_not_allowed", "Method not allowed");
        return;
      }
      sendJson(res, 200, {
        status: "ok",
        service: "aimtp-relay",
        version: packageJson.version,
        uptime_sec: Math.floor(process.uptime()),
        timestamp: new Date().toISOString()
      });
      return;
    }
    if (requestPath === normalizedReadyPath) {
      if (req.method !== "GET") {
        sendError(res, 405, "method_not_allowed", "Method not allowed");
        return;
      }
      if (server.listening) {
        sendJson(res, 200, { status: "ready" });
      } else {
        sendJson(res, 503, { status: "not_ready" });
      }
      return;
    }

    if (isIntentosUiPath(requestPath)) {
      if (!intentosEnabled) {
        sendError(res, 404, "not_found", "Not Found");
        return;
      }
      if (req.method !== "GET") {
        sendError(res, 405, "method_not_allowed", "Method not allowed");
        return;
      }
      const asset = intentosUiAssets
        ? resolveIntentosUiAsset(requestPath, rawPath, intentosUiAssets)
        : null;
      if (!asset) {
        sendError(res, 404, "not_found", "Not Found");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", asset.contentType);
      res.setHeader("Content-Length", asset.body.length);
      res.end(asset.body);
      return;
    }

    const authResult = evaluateAuth(req, authConfig);
    const authStatus = authResult.status;
    let logEnvelope = null;
    const logRequest = (status) => {
      const envelope = logEnvelope || {};
      const record = {
        id: envelope.id || "-",
        intent: envelope.intent || "-",
        sender: envelope.sender || "-",
        recipient: envelope.recipient || "-",
        status,
        auth: authStatus
      };
      console.log(JSON.stringify(record));
    };
    const logMailbox = (status, recipient, count) => {
      const record = {
        recipient: recipient || "-",
        count: typeof count === "number" ? count : "-",
        status,
        auth: authStatus
      };
      console.log(JSON.stringify(record));
    };

  const isPeek = requestPath === normalizedPeekPath;
  const isPoll = requestPath === normalizedPollPath;
  const isDead = requestPath === normalizedDeadPath;
  const isAck = requestPath === normalizedAckPath;
  const isFail = requestPath === normalizedFailPath;
  const isMailboxPath = requestPath === normalizedMailboxPath;
  const isRelayPath = requestPath === normalizedRelayPath;

  if (!isPeek && !isPoll && !isDead && !isAck && !isFail && !isMailboxPath && !isRelayPath) {
    sendError(res, 404, "not_found", "Not Found");
    logRequest(404);
    return;
  }

    const allowedOrigin = resolveAllowedOrigin(req, corsOrigins);
    if (req.method === "OPTIONS") {
      if (!allowedOrigin) {
        sendError(res, 403, "forbidden", "Origin not allowed");
        if (isPeek || isPoll || isDead) {
          logMailbox(403);
        } else {
          logRequest(403);
        }
        return;
      }
      setCorsHeaders(res, allowedOrigin);
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization,Content-Type,X-AIMTP-KEY"
      );
      res.setHeader("Access-Control-Max-Age", "600");
      res.statusCode = 204;
      res.end();
      if (isPeek || isPoll || isDead) {
        logMailbox(204);
      } else {
        logRequest(204);
      }
      return;
    }

    if (allowedOrigin) {
      setCorsHeaders(res, allowedOrigin);
    }

    if (authResult.enabled && !authResult.ok) {
      if (authStatus === "missing") {
        sendError(res, 401, "unauthorized", "Missing API key");
        if (isPeek || isPoll || isDead) {
          logMailbox(401);
        } else {
          logRequest(401);
        }
        return;
      }
      sendError(res, 403, "forbidden", "Invalid API key");
      if (isPeek || isPoll || isDead) {
        logMailbox(403);
      } else {
        logRequest(403);
      }
      return;
    }

    if (isPeek || isPoll || isDead) {
      if (req.method !== "GET") {
        sendError(res, 405, "method_not_allowed", "Method not allowed");
        logMailbox(405);
        return;
      }

      const recipientParam = url.searchParams.get("recipient");
      const recipient = recipientParam ? recipientParam.trim() : "";
      if (!recipient) {
        sendError(res, 400, "invalid_request", "Recipient is required", {
          recipient: null
        });
        logMailbox(400);
        return;
      }
      if (recipientAllowlist.enabled) {
        if (!recipientAllowlist.set.has(recipient)) {
          sendError(res, 404, "unknown_recipient", `Unknown recipient: ${recipient}`, {
            recipient
          });
          logMailbox(404, recipient);
          return;
        }
      } else {
        if (!RECIPIENT_PATTERN.test(recipient)) {
          sendError(res, 400, "invalid_request", "Recipient format is invalid", {
            recipient
          });
          logMailbox(400, recipient);
          return;
        }
      }
      if (!isRecipientAuthorized(authResult, recipient)) {
        sendError(res, 403, "forbidden", "Recipient access denied", { recipient });
        logMailbox(403, recipient);
        return;
      }

      if (isPeek) {
        const result = mailbox.peek(recipient);
        sendJson(res, 200, {
          recipient,
          count: result.count,
          pending: result.pending,
          leased: result.leased,
          dead_letters: result.deadLetters
        });
        logMailbox(200, recipient, result.count);
        return;
      }

      const maxItems = parseMaxParam(url.searchParams.get("max"));
      if (isDead) {
        const items = mailbox.pollDeadLetters(recipient, maxItems);
        const response = items.map((item) => ({
          envelope: item.envelope,
          enqueued_at: new Date(item.enqueuedAt).toISOString(),
          failed_at: new Date(item.failedAt).toISOString(),
          retry_count: item.retryCount,
          delivery_attempt: item.deliveryAttempt,
          last_error: item.lastError
        }));
        sendJson(res, 200, response);
        logMailbox(200, recipient, items.length);
        return;
      }

      const items = mailbox.poll(recipient, maxItems);
      const response = items.map((item) => ({
        envelope: item.envelope,
        lease_id: item.leaseId,
        lease_expires_at: new Date(item.leaseExpiresAt).toISOString(),
        retry_count: item.retryCount,
        delivery_attempt: item.deliveryAttempt
      }));
      sendJson(res, 200, response);
      logMailbox(200, recipient, items.length);
      recordCounter("poll", items.length, { recipient });
      return;
    }

    if (isMailboxPath) {
      if (req.method !== "POST") {
        sendError(res, 405, "method_not_allowed", "Method not allowed");
        logRequest(405);
        return;
      }

      let payload;
      try {
        const raw = await readRequestBody(req, maxBytes);
        payload = JSON.parse(raw);
      } catch (err) {
        if (err instanceof RelayError && err.code === "payload_too_large") {
          sendError(res, 413, "payload_too_large", err.message);
          logRequest(413);
          return;
        }
        sendError(res, 400, "invalid_json", "Invalid JSON payload");
        logRequest(400);
        return;
      }

      const recipient =
        payload && typeof payload.recipient === "string" ? payload.recipient.trim() : "";
      if (!recipient) {
        sendError(res, 400, "invalid_request", "Recipient is required", {
          recipient: null
        });
        logRequest(400);
        return;
      }
      if (!RECIPIENT_PATTERN.test(recipient)) {
        sendError(res, 400, "invalid_request", "Recipient format is invalid", {
          recipient
        });
        logRequest(400);
        return;
      }
      if (recipientAllowlist.enabled && !recipientAllowlist.set.has(recipient)) {
        sendError(res, 404, "unknown_recipient", `Unknown recipient: ${recipient}`, {
          recipient
        });
        logRequest(404);
        return;
      }
      if (!isRecipientAuthorized(authResult, recipient)) {
        sendError(res, 403, "forbidden", "Recipient access denied", { recipient });
        logRequest(403);
        return;
      }

      const message = payload ? payload.message ?? payload.payload : undefined;
      if (message === undefined) {
        sendError(res, 400, "invalid_request", "Message payload is required");
        logRequest(400);
        return;
      }

      mailbox.enqueue(recipient, message);
      const id =
        message && typeof message === "object" && Object.prototype.hasOwnProperty.call(message, "id")
          ? message.id
          : undefined;

      sendJson(res, 200, {
        ok: true,
        recipient,
        id
      });
      logRequest(200);
      recordCounter("enqueue", 1, { recipient, path: "mailbox" });
      return;
    }

    if (isAck || isFail) {
      if (req.method !== "POST") {
        sendError(res, 405, "method_not_allowed", "Method not allowed");
        logRequest(405);
        return;
      }

      let payload;
      try {
        const raw = await readRequestBody(req, maxBytes);
        payload = JSON.parse(raw);
      } catch (err) {
        if (err instanceof RelayError && err.code === "payload_too_large") {
          sendError(res, 413, "payload_too_large", err.message);
          logRequest(413);
          return;
        }
        sendError(res, 400, "invalid_json", "Invalid JSON payload");
        logRequest(400);
        return;
      }

      const recipient =
        payload && typeof payload.recipient === "string" ? payload.recipient.trim() : "";
      if (!recipient) {
        sendError(res, 400, "invalid_request", "Recipient is required", {
          recipient: null
        });
        logRequest(400);
        return;
      }
      if (!RECIPIENT_PATTERN.test(recipient)) {
        sendError(res, 400, "invalid_request", "Recipient format is invalid", {
          recipient
        });
        logRequest(400);
        return;
      }
      if (recipientAllowlist.enabled && !recipientAllowlist.set.has(recipient)) {
        sendError(res, 404, "unknown_recipient", `Unknown recipient: ${recipient}`, {
          recipient
        });
        logRequest(404);
        return;
      }
      if (!isRecipientAuthorized(authResult, recipient)) {
        sendError(res, 403, "forbidden", "Recipient access denied", { recipient });
        logRequest(403);
        return;
      }

      const leaseId =
        payload && typeof payload.lease_id === "string" ? payload.lease_id.trim() : "";
      if (!leaseId) {
        sendError(res, 400, "invalid_request", "Lease id is required");
        logRequest(400);
        return;
      }

      if (isAck) {
        const result = mailbox.ack(recipient, leaseId);
        if (!result.ok && result.status === "unknown_lease") {
          sendError(res, 404, "unknown_lease", "Lease not found");
          logRequest(404);
          return;
        }
        if (!result.ok && result.status === "expired") {
          sendError(res, 409, "lease_expired", "Lease has expired");
          logRequest(409);
          return;
        }
        sendJson(res, 200, { ok: true, status: "acknowledged" });
        logRequest(200);
        if (result.ok) {
          recordCounter("ack", 1, { recipient });
        }
        return;
      }

      const reason = payload && typeof payload.reason === "string" ? payload.reason.trim() : undefined;
      const result = mailbox.fail(recipient, leaseId, reason);
      if (!result.ok && result.status === "unknown_lease") {
        sendError(res, 404, "unknown_lease", "Lease not found");
        logRequest(404);
        return;
      }
      if (!result.ok && result.status === "expired") {
        sendError(res, 409, "lease_expired", "Lease has expired");
        logRequest(409);
        return;
      }
      sendJson(res, 200, {
        ok: true,
        status: result.status,
        retry_count: result.retryCount || 0
      });
      logRequest(200);
      if (result.ok) {
        recordCounter("fail", 1, { recipient, status: result.status });
        if (result.status === "dead_lettered") {
          recordCounter("dead_letter", 1, { recipient });
        }
      }
      return;
    }

    if (req.method !== "POST") {
      sendError(res, 405, "method_not_allowed", "Method not allowed");
      logRequest(405);
      return;
    }

    let payload;
    try {
      const raw = await readRequestBody(req, maxBytes);
      payload = JSON.parse(raw);
      const isEnvelopeObject =
        payload && typeof payload === "object" && !Array.isArray(payload);
      if (isEnvelopeObject) {
        logEnvelope = payload;
      }
    } catch (err) {
      if (err instanceof RelayError && err.code === "payload_too_large") {
        sendError(res, 413, "payload_too_large", err.message);
        logRequest(413);
        return;
      }
      sendError(res, 400, "invalid_json", "Invalid JSON payload");
      logRequest(400);
      return;
    }

    const validationErrors = validateEnvelope(payload);
    if (validationErrors.length > 0) {
      sendError(
        res,
        400,
        "invalid_schema",
        "Envelope failed schema validation",
        { errors: validationErrors }
      );
      logRequest(400);
      return;
    }

    const signatureDecision = evaluateEnvelopeSignaturePolicy(payload, signatureConfig);
    if (signatureDecision.warning) {
      console.log(
        JSON.stringify({
          event: "signature_warning",
          code: signatureDecision.warning.code,
          message: signatureDecision.warning.message,
          details: signatureDecision.warning.details,
          envelope_id: payload && typeof payload.id === "string" ? payload.id : "-"
        })
      );
    }
    if (!signatureDecision.allowed && signatureDecision.error) {
      sendError(
        res,
        signatureDecision.error.httpStatus || 403,
        signatureDecision.error.code || "signature_invalid",
        signatureDecision.error.message || "Signature validation failed",
        signatureDecision.error.details
      );
      logRequest(signatureDecision.error.httpStatus || 403);
      return;
    }

    const recipient =
      payload && typeof payload.recipient === "string" ? payload.recipient.trim() : "";
    if (!recipient) {
      sendError(res, 400, "missing_recipient", "Recipient is required", {
        recipient: null
      });
      logRequest(400);
      return;
    }

    if (senderAllowlist.enabled) {
      const sender = typeof payload.sender === "string" ? payload.sender.trim() : "";
      if (!sender) {
        sendError(res, 403, "unknown_sender", "Sender is required", { sender: null });
        logRequest(403);
        return;
      }
      if (!senderAllowlist.set.has(sender)) {
        sendError(res, 403, "unknown_sender", `Unknown sender: ${sender}`, {
          sender
        });
        logRequest(403);
        return;
      }
    }

    if (recipientAllowlist.enabled) {
      if (!recipientAllowlist.set.has(recipient)) {
        sendError(res, 404, "unknown_recipient", `Unknown recipient: ${recipient}`, {
          recipient
        });
        logRequest(404);
        return;
      }
    } else {
      const handler =
        relay && relay.registry && typeof relay.registry.get === "function"
          ? relay.registry.get(recipient)
          : null;
      if (!handler) {
        sendError(res, 404, "unknown_recipient", `Unknown recipient: ${recipient}`, {
          recipient
        });
        logRequest(404);
        return;
      }
    }

    if (!isRecipientAuthorized(authResult, recipient)) {
      sendError(res, 403, "forbidden", "Recipient access denied", { recipient });
      logRequest(403);
      return;
    }

    const enqueueResult = mailbox.enqueue(recipient, payload);
    sendJson(res, 202, {
      status: "accepted",
      id: payload.id,
      recipient,
      queued: true,
      queue_depth: enqueueResult.queueDepth
    });
    logRequest(202);
    recordCounter("enqueue", 1, { recipient, path: "relay" });
  });

  trackedServers.add(server);
  if (
    mailboxStoreOptions.cleanupIntervalMs > 0 &&
    mailbox &&
    typeof mailbox.cleanupExpired === "function"
  ) {
    cleanupTimer = setInterval(() => {
      try {
        mailbox.cleanupExpired();
      } catch (err) {
        if (options.logger && typeof options.logger.log === "function") {
          options.logger.log(`mailbox_cleanup_failed error=${err && err.message ? err.message : err}`);
        }
      }
    }, mailboxStoreOptions.cleanupIntervalMs);
    if (typeof cleanupTimer.unref === "function") {
      cleanupTimer.unref();
    }
  }
  server.on("close", () => {
    if (cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
    if (summaryTimer) {
      clearInterval(summaryTimer);
      summaryTimer = null;
    }
    if (mailbox && typeof mailbox.close === "function") {
      mailbox.close();
    }
    trackedServers.delete(server);
  });
  registerShutdownHandlers();
  return server;
}

module.exports = {
  createWebhookRelayServer
};
