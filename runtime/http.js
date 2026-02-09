"use strict";

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { RelayError } = require("./relay");
const { createMailboxStore, parseMailboxStoreType } = require("./mailbox");
const { createIntentStore } = require("./intentos");
const { validateEnvelope } = require("./validation");
const {
  createSignatureTrustConfig,
  evaluateEnvelopeSignaturePolicy
} = require("./signature");
const { createIdentityVerifier } = require("./identity");
const { evaluateCapability } = require("./capabilities");
const {
  buildRelayDescriptor,
  isTrustEntryExpired,
  isLocalRecipient,
  loadTrustPolicy,
  parseFederationConfig,
  resolveDestinationRelayId,
  stableJsonStringify,
  validateHopLimit,
  verifyRelayDescriptor
} = require("./federation");
const packageJson = require("../package.json");

const DEFAULT_PATH = "/aimtp";
const DEFAULT_HEALTH_PATH = "/healthz";
const DEFAULT_READY_PATH = "/readyz";
const DEFAULT_INTENTOS_PATH = "/intentos";
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_POLL_MAX = 1;
const MAX_POLL_LIMIT = 50;
const DEFAULT_CORS_ORIGINS = [
  "http://localhost:8080",
  "http://127.0.0.1:8080"
];
const RECIPIENT_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

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

function parseIdentityMode(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "log") {
    return "log";
  }
  if (normalized === "enforce") {
    return "enforce";
  }
  return fallback;
}

function parseCapabilityMode(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "log") {
    return "log";
  }
  if (normalized === "enforce") {
    return "enforce";
  }
  return fallback;
}

function parseIntentosMode(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "log") {
    return "log";
  }
  if (normalized === "enforce") {
    return "enforce";
  }
  return fallback;
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

function parseIntentosLimit(value) {
  if (!value) {
    return 50;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 50;
  }
  return Math.min(parsed, 500);
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

async function readJson(req, maxBytes) {
  const raw = await readRequestBody(req, maxBytes);
  try {
    return JSON.parse(raw);
  } catch (_err) {
    throw new RelayError("invalid_json", "Invalid JSON payload");
  }
}

function extractIntentosAuthEnvelope(payload, defaults = {}) {
  const envelope = {};
  if (isPlainObject(payload && payload.envelope)) {
    Object.assign(envelope, payload.envelope);
  }

  if (!Object.prototype.hasOwnProperty.call(envelope, "identity") && isPlainObject(payload && payload.identity)) {
    envelope.identity = payload.identity;
  }
  if (!Object.prototype.hasOwnProperty.call(envelope, "proof") && isPlainObject(payload && payload.proof)) {
    envelope.proof = payload.proof;
  }
  if (
    !Object.prototype.hasOwnProperty.call(envelope, "capabilities") &&
    isPlainObject(payload && payload.capabilities)
  ) {
    envelope.capabilities = payload.capabilities;
  }
  if (!Object.prototype.hasOwnProperty.call(envelope, "sender") && typeof payload.sender === "string") {
    envelope.sender = payload.sender.trim();
  }
  if (!Object.prototype.hasOwnProperty.call(envelope, "id") && typeof payload.id === "string") {
    envelope.id = payload.id.trim();
  }

  if (!envelope.id && defaults.id) {
    envelope.id = defaults.id;
  }
  if (!envelope.intent && defaults.intent) {
    envelope.intent = defaults.intent;
  }

  return envelope;
}

function postJsonWithTimeout(endpoint, pathname, payload, options = {}) {
  const url = new URL(pathname, endpoint);
  const body = JSON.stringify(payload);
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 5000;
  const transport = url.protocol === "https:" ? https : http;
  const headers = Object.assign(
    {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body)
    },
    options.headers || {}
  );

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsedBody = null;
          if (raw) {
            try {
              parsedBody = JSON.parse(raw);
            } catch (_err) {
              parsedBody = { raw };
            }
          }
          resolve({
            status: typeof res.statusCode === "number" ? res.statusCode : 502,
            body: parsedBody
          });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function createWebhookRelayServer(relay, options = {}) {
  const path =
    options.path ||
    (process.env.AIMTP_RELAY_PATH && process.env.AIMTP_RELAY_PATH.trim()) ||
    DEFAULT_PATH;
  const relayPath =
    path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const peekPath = `${relayPath}/peek`;
  const pollPath = `${relayPath}/poll`;
  const mailboxPath = `${relayPath}/mailbox`;
  const ackPath = `${relayPath}/ack`;
  const failPath = `${relayPath}/fail`;
  const deadPath = `${relayPath}/dead`;
  const intentosPath =
    options.intentosPath ||
    (process.env.INTENTOS_PATH && process.env.INTENTOS_PATH.trim()) ||
    DEFAULT_INTENTOS_PATH;
  const intentSubmitPath = `${intentosPath}/intent`;
  const intentListPath = `${intentosPath}/intents`;
  const intentTaskPath = `${intentosPath}/task`;
  const healthPath =
    options.healthPath ||
    (process.env.AIMTP_HEALTH_PATH && process.env.AIMTP_HEALTH_PATH.trim()) ||
    DEFAULT_HEALTH_PATH;
  const readyPath =
    options.readyPath ||
    (process.env.AIMTP_READY_PATH && process.env.AIMTP_READY_PATH.trim()) ||
    DEFAULT_READY_PATH;
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
  const identityEnabled = process.env.AIMTP_IDENTITY === "on";
  const identityMode = identityEnabled
    ? parseIdentityMode(
      typeof options.identityMode === "string" ? options.identityMode : process.env.AIMTP_IDENTITY_MODE,
      "log"
    )
    : "off";
  const identityEnforce = identityEnabled && identityMode === "enforce";
  const identityVerifier = identityEnabled ? createIdentityVerifier() : null;
  const capabilitiesEnabled = process.env.AIMTP_CAPABILITIES === "on";
  const capabilityMode = capabilitiesEnabled
    ? parseCapabilityMode(
      typeof options.capabilityMode === "string" ? options.capabilityMode : process.env.AIMTP_CAP_MODE,
      "log"
    )
    : "off";
  const capabilityEnforce = capabilitiesEnabled && capabilityMode === "enforce";
  const capabilityClockSkewSec =
    typeof options.capabilityClockSkewSec === "number"
      ? options.capabilityClockSkewSec
      : parseOptionalNonNegativeEnvInt(process.env.AIMTP_CAP_CLOCK_SKEW_SEC, 0);
  const capabilityAudience =
    typeof options.capabilityAudience === "string" && options.capabilityAudience.trim()
      ? options.capabilityAudience.trim()
      : process.env.AIMTP_CAP_AUDIENCE && process.env.AIMTP_CAP_AUDIENCE.trim()
        ? process.env.AIMTP_CAP_AUDIENCE.trim()
        : "";
  const capabilityIdentityVerifier = capabilitiesEnabled
    ? createIdentityVerifier({ clockSkewSec: capabilityClockSkewSec })
    : null;
  const intentosEnabled =
    options.intentosEnabled === true ||
    (typeof options.intentosEnabled !== "boolean" && process.env.INTENTOS === "on");
  const intentosMode = intentosEnabled
    ? parseIntentosMode(
      typeof options.intentosMode === "string" ? options.intentosMode : process.env.INTENTOS_MODE,
      "log"
    )
    : "off";
  const intentosEnforce = intentosEnabled && intentosMode === "enforce";
  const intentosBoxId =
    typeof options.intentosBoxId === "string" && options.intentosBoxId.trim()
      ? options.intentosBoxId.trim()
      : typeof process.env.INTENTOS_BOX_ID === "string" && process.env.INTENTOS_BOX_ID.trim()
        ? process.env.INTENTOS_BOX_ID.trim()
        : "default";
  const intentosAudience =
    typeof options.intentosAudience === "string" && options.intentosAudience.trim()
      ? options.intentosAudience.trim()
      : capabilityAudience;
  const intentosStore = intentosEnabled
    ? options.intentosStore || createIntentStore({ boxId: intentosBoxId, now: options.now })
    : null;
  const intentosIdentityVerifier = createIdentityVerifier({
    clockSkewSec: capabilityClockSkewSec
  });
  const testModeEnabled =
    process.env.AIMTP_TEST_MODE === "on" || process.env.NODE_ENV === "test";
  const federationConfig = parseFederationConfig({
    enabled: options.federationEnabled,
    relayId: options.relayId,
    relayEndpoint: options.relayEndpoint,
    trustedRelaysPath: options.trustedRelaysPath,
    trustPolicyMode: options.trustPolicyMode,
    descriptorTtlSec: options.descriptorTtlSec,
    clockSkewSec: options.federationClockSkewSec,
    forwardTimeoutMs: options.federationTimeoutMs,
    localDomains: options.localDomains,
    relayPublicKey: options.relayPublicKey,
    relayPrivateKey: options.relayPrivateKey,
    allowHttpEndpoints: options.allowInsecureFederation === true || testModeEnabled
  });
  if (federationConfig.enabled && federationConfig.errors.length > 0) {
    throw new Error(`Federation config error: ${federationConfig.errors.join("; ")}`);
  }
  const descriptorPath = "/.well-known/aimtp-relay.json";
  const federationEnvelopePath = "/federation/envelope";
  const loadCurrentTrustPolicy = () =>
    loadTrustPolicy(federationConfig.trustedRelaysPath, {
      allowHttpEndpoints: federationConfig.allowHttpEndpoints
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
  const logFederation = (event, fields) => {
    const record = {
      event,
      relay_instance_id: relayInstanceId
    };
    if (fields && typeof fields === "object") {
      Object.assign(record, fields);
    }
    console.log(JSON.stringify(record));
  };
  const logCapability = (event, fields) => {
    const record = {
      event,
      relay_instance_id: relayInstanceId
    };
    if (fields && typeof fields === "object") {
      Object.assign(record, fields);
    }
    console.log(JSON.stringify(record));
  };
  const sendUnauthorized = (res, statusCode, reasonCode, message) => {
    sendJson(res, statusCode, {
      code: "unauthorized",
      reason_code: reasonCode,
      message
    });
  };
  const logIntentos = (event, fields) => {
    const record = {
      event,
      relay_instance_id: relayInstanceId
    };
    if (fields && typeof fields === "object") {
      Object.assign(record, fields);
    }
    console.log(JSON.stringify(record));
  };
  const verifyIntentosAuthorization = (res, source, payload, authRequest) => {
    const envelope = extractIntentosAuthEnvelope(payload, {
      intent: authRequest.action
    });
    const identityResult = intentosIdentityVerifier.verifyEnvelopeIdentity(envelope);
    const identity =
      envelope && isPlainObject(envelope.identity) ? envelope.identity : null;
    const proof = envelope && isPlainObject(envelope.proof) ? envelope.proof : null;
    const identityPresent = identity !== null || proof !== null;
    const identityId =
      identity && typeof identity.id === "string" && identity.id.trim() ? identity.id.trim() : "";

    if (identityPresent || intentosEnforce) {
      logIntentos("intentos_identity_verification", {
        source,
        action: authRequest.action,
        resource: authRequest.resource,
        outcome: identityResult.ok ? "ok" : "fail",
        reason_code: identityResult.code,
        principal: identityId || "-"
      });
    }

    const missingIdentity =
      identityResult.code === "identity_not_present" ||
      identityResult.code === "identity_missing" ||
      identityResult.code === "identity_proof_missing";
    if (intentosEnforce && missingIdentity) {
      sendUnauthorized(
        res,
        401,
        "identity_required",
        "identity and proof are required for IntentOS enforcement"
      );
      return { ok: false, statusCode: 401 };
    }
    if (intentosEnforce && !identityResult.ok) {
      sendUnauthorized(
        res,
        403,
        "identity_verification_failed",
        "identity verification failed for IntentOS request"
      );
      return { ok: false, statusCode: 403 };
    }

    const capabilityPresentation =
      envelope && isPlainObject(envelope.capabilities) ? envelope.capabilities : null;
    if (!capabilityPresentation) {
      if (intentosEnforce) {
        logIntentos("intentos_capability_authorization", {
          source,
          action: authRequest.action,
          resource: authRequest.resource,
          outcome: "deny",
          reason_code: "capability_missing",
          principal: identityId || "-"
        });
        sendUnauthorized(
          res,
          401,
          "capability_missing",
          "capability presentation is required for IntentOS enforcement"
        );
        return { ok: false, statusCode: 401 };
      }
      return { ok: true, statusCode: 0, identity: identity || null };
    }

    const capabilityRequest = {
      action: authRequest.action,
      resource: authRequest.resource,
      hops: 0
    };
    if (identityId) {
      capabilityRequest.subject = identityId;
    }
    if (intentosAudience) {
      capabilityRequest.audience = intentosAudience;
    }

    const capabilityDecision = evaluateCapability(capabilityPresentation, capabilityRequest, {
      nowMs: Date.now(),
      clockSkewSec: capabilityClockSkewSec,
      identityVerifier: intentosIdentityVerifier,
      lookupIdentity: (issuer, doc) => {
        if (
          isPlainObject(capabilityPresentation.identities) &&
          isPlainObject(capabilityPresentation.identities[issuer])
        ) {
          return capabilityPresentation.identities[issuer];
        }
        if (doc && isPlainObject(doc.issuer_identity)) {
          return doc.issuer_identity;
        }
        if (identity && identity.id === issuer) {
          return identity;
        }
        return null;
      }
    });

    logIntentos("intentos_capability_authorization", {
      source,
      action: authRequest.action,
      resource: authRequest.resource,
      outcome: capabilityDecision.allow ? "allow" : "deny",
      reason_code: capabilityDecision.reason_code,
      principal: identityId || "-"
    });

    if (intentosEnforce && !capabilityDecision.allow) {
      sendUnauthorized(
        res,
        403,
        capabilityDecision.reason_code || "capability_denied",
        capabilityDecision.message || "capability authorization denied"
      );
      return { ok: false, statusCode: 403 };
    }

    return {
      ok: true,
      statusCode: 0,
      identity: identity || null,
      capabilityDecision
    };
  };
  const parseHopCount = (value) => {
    const headerValue = firstHeaderValue(value);
    if (typeof headerValue !== "string" || !headerValue.trim()) {
      return 0;
    }
    const parsed = Number.parseInt(headerValue.trim(), 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return 0;
    }
    return parsed;
  };
  const logIdentityVerification = (source, envelope, result) => {
    if (!identityEnabled || !result) {
      return;
    }
    if (result.code === "identity_not_present" && !identityEnforce) {
      return;
    }
    const identity =
      envelope && envelope.identity && typeof envelope.identity === "object" &&
      !Array.isArray(envelope.identity)
        ? envelope.identity
        : null;
    const proof =
      envelope && envelope.proof && typeof envelope.proof === "object" && !Array.isArray(envelope.proof)
        ? envelope.proof
        : null;
    const details =
      result.details && typeof result.details === "object" && !Array.isArray(result.details)
        ? result.details
        : null;
    const detailsKid = details && typeof details.kid === "string" ? details.kid : "";
    const proofKid = proof && typeof proof.kid === "string" ? proof.kid : "";
    const missingIdentity =
      result.code === "identity_not_present" ||
      result.code === "identity_missing" ||
      result.code === "identity_proof_missing";
    const enforcementFailed = identityEnforce && (missingIdentity || !result.ok);
    let identityHash = "";
    if (identity) {
      try {
        identityHash = crypto
          .createHash("sha256")
          .update(stableJsonStringify(identity))
          .digest("hex")
          .slice(0, 16);
      } catch (_err) {
        identityHash = "";
      }
    }
    const record = {
      event: "identity_verification",
      relay_instance_id: relayInstanceId,
      source,
      outcome: enforcementFailed ? "fail" : result.ok ? "ok" : "fail",
      reason_code: result.code,
      envelope_id: envelope && typeof envelope.id === "string" ? envelope.id : "-"
    };
    if (identity && typeof identity.id === "string" && identity.id.trim()) {
      record.id = identity.id.trim();
    }
    if (identity && typeof identity.role === "string" && identity.role.trim()) {
      record.role = identity.role.trim();
    }
    if (detailsKid || proofKid) {
      record.kid = detailsKid || proofKid;
    }
    if (identityHash) {
      record.identity_hash = identityHash;
    }
    console.log(
      JSON.stringify(record)
    );
  };
  const verifyIdentityEnvelope = (res, source, envelope) => {
    if (!identityVerifier) {
      return { ok: true, statusCode: 0 };
    }
    const identityResult = identityVerifier.verifyEnvelopeIdentity(envelope);
    logIdentityVerification(source, envelope, identityResult);
    if (!identityEnforce) {
      return { ok: true, statusCode: 0 };
    }
    const missingIdentity =
      identityResult.code === "identity_not_present" ||
      identityResult.code === "identity_missing" ||
      identityResult.code === "identity_proof_missing";
    if (missingIdentity) {
      sendError(
        res,
        400,
        "invalid_request",
        "identity and proof are required when identity enforcement is enabled"
      );
      return { ok: false, statusCode: 400 };
    }
    if (!identityResult.ok) {
      sendError(res, 403, "identity_verification_failed", "Identity verification failed", {
        reason: identityResult.code
      });
      return { ok: false, statusCode: 403 };
    }
    return { ok: true, statusCode: 0 };
  };
  const verifyCapabilitiesEnvelope = (res, source, envelope, context = {}) => {
    if (!capabilitiesEnabled) {
      return { ok: true, statusCode: 0 };
    }
    const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
    const capabilityPresentation =
      envelope && isObject(envelope.capabilities) ? envelope.capabilities : null;
    const recipient =
      typeof context.recipient === "string" && context.recipient.trim()
        ? context.recipient.trim()
        : envelope && typeof envelope.recipient === "string"
          ? envelope.recipient.trim()
          : "";
    const envelopeIdentity = envelope && isObject(envelope.identity) ? envelope.identity : null;
    const request = {
      action: "mailbox.enqueue",
      resource: recipient ? `mailbox:${recipient}` : "mailbox:*",
      hops: Number.isFinite(context.hops) ? Math.max(0, Math.floor(context.hops)) : 0
    };
    if (envelopeIdentity && typeof envelopeIdentity.id === "string" && envelopeIdentity.id.trim()) {
      request.subject = envelopeIdentity.id.trim();
    }
    if (capabilityAudience) {
      request.audience = capabilityAudience;
    }

    const capIds =
      capabilityPresentation && Array.isArray(capabilityPresentation.chain)
        ? capabilityPresentation.chain.map((doc) =>
          doc && typeof doc.id === "string" && doc.id.trim() ? doc.id.trim() : "-"
        )
        : [];

    const logCapabilityResult = (decision) => {
      const details = decision && isObject(decision.details) ? decision.details : {};
      const issuer =
        typeof details.issuer === "string" && details.issuer
          ? details.issuer
          : capabilityPresentation &&
              Array.isArray(capabilityPresentation.chain) &&
              capabilityPresentation.chain[0] &&
              typeof capabilityPresentation.chain[0].issuer === "string"
            ? capabilityPresentation.chain[0].issuer
            : "-";
      const subject =
        typeof details.subject === "string" && details.subject
          ? details.subject
          : request.subject || "-";
      const chainVerified = details.chain_verified === true;
      logCapability("capability_chain_verify", {
        source,
        outcome: chainVerified ? "ok" : "fail",
        reason_code: decision.reason_code,
        issuer,
        subject,
        cap_ids: capIds
      });
      logCapability("capability_authorization", {
        source,
        outcome: decision.allow ? "allow" : "deny",
        reason_code: decision.reason_code,
        request_action: request.action,
        request_resource: request.resource,
        issuer,
        subject,
        cap_ids: capIds
      });
    };

    if (!capabilityPresentation) {
      if (!capabilityEnforce) {
        return { ok: true, statusCode: 0 };
      }
      const missingDecision = {
        allow: false,
        reason_code: "capability_missing",
        message: "capability presentation is required",
        details: { chain_verified: false, subject: request.subject || "-" }
      };
      logCapabilityResult(missingDecision);
      sendUnauthorized(res, 401, missingDecision.reason_code, missingDecision.message);
      return { ok: false, statusCode: 401 };
    }

    if (!Array.isArray(capabilityPresentation.chain) || capabilityPresentation.chain.length === 0) {
      const chainMissing = {
        allow: false,
        reason_code: "capability_chain_missing",
        message: "capability chain is required",
        details: { chain_verified: false, subject: request.subject || "-" }
      };
      logCapabilityResult(chainMissing);
      if (!capabilityEnforce) {
        return { ok: true, statusCode: 0 };
      }
      sendUnauthorized(res, 401, chainMissing.reason_code, chainMissing.message);
      return { ok: false, statusCode: 401 };
    }

    const requested =
      isObject(capabilityPresentation.requested) ? capabilityPresentation.requested : null;
    if (requested) {
      const actionMismatch =
        typeof requested.action === "string" && requested.action !== request.action;
      const resourceMismatch =
        typeof requested.resource === "string" && requested.resource !== request.resource;
      if (actionMismatch || resourceMismatch) {
        const requestedMismatch = {
          allow: false,
          reason_code: "capability_requested_mismatch",
          message: "capability requested action/resource does not match endpoint request",
          details: { chain_verified: false, subject: request.subject || "-" }
        };
        logCapabilityResult(requestedMismatch);
        if (!capabilityEnforce) {
          return { ok: true, statusCode: 0 };
        }
        sendUnauthorized(res, 403, requestedMismatch.reason_code, requestedMismatch.message);
        return { ok: false, statusCode: 403 };
      }
    }

    if (capabilityEnforce) {
      const identityResult = capabilityIdentityVerifier.verifyEnvelopeIdentity(envelope);
      if (!identityEnabled) {
        logIdentityVerification(source, envelope, identityResult);
      }
      if (!identityResult.ok) {
        const missingIdentity =
          identityResult.code === "identity_not_present" ||
          identityResult.code === "identity_missing" ||
          identityResult.code === "identity_proof_missing";
        const reasonCode = missingIdentity ? "identity_required" : "identity_verification_failed";
        const identityDecision = {
          allow: false,
          reason_code: reasonCode,
          message: missingIdentity
            ? "identity and proof are required for capability enforcement"
            : "identity verification failed for capability enforcement",
          details: { chain_verified: false, subject: request.subject || "-" }
        };
        logCapabilityResult(identityDecision);
        sendUnauthorized(res, missingIdentity ? 401 : 403, identityDecision.reason_code, identityDecision.message);
        return { ok: false, statusCode: missingIdentity ? 401 : 403 };
      }
    }

    const capabilityDecision = evaluateCapability(capabilityPresentation, request, {
      nowMs: Date.now(),
      clockSkewSec: capabilityClockSkewSec,
      identityVerifier: capabilityIdentityVerifier,
      lookupIdentity: (issuer, doc) => {
        if (
          capabilityPresentation &&
          isObject(capabilityPresentation.identities) &&
          isObject(capabilityPresentation.identities[issuer])
        ) {
          return capabilityPresentation.identities[issuer];
        }
        if (doc && isObject(doc.issuer_identity)) {
          return doc.issuer_identity;
        }
        if (
          envelopeIdentity &&
          typeof envelopeIdentity.id === "string" &&
          envelopeIdentity.id === issuer
        ) {
          return envelopeIdentity;
        }
        return null;
      }
    });
    logCapabilityResult(capabilityDecision);

    if (!capabilityEnforce) {
      return { ok: true, statusCode: 0 };
    }
    if (!capabilityDecision.allow) {
      sendUnauthorized(res, 403, capabilityDecision.reason_code, capabilityDecision.message);
      return { ok: false, statusCode: 403 };
    }
    return { ok: true, statusCode: 0 };
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
      trusted_key_count: signatureConfig.trustedKeys.size,
      identity_enabled: identityEnabled,
      identity_mode: identityMode,
      capabilities_enabled: capabilitiesEnabled,
      capability_mode: capabilityMode,
      intentos_enabled: intentosEnabled,
      intentos_mode: intentosMode,
      intentos_box_id: intentosBoxId,
      federation_enabled: federationConfig.enabled,
      federation_trust_policy_mode: federationConfig.trustPolicyMode
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

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const method = req.method || "GET";

    if (url.pathname === healthPath) {
      if (method !== "GET") {
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
    if (url.pathname === readyPath) {
      if (method !== "GET") {
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

    if (url.pathname === descriptorPath) {
      if (!federationConfig.enabled) {
        sendError(res, 404, "not_found", "Not Found");
        return;
      }
      if (method !== "GET") {
        sendError(res, 405, "method_not_allowed", "Method not allowed");
        return;
      }
      try {
        const descriptor = buildRelayDescriptor(federationConfig);
        res.setHeader("Cache-Control", `public, max-age=${federationConfig.descriptorTtlSec}`);
        sendJson(res, 200, descriptor);
        logFederation("federation_descriptor_served", {
          endpoint: federationConfig.relayEndpoint,
          outcome: "ok"
        });
      } catch (err) {
        sendError(res, 500, "federation_unavailable", "Descriptor unavailable");
        logFederation("federation_descriptor_served", {
          endpoint: federationConfig.relayEndpoint,
          outcome: "fail",
          reason: err instanceof Error ? err.message : String(err)
        });
      }
      return;
    }

    if (url.pathname === federationEnvelopePath) {
      if (!federationConfig.enabled || federationConfig.trustPolicyMode === "off") {
        sendError(res, 404, "not_found", "Not Found");
        return;
      }
      if (method !== "POST") {
        sendError(res, 405, "method_not_allowed", "Method not allowed");
        return;
      }

      let payload;
      try {
        payload = await readJson(req, maxBytes);
      } catch (err) {
        if (err instanceof RelayError && err.code === "payload_too_large") {
          sendError(res, 413, "payload_too_large", err.message);
          return;
        }
        sendError(res, 400, "invalid_json", "Invalid JSON payload");
        return;
      }

      const hopDecision = validateHopLimit(req.headers["x-aimtp-hop"], 1);
      if (!hopDecision.ok) {
        sendError(res, 403, "federation_hop_limit_exceeded", "Hop limit exceeded");
        logFederation("federation_inbound_verify", {
          src_relay_id: "-",
          endpoint: "-",
          outcome: "fail",
          reason: hopDecision.reason
        });
        return;
      }

      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        sendError(res, 400, "invalid_request", "Payload must be an object");
        return;
      }
      const descriptor = payload.descriptor;
      const envelope = payload.envelope;
      if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
        sendError(res, 400, "invalid_request", "descriptor is required");
        return;
      }
      if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
        sendError(res, 400, "invalid_request", "envelope is required");
        return;
      }

      let trustPolicy;
      try {
        trustPolicy = loadCurrentTrustPolicy();
      } catch (err) {
        sendError(res, 500, "federation_trust_policy_error", "Trust policy unavailable");
        logFederation("federation_trust_decision", {
          src_relay_id: descriptor.relay_id || "-",
          endpoint: descriptor.endpoint || "-",
          outcome: "untrusted",
          policy_source: federationConfig.trustedRelaysPath,
          reason: err instanceof Error ? err.message : String(err)
        });
        return;
      }

      const trustedEntry = trustPolicy.trustedRelays.get(descriptor.relay_id);
      if (!trustedEntry) {
        sendError(res, 403, "federation_untrusted_relay", "Relay is not trusted");
        logFederation("federation_trust_decision", {
          src_relay_id: descriptor.relay_id || "-",
          endpoint: descriptor.endpoint || "-",
          outcome: "untrusted",
          policy_source: federationConfig.trustedRelaysPath,
          reason: "relay_not_allowlisted"
        });
        logFederation("federation_inbound_verify", {
          src_relay_id: descriptor.relay_id || "-",
          endpoint: descriptor.endpoint || "-",
          outcome: "fail",
          reason: "relay_not_allowlisted"
        });
        return;
      }

      const verifyDecision = verifyRelayDescriptor(descriptor, trustedEntry, {
        clockSkewSec: federationConfig.clockSkewSec
      });
      if (!verifyDecision.ok) {
        sendError(
          res,
          verifyDecision.httpStatus || 403,
          verifyDecision.code || "federation_verify_failed",
          verifyDecision.message || "Descriptor verification failed",
          verifyDecision.details
        );
        logFederation("federation_trust_decision", {
          src_relay_id: descriptor.relay_id || "-",
          endpoint: descriptor.endpoint || "-",
          outcome: "untrusted",
          policy_source: federationConfig.trustedRelaysPath,
          reason: verifyDecision.code || "verify_failed"
        });
        logFederation("federation_inbound_verify", {
          src_relay_id: descriptor.relay_id || "-",
          endpoint: descriptor.endpoint || "-",
          outcome: "fail",
          reason: verifyDecision.code || "verify_failed"
        });
        return;
      }
      logFederation("federation_trust_decision", {
        src_relay_id: descriptor.relay_id || "-",
        endpoint: descriptor.endpoint || "-",
        outcome: "trusted",
        policy_source: federationConfig.trustedRelaysPath
      });
      logFederation("federation_inbound_verify", {
        src_relay_id: descriptor.relay_id || "-",
        endpoint: descriptor.endpoint || "-",
        outcome: "ok"
      });

      const validationErrors = validateEnvelope(envelope);
      if (validationErrors.length > 0) {
        sendError(res, 400, "invalid_schema", "Envelope failed schema validation", {
          errors: validationErrors
        });
        return;
      }

      const signatureDecision = evaluateEnvelopeSignaturePolicy(envelope, signatureConfig);
      if (!signatureDecision.allowed && signatureDecision.error) {
        sendError(
          res,
          signatureDecision.error.httpStatus || 403,
          signatureDecision.error.code || "signature_invalid",
          signatureDecision.error.message || "Signature validation failed",
          signatureDecision.error.details
        );
        return;
      }
      if (identityVerifier) {
        const identityDecision = verifyIdentityEnvelope(res, "federation_inbound", envelope);
        if (!identityDecision.ok) {
          return;
        }
      }

      const recipient = typeof envelope.recipient === "string" ? envelope.recipient.trim() : "";
      if (!recipient) {
        sendError(res, 400, "missing_recipient", "Recipient is required", { recipient: null });
        return;
      }
      if (!isLocalRecipient(recipient, federationConfig)) {
        sendError(res, 403, "federation_non_local_recipient", "Recipient is not local");
        return;
      }
      const capabilityInboundDecision = verifyCapabilitiesEnvelope(
        res,
        "federation_inbound",
        envelope,
        {
          recipient,
          hops: parseHopCount(req.headers["x-aimtp-hop"])
        }
      );
      if (!capabilityInboundDecision.ok) {
        return;
      }
      if (senderAllowlist.enabled) {
        const sender = typeof envelope.sender === "string" ? envelope.sender.trim() : "";
        if (!senderAllowlist.set.has(sender)) {
          sendError(res, 403, "unknown_sender", `Unknown sender: ${sender || "-"}`, { sender });
          return;
        }
      }
      if (recipientAllowlist.enabled) {
        if (!recipientAllowlist.set.has(recipient)) {
          sendError(res, 404, "unknown_recipient", `Unknown recipient: ${recipient}`, { recipient });
          return;
        }
      } else {
        const handler =
          relay && relay.registry && typeof relay.registry.get === "function"
            ? relay.registry.get(recipient)
            : null;
        if (!handler) {
          sendError(res, 404, "unknown_recipient", `Unknown recipient: ${recipient}`, { recipient });
          return;
        }
      }

      const enqueueResult = mailbox.enqueue(recipient, envelope);
      sendJson(res, 202, {
        status: "accepted",
        id: envelope.id,
        recipient,
        federated: true,
        queued: true,
        queue_depth: enqueueResult.queueDepth
      });
      recordCounter("enqueue", 1, { recipient, path: "federation" });
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

    const isPeek = url.pathname === peekPath;
    const isPoll = url.pathname === pollPath;
    const isDead = url.pathname === deadPath;
    const isAck = url.pathname === ackPath;
    const isFail = url.pathname === failPath;
    const isMailboxPath = url.pathname === mailboxPath;
    const isRelayPath = url.pathname === relayPath;
    const isIntentSubmitRoute = url.pathname === intentSubmitPath;
    const isIntentListRoute = url.pathname === intentListPath;
    const isIntentDetailRoute = url.pathname.startsWith(`${intentSubmitPath}/`);
    const isIntentTaskCreateRoute = url.pathname === intentTaskPath;
    const isIntentTaskClaimRoute =
      url.pathname.startsWith(`${intentTaskPath}/`) && url.pathname.endsWith("/claim");
    const isIntentTaskResultRoute =
      url.pathname.startsWith(`${intentTaskPath}/`) && url.pathname.endsWith("/result");
    const isIntentosRoute =
      isIntentSubmitRoute ||
      isIntentListRoute ||
      isIntentDetailRoute ||
      isIntentTaskCreateRoute ||
      isIntentTaskClaimRoute ||
      isIntentTaskResultRoute;

    if (
      !isPeek &&
      !isPoll &&
      !isDead &&
      !isAck &&
      !isFail &&
      !isMailboxPath &&
      !isRelayPath &&
      !isIntentosRoute
    ) {
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

    if (isIntentosRoute) {
      if (!intentosEnabled || !intentosStore) {
        sendError(res, 404, "not_found", "Not Found");
        logRequest(404);
        return;
      }

      const logIntentosRequest = (status, fields) => {
        logIntentos("intentos_request", {
          path: url.pathname,
          method: req.method || "GET",
          status,
          auth: authStatus,
          ...(fields || {})
        });
      };

      if (isIntentListRoute) {
        if (req.method !== "GET") {
          sendError(res, 405, "method_not_allowed", "Method not allowed");
          logIntentosRequest(405);
          return;
        }
        const statusFilter = url.searchParams.get("status");
        const limit = parseIntentosLimit(url.searchParams.get("limit"));
        const intents = intentosStore.listIntents(statusFilter || "", limit);
        sendJson(res, 200, { intents });
        logIntentosRequest(200, { count: intents.length });
        return;
      }

      if (isIntentDetailRoute) {
        if (req.method !== "GET") {
          sendError(res, 405, "method_not_allowed", "Method not allowed");
          logIntentosRequest(405);
          return;
        }
        const segments = url.pathname.split("/").filter(Boolean);
        if (segments.length !== 3) {
          sendError(res, 404, "not_found", "Not Found");
          logIntentosRequest(404);
          return;
        }
        const intentId = decodeURIComponent(segments[2] || "");
        const intentRecord = intentosStore.getIntent(intentId);
        if (!intentRecord) {
          sendError(res, 404, "intent_not_found", "Intent not found");
          logIntentosRequest(404, { intent_id: intentId || "-" });
          return;
        }
        sendJson(res, 200, intentRecord);
        logIntentosRequest(200, { intent_id: intentId });
        return;
      }

      if (isIntentSubmitRoute) {
        if (req.method !== "POST") {
          sendError(res, 405, "method_not_allowed", "Method not allowed");
          logIntentosRequest(405);
          return;
        }

        let payload;
        try {
          payload = await readJson(req, maxBytes);
        } catch (err) {
          if (err instanceof RelayError && err.code === "payload_too_large") {
            sendError(res, 413, "payload_too_large", err.message);
            logIntentosRequest(413);
            return;
          }
          sendError(res, 400, "invalid_json", "Invalid JSON payload");
          logIntentosRequest(400);
          return;
        }
        if (!isPlainObject(payload)) {
          sendError(res, 400, "invalid_request", "Payload must be an object");
          logIntentosRequest(400, { reason_code: "payload_object_required" });
          return;
        }

        const authDecision = verifyIntentosAuthorization(res, "intentos_intent_submit", payload, {
          action: "intent.submit",
          resource: `intentbox:${intentosBoxId}`
        });
        if (!authDecision.ok) {
          logIntentosRequest(authDecision.statusCode || 403, {
            reason_code: "authz_failed"
          });
          return;
        }

        const goal = typeof payload.goal === "string" ? payload.goal.trim() : "";
        if (!goal) {
          sendError(res, 400, "invalid_request", "goal is required");
          logIntentosRequest(400, { reason_code: "goal_required" });
          return;
        }

        const principalFromIdentity =
          authDecision.identity &&
          typeof authDecision.identity.id === "string" &&
          authDecision.identity.id.trim()
            ? authDecision.identity.id.trim()
            : "";
        const principalFromBody =
          payload && typeof payload.principal === "string" && payload.principal.trim()
            ? payload.principal.trim()
            : "";
        const principal = principalFromIdentity || principalFromBody || "anonymous";

        let intentId;
        try {
          intentId = intentosStore.submitIntent({
            principal,
            goal,
            metadata: isPlainObject(payload.metadata) ? payload.metadata : {},
            idempotency_key:
              typeof payload.idempotency_key === "string" ? payload.idempotency_key.trim() : ""
          });
        } catch (_err) {
          sendError(res, 400, "invalid_request", "invalid intent payload");
          logIntentosRequest(400, { reason_code: "intent_invalid" });
          return;
        }

        const intentRecord = intentosStore.getIntent(intentId);
        const status = intentRecord && intentRecord.intent ? intentRecord.intent.status : "submitted";
        sendJson(res, 202, { intent_id: intentId, status });
        logIntentosRequest(202, { intent_id: intentId, reason_code: "accepted" });
        return;
      }

      if (isIntentTaskCreateRoute) {
        if (req.method !== "POST") {
          sendError(res, 405, "method_not_allowed", "Method not allowed");
          logIntentosRequest(405);
          return;
        }
        let payload;
        try {
          payload = await readJson(req, maxBytes);
        } catch (err) {
          if (err instanceof RelayError && err.code === "payload_too_large") {
            sendError(res, 413, "payload_too_large", err.message);
            logIntentosRequest(413);
            return;
          }
          sendError(res, 400, "invalid_json", "Invalid JSON payload");
          logIntentosRequest(400);
          return;
        }
        if (!isPlainObject(payload)) {
          sendError(res, 400, "invalid_request", "Payload must be an object");
          logIntentosRequest(400, { reason_code: "payload_object_required" });
          return;
        }

        const intentId = typeof payload.intent_id === "string" ? payload.intent_id.trim() : "";
        const taskType = typeof payload.type === "string" ? payload.type.trim() : "";
        if (!intentId || !taskType) {
          sendError(res, 400, "invalid_request", "intent_id and type are required");
          logIntentosRequest(400, { reason_code: "task_fields_required" });
          return;
        }

        let taskId;
        try {
          taskId = intentosStore.enqueueTask({
            id: typeof payload.id === "string" ? payload.id.trim() : "",
            intent_id: intentId,
            type: taskType,
            input: Object.prototype.hasOwnProperty.call(payload, "input") ? payload.input : {}
          });
        } catch (err) {
          const code = err instanceof Error ? err.message : "task_invalid";
          if (code === "task_intent_not_found") {
            sendError(res, 404, "intent_not_found", "Intent not found");
            logIntentosRequest(404, { intent_id: intentId, reason_code: code });
            return;
          }
          sendError(res, 400, "invalid_request", "Invalid task payload");
          logIntentosRequest(400, { intent_id: intentId, reason_code: code });
          return;
        }

        sendJson(res, 202, {
          task_id: taskId,
          intent_id: intentId,
          status: "queued"
        });
        logIntentosRequest(202, { intent_id: intentId, task_id: taskId, reason_code: "queued" });
        return;
      }

      if (isIntentTaskClaimRoute || isIntentTaskResultRoute) {
        if (req.method !== "POST") {
          sendError(res, 405, "method_not_allowed", "Method not allowed");
          logIntentosRequest(405);
          return;
        }
        const segments = url.pathname.split("/").filter(Boolean);
        if (segments.length !== 4) {
          sendError(res, 404, "not_found", "Not Found");
          logIntentosRequest(404);
          return;
        }
        const taskId = decodeURIComponent(segments[2] || "");
        const operation = segments[3];
        if ((isIntentTaskClaimRoute && operation !== "claim") || (isIntentTaskResultRoute && operation !== "result")) {
          sendError(res, 404, "not_found", "Not Found");
          logIntentosRequest(404);
          return;
        }

        let payload;
        try {
          payload = await readJson(req, maxBytes);
        } catch (err) {
          if (err instanceof RelayError && err.code === "payload_too_large") {
            sendError(res, 413, "payload_too_large", err.message);
            logIntentosRequest(413, { task_id: taskId || "-" });
            return;
          }
          sendError(res, 400, "invalid_json", "Invalid JSON payload");
          logIntentosRequest(400, { task_id: taskId || "-" });
          return;
        }
        if (!isPlainObject(payload)) {
          sendError(res, 400, "invalid_request", "Payload must be an object");
          logIntentosRequest(400, { task_id: taskId || "-", reason_code: "payload_object_required" });
          return;
        }

        const authDecision = verifyIntentosAuthorization(
          res,
          isIntentTaskClaimRoute ? "intentos_task_claim" : "intentos_task_result",
          payload,
          {
            action: isIntentTaskClaimRoute ? "task.claim" : "task.result",
            resource: `task:${taskId}`
          }
        );
        if (!authDecision.ok) {
          logIntentosRequest(authDecision.statusCode || 403, {
            task_id: taskId || "-",
            reason_code: "authz_failed"
          });
          return;
        }

        const principalFromIdentity =
          authDecision.identity &&
          typeof authDecision.identity.id === "string" &&
          authDecision.identity.id.trim()
            ? authDecision.identity.id.trim()
            : "";
        const principalFromBody =
          payload && typeof payload.agent_id === "string" && payload.agent_id.trim()
            ? payload.agent_id.trim()
            : "";
        const agentId = principalFromBody || principalFromIdentity;
        if (!agentId) {
          sendError(res, 400, "invalid_request", "agent_id is required");
          logIntentosRequest(400, { task_id: taskId || "-", reason_code: "agent_id_required" });
          return;
        }
        if (principalFromIdentity && principalFromBody && principalFromIdentity !== principalFromBody) {
          sendUnauthorized(res, 403, "identity_subject_mismatch", "identity subject does not match agent_id");
          logIntentosRequest(403, { task_id: taskId || "-", reason_code: "identity_subject_mismatch" });
          return;
        }

        if (isIntentTaskClaimRoute) {
          const claimResult = intentosStore.claimTask(taskId, agentId);
          if (!claimResult.ok && claimResult.code === "task_not_found") {
            sendError(res, 404, "task_not_found", "Task not found");
            logIntentosRequest(404, { task_id: taskId || "-", reason_code: claimResult.code });
            return;
          }
          if (!claimResult.ok) {
            sendError(res, 409, "task_claim_denied", "Task claim denied", {
              reason_code: claimResult.code
            });
            logIntentosRequest(409, { task_id: taskId || "-", reason_code: claimResult.code });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            task_id: taskId,
            status: claimResult.status,
            assigned_to: claimResult.task && claimResult.task.assigned_to ? claimResult.task.assigned_to : agentId
          });
          logIntentosRequest(200, { task_id: taskId, reason_code: "claimed" });
          return;
        }

        const taskRecord = intentosStore.getTask(taskId);
        if (!taskRecord) {
          sendError(res, 404, "task_not_found", "Task not found");
          logIntentosRequest(404, { task_id: taskId || "-", reason_code: "task_not_found" });
          return;
        }
        if (taskRecord.assigned_to && taskRecord.assigned_to !== agentId) {
          sendUnauthorized(
            res,
            403,
            "task_claim_mismatch",
            "task is claimed by a different agent principal"
          );
          logIntentosRequest(403, { task_id: taskId, reason_code: "task_claim_mismatch" });
          return;
        }

        const statusCandidate = typeof payload.status === "string" ? payload.status.trim().toLowerCase() : "";
        const finalStatus = statusCandidate === "failed" ? "failed" : "completed";
        if (finalStatus === "completed" && !Object.prototype.hasOwnProperty.call(payload, "output")) {
          sendError(res, 400, "invalid_request", "output is required for completed task.result");
          logIntentosRequest(400, { task_id: taskId, reason_code: "output_required" });
          return;
        }

        const completeResult = intentosStore.completeTask(taskId, {
          status: finalStatus,
          output: payload.output,
          error: typeof payload.error === "string" ? payload.error : undefined,
          agent_id: agentId
        });

        if (!completeResult.ok && completeResult.code === "task_not_found") {
          sendError(res, 404, "task_not_found", "Task not found");
          logIntentosRequest(404, { task_id: taskId, reason_code: completeResult.code });
          return;
        }
        if (!completeResult.ok) {
          sendError(res, 409, "task_result_denied", "Task result denied", {
            reason_code: completeResult.code
          });
          logIntentosRequest(409, { task_id: taskId, reason_code: completeResult.code });
          return;
        }

        sendJson(res, 200, {
          ok: true,
          task_id: taskId,
          status: completeResult.status
        });
        logIntentosRequest(200, {
          task_id: taskId,
          reason_code: completeResult.status === "failed" ? "failed" : "completed"
        });
        return;
      }
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
    if (identityVerifier) {
      const identityDecision = verifyIdentityEnvelope(res, "relay_inbound", payload);
      if (!identityDecision.ok) {
        logRequest(identityDecision.statusCode || 403);
        return;
      }
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
    const capabilityDecision = verifyCapabilitiesEnvelope(res, "relay_inbound", payload, {
      recipient,
      hops: parseHopCount(req.headers["x-aimtp-hop"])
    });
    if (!capabilityDecision.ok) {
      logRequest(capabilityDecision.statusCode || 403);
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
        const canFederateOutbound =
          federationConfig.enabled &&
          federationConfig.trustPolicyMode !== "off" &&
          !isLocalRecipient(recipient, federationConfig);
        if (!canFederateOutbound) {
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

        let trustPolicy;
        try {
          trustPolicy = loadCurrentTrustPolicy();
        } catch (err) {
          sendError(res, 500, "federation_trust_policy_error", "Trust policy unavailable");
          logRequest(500);
          logFederation("federation_forward_attempt", {
            dest_relay_id: "-",
            endpoint: "-",
            outcome: "fail",
            reason: err instanceof Error ? err.message : String(err)
          });
          return;
        }

        const destRelayId = resolveDestinationRelayId(recipient, trustPolicy.domains);
        const trustedEntry = trustPolicy.trustedRelays.get(destRelayId);
        if (!trustedEntry) {
          sendError(
            res,
            403,
            "federation_untrusted_destination",
            `Destination relay not trusted: ${destRelayId || "unknown"}`
          );
          logRequest(403);
          logFederation("federation_trust_decision", {
            dest_relay_id: destRelayId || "-",
            endpoint: "-",
            outcome: "untrusted",
            policy_source: federationConfig.trustedRelaysPath,
            reason: "destination_not_allowlisted"
          });
          logFederation("federation_forward_attempt", {
            dest_relay_id: destRelayId || "-",
            endpoint: "-",
            outcome: "fail",
            reason: "destination_not_allowlisted"
          });
          return;
        }
        if (isTrustEntryExpired(trustedEntry, Date.now(), federationConfig.clockSkewSec)) {
          sendError(
            res,
            403,
            "federation_untrusted_destination",
            `Destination relay trust entry expired: ${destRelayId || "unknown"}`
          );
          logRequest(403);
          logFederation("federation_trust_decision", {
            dest_relay_id: destRelayId || "-",
            endpoint: trustedEntry.endpoint || "-",
            outcome: "untrusted",
            policy_source: federationConfig.trustedRelaysPath,
            reason: "destination_trust_expired"
          });
          logFederation("federation_forward_attempt", {
            dest_relay_id: destRelayId || "-",
            endpoint: trustedEntry.endpoint || "-",
            outcome: "fail",
            reason: "destination_trust_expired"
          });
          return;
        }

        logFederation("federation_trust_decision", {
          dest_relay_id: trustedEntry.relay_id,
          endpoint: trustedEntry.endpoint,
          outcome: "trusted",
          policy_source: federationConfig.trustedRelaysPath
        });

        let descriptor;
        try {
          descriptor = buildRelayDescriptor(federationConfig);
        } catch (err) {
          sendError(res, 500, "federation_unavailable", "Relay descriptor unavailable");
          logRequest(500);
          logFederation("federation_forward_attempt", {
            dest_relay_id: trustedEntry.relay_id,
            endpoint: trustedEntry.endpoint,
            outcome: "fail",
            reason: err instanceof Error ? err.message : String(err)
          });
          return;
        }

        let forwardResponse;
        try {
          forwardResponse = await postJsonWithTimeout(
            trustedEntry.endpoint,
            federationEnvelopePath,
            { descriptor, envelope: payload },
            {
              timeoutMs: federationConfig.forwardTimeoutMs,
              headers: { "x-aimtp-hop": "1" }
            }
          );
        } catch (err) {
          sendError(res, 502, "federation_forward_failed", "Federated forward failed", {
            dest_relay_id: trustedEntry.relay_id,
            endpoint: trustedEntry.endpoint
          });
          logRequest(502);
          logFederation("federation_forward_attempt", {
            dest_relay_id: trustedEntry.relay_id,
            endpoint: trustedEntry.endpoint,
            outcome: "fail",
            reason: err instanceof Error ? err.message : String(err)
          });
          return;
        }

        if (forwardResponse.status < 200 || forwardResponse.status >= 300) {
          sendError(res, 502, "federation_forward_failed", "Federated forward rejected", {
            dest_relay_id: trustedEntry.relay_id,
            endpoint: trustedEntry.endpoint,
            remote_status: forwardResponse.status
          });
          logRequest(502);
          logFederation("federation_forward_attempt", {
            dest_relay_id: trustedEntry.relay_id,
            endpoint: trustedEntry.endpoint,
            outcome: "fail",
            reason: `remote_status_${forwardResponse.status}`
          });
          return;
        }

        sendJson(res, 202, {
          status: "forwarded",
          id: payload.id,
          recipient,
          queued: false,
          dest_relay_id: trustedEntry.relay_id,
          endpoint: trustedEntry.endpoint
        });
        logRequest(202);
        logFederation("federation_forward_attempt", {
          dest_relay_id: trustedEntry.relay_id,
          endpoint: trustedEntry.endpoint,
          outcome: "ok"
        });
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
