import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { createMailboxStore, parseMailboxStoreType, MailboxStore } from "./mailbox";

type AuthStatus = "ok" | "missing" | "invalid";

type AuthResult = {
  enabled: boolean;
  ok: boolean;
  status: AuthStatus;
  allowedRecipients: Set<string> | null;
};

type EnvelopeLog = {
  id?: string;
  intent?: string;
  sender?: string;
  recipient?: string;
};

type ValidationError = { path: string; message: string };

type CounterName = "enqueue" | "poll" | "ack" | "fail" | "dead_letter";

type SignatureResult = {
  ok?: boolean;
  httpStatus?: number;
  code?: string;
  message?: string;
  details?: unknown;
};

type SignatureDecision = {
  allowed: boolean;
  warning?: SignatureResult;
  error?: SignatureResult;
};

type RelayErrorLike = Error & { code?: string; details?: unknown };

type Allowlist = {
  enabled: boolean;
  set: Set<string>;
};

type RecipientKeys = {
  enabled: boolean;
  keyToRecipients: Map<string, Set<string>>;
};

type AuthConfig = {
  enabled: boolean;
  adminKey: string;
  keyToRecipients: Map<string, Set<string>>;
};

type RegistryLike = {
  get: (agentId: string) => unknown;
};

type WebhookRelayType = {
  emitResponses: boolean;
  registry: RegistryLike;
  registerAgent: (
    agentId: string,
    handler: (envelope: unknown, context: any) => void | Promise<void>
  ) => void;
  receive: (envelope: unknown) => Promise<unknown[]>;
};

type IntentosUiAsset = {
  contentType: string;
  body: Buffer;
};

type IntentosUiAssets = {
  indexTemplate: string;
  app: IntentosUiAsset;
  styles: IntentosUiAsset;
};

const { WebhookRelay, RelayError } = require("../../runtime/relay") as {
  WebhookRelay: new (options?: { emitResponses?: boolean }) => WebhookRelayType;
  RelayError: new (code: string, message: string, details?: unknown) => RelayErrorLike;
};

const { validateEnvelope } = require("../../runtime/validation") as {
  validateEnvelope: (envelope: unknown) => ValidationError[];
};

const {
  createSignatureTrustConfig,
  evaluateEnvelopeSignaturePolicy
} = require("../../runtime/signature") as {
  createSignatureTrustConfig: (options?: {
    policy?: string;
    trustedKeys?: string;
    trustedKeysFile?: string;
    clockSkewSec?: number;
    logger?: { log: (message: string) => void } | null;
  }) => {
    policy: string;
    trustedKeys: Map<string, string>;
  };
  evaluateEnvelopeSignaturePolicy: (
    envelope: unknown,
    config: unknown
  ) => SignatureDecision;
};

const { createEnvelope, createMessage, createTaskResponse } = require("../../sdk/js") as {
  createEnvelope: (payload: any) => any;
  createMessage: (payload: any) => any;
  createTaskResponse: (payload: any) => any;
};

const packageJson = require("../../package.json") as { version?: string };

const DEFAULT_PORT = 8787;
const DEFAULT_PATH = "/aimtp";
const DEFAULT_HEALTH_PATH = "/healthz";
const DEFAULT_READY_PATH = "/readyz";
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_POLL_MAX = 1;
const MAX_POLL_LIMIT = 50;
const DEFAULT_CORS_ORIGINS = ["http://localhost:8080", "http://127.0.0.1:8080"];
const RECIPIENT_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/;
const INTENTOS_UI_PATH = "/intentos/ui";
const INTENTOS_UI_APP_PATH = "/intentos/ui/app.js";
const INTENTOS_UI_STYLES_PATH = "/intentos/ui/styles.css";
const INTENTOS_UI_BASE_PLACEHOLDER = "__INTENTOS_UI_BASE_PATH__";
const INTENTOS_INTENTS_PATH = "/intentos/intents";
const INTENTOS_TASKS_PATH = "/intentos/tasks";
const INTENTOS_INTENT_PREFIX = "/intentos/intent/";

function parseEnvInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseOptionalEnvInt(value: string | undefined): number | undefined {
  if (!value || value.trim() === "") {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function parseOptionalNonNegativeEnvInt(value: string | undefined): number | undefined {
  if (!value || value.trim() === "") {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

function envPath(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const trimmed = raw.trim();
  return trimmed;
}

function parseAllowlist(value: string | undefined): Allowlist {
  if (!value) {
    return { enabled: false, set: new Set<string>() };
  }
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return { enabled: entries.length > 0, set: new Set(entries) };
}

function parseRecipientKeys(value: string | undefined): RecipientKeys {
  if (!value) {
    return { enabled: false, keyToRecipients: new Map<string, Set<string>>() };
  }
  const keyToRecipients = new Map<string, Set<string>>();
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
    keyToRecipients.get(key)?.add(recipient);
  });
  return { enabled: keyToRecipients.size > 0, keyToRecipients };
}

function parseKeyRecipients(value: string | undefined): RecipientKeys {
  if (!value) {
    return { enabled: false, keyToRecipients: new Map<string, Set<string>>() };
  }
  const keyToRecipients = new Map<string, Set<string>>();
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
    recipients.forEach((recipient) => bucket?.add(recipient));
  });
  return { enabled: keyToRecipients.size > 0, keyToRecipients };
}

function mergeRecipientKeys(...entries: RecipientKeys[]): RecipientKeys {
  const keyToRecipients = new Map<string, Set<string>>();
  entries.forEach((entry) => {
    entry.keyToRecipients.forEach((recipients, key) => {
      if (!keyToRecipients.has(key)) {
        keyToRecipients.set(key, new Set());
      }
      const target = keyToRecipients.get(key);
      recipients.forEach((recipient) => target?.add(recipient));
    });
  });
  return { enabled: keyToRecipients.size > 0, keyToRecipients };
}

function parseCorsOrigins(value: string | undefined): Set<string> {
  if (value === undefined) {
    return new Set<string>(DEFAULT_CORS_ORIGINS);
  }
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return new Set<string>(entries);
}

function appendVaryHeader(res: http.ServerResponse, value: string): void {
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

function resolveAllowedOrigin(req: http.IncomingMessage, allowedOrigins: Set<string>): string {
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

function setCorsHeaders(res: http.ServerResponse, origin: string): void {
  if (!origin) {
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  appendVaryHeader(res, "Origin");
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

function sendError(
  res: http.ServerResponse,
  status: number,
  code: string,
  message: string,
  details?: unknown
): void {
  const payload: Record<string, unknown> = { code, message };
  if (details !== undefined) {
    payload.details = details;
  }
  sendJson(res, status, payload);
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function extractAuthKey(req: http.IncomingMessage): string {
  const direct = firstHeaderValue(req.headers["x-aimtp-key"] as string | string[] | undefined);
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

function evaluateAuth(req: http.IncomingMessage, authConfig: AuthConfig): AuthResult {
  const provided = extractAuthKey(req);
  if (!authConfig.enabled) {
    return {
      enabled: true,
      ok: false,
      status: provided ? "invalid" : "missing",
      allowedRecipients: null
    };
  }
  if (!provided) {
    return { enabled: true, ok: false, status: "missing", allowedRecipients: null };
  }
  if (authConfig.adminKey && provided === authConfig.adminKey) {
    return { enabled: true, ok: true, status: "ok", allowedRecipients: null };
  }
  const recipients = authConfig.keyToRecipients.get(provided);
  if (recipients) {
    return { enabled: true, ok: true, status: "ok", allowedRecipients: recipients };
  }
  return { enabled: true, ok: false, status: "invalid", allowedRecipients: null };
}

function isRecipientAuthorized(authResult: AuthResult, recipient: string): boolean {
  if (!authResult.ok) {
    return false;
  }
  if (!authResult.allowedRecipients) {
    return true;
  }
  return authResult.allowedRecipients.has(recipient);
}

function parseMaxParam(value: string | null): number {
  if (!value) {
    return DEFAULT_POLL_MAX;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_POLL_MAX;
  }
  return Math.min(parsed, MAX_POLL_LIMIT);
}

function buildAuthConfig(apiKey: string, recipientKeys: RecipientKeys): AuthConfig {
  return {
    enabled: Boolean(apiKey) || recipientKeys.enabled,
    adminKey: apiKey,
    keyToRecipients: recipientKeys.keyToRecipients
  };
}

function readRequestBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
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

    const onData = (chunk: Buffer) => {
      if (finished) {
        return;
      }
      size += chunk.length;
      if (size > maxBytes) {
        finished = true;
        cleanup();
        const error = new Error("Request body exceeds maximum size") as RelayErrorLike;
        error.code = "payload_too_large";
        reject(error);
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

    const onError = (err: Error) => {
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

function resolveIntentosUiDir(): string {
  const candidates = [
    path.join(__dirname, "static", "intentos"),
    path.join(__dirname, "../../runtime/static/intentos"),
    path.join(process.cwd(), "runtime", "static", "intentos")
  ];
  for (const candidate of candidates) {
    const indexPath = path.join(candidate, "index.html");
    if (fs.existsSync(indexPath)) {
      return candidate;
    }
  }
  throw new Error("IntentOS UI assets not found");
}

function loadIntentosUiAssets(): IntentosUiAssets {
  const base = resolveIntentosUiDir();
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

function trimTrailingSlash(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function normalizePathname(pathname: string, relayPathInput: string): string {
  if (typeof pathname !== "string" || pathname.length === 0) {
    return "/";
  }
  const cleanedRelayPath = trimTrailingSlash(relayPathInput);
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

function resolveIntentosUiBasePath(pathname: string): string {
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

function renderIntentosUiIndex(template: string, basePath: string): Buffer {
  const safeBasePath = trimTrailingSlash(basePath || INTENTOS_UI_PATH);
  return Buffer.from(
    template.split(INTENTOS_UI_BASE_PLACEHOLDER).join(safeBasePath),
    "utf-8"
  );
}

function isIntentosUiPath(pathname: string): boolean {
  return (
    pathname === INTENTOS_UI_PATH ||
    pathname === `${INTENTOS_UI_PATH}/` ||
    pathname.startsWith(`${INTENTOS_UI_PATH}/`)
  );
}

function isIntentosApiPath(pathname: string): boolean {
  return (
    pathname === INTENTOS_INTENTS_PATH ||
    pathname === INTENTOS_TASKS_PATH ||
    pathname.startsWith(INTENTOS_INTENT_PREFIX)
  );
}

function resolveIntentosUiAsset(
  pathname: string,
  rawPath: string,
  assets: IntentosUiAssets
): IntentosUiAsset | null {
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

function isRelayError(err: unknown): err is RelayErrorLike {
  if (!err || typeof err !== "object") {
    return false;
  }
  return err instanceof RelayError || Object.prototype.hasOwnProperty.call(err, "code");
}

const relay = new WebhookRelay({ emitResponses: true });

relay.registerAgent("aimtp-relay", async (_envelope, context) => {
  if (!context.task || context.task.kind !== "request") {
    return;
  }

  const responseEnvelope = createEnvelope({
    sender: "aimtp-relay",
    recipient: context.sender,
    intent: "task.response",
    message: createMessage({
      role: "assistant",
      content: `Task ${context.task.id} succeeded.`
    }),
    task: createTaskResponse({
      id: `${context.task.id}-resp-001`,
      in_response_to: context.task.id,
      status: "succeeded",
      output: { ok: true }
    })
  });

  context.emit(responseEnvelope);
});

const port = parseEnvInt(process.env.PORT, DEFAULT_PORT);
const relayPathInput = envPath("AIMTP_RELAY_PATH", DEFAULT_PATH) || DEFAULT_PATH;
const relayPath =
  relayPathInput.length > 1 && relayPathInput.endsWith("/")
    ? relayPathInput.slice(0, -1)
    : relayPathInput;
const peekPath = `${relayPath}/peek`;
const pollPath = `${relayPath}/poll`;
const mailboxPath = `${relayPath}/mailbox`;
const ackPath = `${relayPath}/ack`;
const failPath = `${relayPath}/fail`;
const deadPath = `${relayPath}/dead`;
const healthPath = envPath("AIMTP_HEALTH_PATH", DEFAULT_HEALTH_PATH) || DEFAULT_HEALTH_PATH;
const readyPath = envPath("AIMTP_READY_PATH", DEFAULT_READY_PATH);
const readyEnabled = readyPath !== "";
const normalizedHealthPath = normalizePathname(healthPath, relayPath);
const normalizedReadyPath = normalizePathname(readyPath, relayPath);
const maxBytes = parseEnvInt(process.env.AIMTP_MAX_BODY_BYTES, DEFAULT_MAX_BYTES);
const apiKey = process.env.AIMTP_API_KEY ? process.env.AIMTP_API_KEY.trim() : "";
const legacyRecipientKeys = parseRecipientKeys(process.env.AIMTP_RECIPIENT_KEYS);
const keyedRecipientKeys = parseKeyRecipients(process.env.AIMTP_KEY_RECIPIENTS);
const recipientKeys = mergeRecipientKeys(legacyRecipientKeys, keyedRecipientKeys);
const authConfig = buildAuthConfig(apiKey, recipientKeys);
const corsOrigins = parseCorsOrigins(process.env.AIMTP_CORS_ORIGINS);
const allowlistDisabled = process.env.AIMTP_ALLOWLIST_RECIPIENTS === "0";
const parsedAllowlist = parseAllowlist(process.env.AIMTP_ALLOWED_RECIPIENTS);
const recipientAllowlist = allowlistDisabled
  ? { enabled: false, set: new Set<string>() }
  : parsedAllowlist;
const senderAllowlist = parseAllowlist(process.env.AIMTP_ALLOWED_SENDERS);
const mailboxStoreType = parseMailboxStoreType(
  process.env.AIMTP_STORE || process.env.AIMTP_MAILBOX_STORE
);
const mailboxSqlitePathRaw = process.env.AIMTP_MAILBOX_SQLITE_PATH?.trim();
const mailboxSqlitePath =
  mailboxSqlitePathRaw && mailboxSqlitePathRaw.length > 0 ? mailboxSqlitePathRaw : undefined;
const mailboxTtlMs = parseOptionalEnvInt(process.env.AIMTP_MAILBOX_TTL_MS);
const mailboxMaxQueueLength = parseOptionalEnvInt(process.env.AIMTP_MAILBOX_MAX_QUEUE_LENGTH);
const mailboxMaxRecipients = parseOptionalEnvInt(process.env.AIMTP_MAILBOX_MAX_RECIPIENTS);
const mailboxCleanupIntervalMs = parseOptionalEnvInt(
  process.env.AIMTP_MAILBOX_CLEANUP_INTERVAL_MS
);
const logSummaryIntervalMs = parseOptionalNonNegativeEnvInt(
  process.env.AIMTP_LOG_SUMMARY_INTERVAL_MS
);
const mailboxLeaseMs = parseOptionalEnvInt(process.env.AIMTP_MAILBOX_LEASE_MS);
const mailboxMaxRetries = parseOptionalNonNegativeEnvInt(
  process.env.AIMTP_MAILBOX_MAX_RETRIES
);
const mailboxRetryBaseMs = parseOptionalNonNegativeEnvInt(
  process.env.AIMTP_MAILBOX_RETRY_BASE_MS
);
const mailboxRetryMaxMs = parseOptionalNonNegativeEnvInt(
  process.env.AIMTP_MAILBOX_RETRY_MAX_MS
);
const redisUrl = process.env.AIMTP_REDIS_URL?.trim();
const redisHost = process.env.AIMTP_REDIS_HOST?.trim();
const redisPort = parseOptionalEnvInt(process.env.AIMTP_REDIS_PORT);
const redisDb = parseOptionalEnvInt(process.env.AIMTP_REDIS_DB);
const redisUsername = process.env.AIMTP_REDIS_USERNAME?.trim();
const redisPassword = process.env.AIMTP_REDIS_PASSWORD?.trim();
const redisKeyPrefix = process.env.AIMTP_REDIS_KEY_PREFIX?.trim();
const redisCliPath = process.env.AIMTP_REDIS_CLI_PATH?.trim();
const redisCommandTimeoutMs = parseOptionalEnvInt(process.env.AIMTP_REDIS_TIMEOUT_MS);
const redisLockTtlMs = parseOptionalEnvInt(process.env.AIMTP_REDIS_LOCK_TTL_MS);
const redisLockAcquireTimeoutMs = parseOptionalEnvInt(
  process.env.AIMTP_REDIS_LOCK_ACQUIRE_TIMEOUT_MS
);
const redisLockRetryDelayMs = parseOptionalEnvInt(process.env.AIMTP_REDIS_LOCK_RETRY_DELAY_MS);
const redisLeaseResultTtlMs = parseOptionalEnvInt(process.env.AIMTP_REDIS_LEASE_RESULT_TTL_MS);
const relayInstanceIdRaw = process.env.AIMTP_RELAY_INSTANCE_ID?.trim();
const relayInstanceId =
  relayInstanceIdRaw && relayInstanceIdRaw.length > 0
    ? relayInstanceIdRaw
    : `relay-${process.pid}`;
const signatureClockSkewSec = parseOptionalNonNegativeEnvInt(
  process.env.AIMTP_SIGNATURE_CLOCK_SKEW_SEC
);
const signatureConfig = createSignatureTrustConfig({
  policy: process.env.AIMTP_SIGNATURE_POLICY,
  trustedKeys: process.env.AIMTP_TRUSTED_KEYS,
  trustedKeysFile: process.env.AIMTP_TRUSTED_KEYS_FILE,
  clockSkewSec: signatureClockSkewSec,
  logger: console
});
const mailbox: MailboxStore = createMailboxStore({
  type: mailboxStoreType,
  sqlitePath: mailboxSqlitePath,
  ttlMs: mailboxTtlMs,
  maxQueueLength: mailboxMaxQueueLength,
  maxRecipients: mailboxMaxRecipients,
  leaseMs: mailboxLeaseMs,
  maxRetries: mailboxMaxRetries,
  retryBaseMs: mailboxRetryBaseMs,
  retryMaxMs: mailboxRetryMaxMs,
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
  relayInstanceId,
  logger: console
});
const counters: Record<CounterName, number> = {
  enqueue: 0,
  poll: 0,
  ack: 0,
  fail: 0,
  dead_letter: 0
};
const recordCounter = (
  name: CounterName,
  value: number,
  fields?: Record<string, unknown>
) => {
  if (!Number.isFinite(value) || value <= 0) {
    return;
  }
  counters[name] += value;
  const record = {
    event: "counter",
    name,
    value,
    relay_instance_id: relayInstanceId,
    ...fields
  };
  console.log(JSON.stringify(record));
};
let summaryTimer: NodeJS.Timeout | null = null;
if (logSummaryIntervalMs && logSummaryIntervalMs > 0) {
  summaryTimer = setInterval(() => {
    console.log(
      JSON.stringify({
        event: "summary",
        relay_instance_id: relayInstanceId,
        uptime_sec: Math.floor(process.uptime()),
        counters: { ...counters }
      })
    );
  }, logSummaryIntervalMs);
  summaryTimer.unref();
}
let cleanupTimer: NodeJS.Timeout | null = null;
if (mailboxCleanupIntervalMs && mailboxCleanupIntervalMs > 0 && mailbox.cleanupExpired) {
  cleanupTimer = setInterval(() => {
    try {
      mailbox.cleanupExpired?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`mailbox_cleanup_failed error=${message}`);
    }
  }, mailboxCleanupIntervalMs);
  cleanupTimer.unref();
}

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
  console.log(
    JSON.stringify({
      event: "allowlist_recipients",
      count: recipientAllowlist.set.size
    })
  );
}

const intentosEnabled = String(process.env.INTENTOS || "").trim().toLowerCase() === "on";
let intentosUiAssets: IntentosUiAssets | null = null;
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
  const method = req.method || "GET";

  if (requestPath === normalizedHealthPath) {
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

  if (readyEnabled && requestPath === normalizedReadyPath) {
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

  if (isIntentosUiPath(requestPath)) {
    if (!intentosEnabled) {
      sendError(res, 404, "not_found", "Not Found");
      return;
    }
    if (method !== "GET") {
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

  if (isIntentosApiPath(requestPath)) {
    if (!intentosEnabled) {
      sendError(res, 404, "not_found", "Not Found");
      return;
    }
    if (method !== "GET") {
      sendError(res, 405, "method_not_allowed", "Method not allowed");
      return;
    }
    if (requestPath === INTENTOS_INTENTS_PATH) {
      sendJson(res, 200, { intents: [] });
      return;
    }
    if (requestPath === INTENTOS_TASKS_PATH) {
      sendJson(res, 200, { tasks: [] });
      return;
    }
    sendError(res, 404, "not_found", "Intent not found");
    return;
  }

  const authResult = evaluateAuth(req, authConfig);
  const authStatus = authResult.status;
  let logEnvelope: EnvelopeLog | null = null;
  const logRequest = (status: number) => {
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
  const logMailbox = (status: number, recipient?: string, count?: number) => {
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

  if (!isPeek && !isPoll && !isDead && !isAck && !isFail && !isMailboxPath && !isRelayPath) {
    sendError(res, 404, "not_found", "Not Found");
    logRequest(404);
    return;
  }

  const allowedOrigin = resolveAllowedOrigin(req, corsOrigins);
  if (method === "OPTIONS") {
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
    if (method !== "GET") {
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
        sendError(res, 400, "invalid_request", "Recipient format is invalid", { recipient });
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
    if (method !== "POST") {
      sendError(res, 405, "method_not_allowed", "Method not allowed");
      logRequest(405);
      return;
    }

    let payload: unknown;
    try {
      const raw = await readRequestBody(req, maxBytes);
      payload = JSON.parse(raw);
    } catch (err) {
      if (isRelayError(err) && err.code === "payload_too_large") {
        sendError(res, 413, "payload_too_large", "Request body exceeds maximum size");
        logRequest(413);
        return;
      }
      sendError(res, 400, "invalid_json", "Invalid JSON payload");
      logRequest(400);
      return;
    }

    const recipient =
      payload && typeof (payload as { recipient?: unknown }).recipient === "string"
        ? (payload as { recipient: string }).recipient.trim()
        : "";
    if (!recipient) {
      sendError(res, 400, "invalid_request", "Recipient is required", { recipient: null });
      logRequest(400);
      return;
    }
    if (!RECIPIENT_PATTERN.test(recipient)) {
      sendError(res, 400, "invalid_request", "Recipient format is invalid", { recipient });
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

    const body = payload as { message?: unknown; payload?: unknown };
    const message = body.message ?? body.payload;
    if (message === undefined) {
      sendError(res, 400, "invalid_request", "Message payload is required");
      logRequest(400);
      return;
    }

    mailbox.enqueue(recipient, message);
    const id =
      message && typeof message === "object" && "id" in (message as Record<string, unknown>)
        ? (message as { id?: unknown }).id
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
    if (method !== "POST") {
      sendError(res, 405, "method_not_allowed", "Method not allowed");
      logRequest(405);
      return;
    }

    let payload: unknown;
    try {
      const raw = await readRequestBody(req, maxBytes);
      payload = JSON.parse(raw);
    } catch (err) {
      if (isRelayError(err) && err.code === "payload_too_large") {
        sendError(res, 413, "payload_too_large", "Request body exceeds maximum size");
        logRequest(413);
        return;
      }
      sendError(res, 400, "invalid_json", "Invalid JSON payload");
      logRequest(400);
      return;
    }

    const recipient =
      payload && typeof (payload as { recipient?: unknown }).recipient === "string"
        ? (payload as { recipient: string }).recipient.trim()
        : "";
    if (!recipient) {
      sendError(res, 400, "invalid_request", "Recipient is required", { recipient: null });
      logRequest(400);
      return;
    }
    if (!RECIPIENT_PATTERN.test(recipient)) {
      sendError(res, 400, "invalid_request", "Recipient format is invalid", { recipient });
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
      payload && typeof (payload as { lease_id?: unknown }).lease_id === "string"
        ? (payload as { lease_id: string }).lease_id.trim()
        : "";
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

    const reason =
      payload && typeof (payload as { reason?: unknown }).reason === "string"
        ? (payload as { reason: string }).reason.trim()
        : undefined;
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
      retry_count: result.retryCount ?? 0
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

  if (method !== "POST") {
    sendError(res, 405, "method_not_allowed", "Method not allowed");
    logRequest(405);
    return;
  }

  let payload: unknown;
  try {
    const raw = await readRequestBody(req, maxBytes);
    payload = JSON.parse(raw);
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      logEnvelope = payload as EnvelopeLog;
    }
  } catch (err) {
    if (isRelayError(err) && err.code === "payload_too_large") {
      sendError(res, 413, "payload_too_large", "Request body exceeds maximum size");
      logRequest(413);
      return;
    }
    sendError(res, 400, "invalid_json", "Invalid JSON payload");
    logRequest(400);
    return;
  }

  const validationErrors = validateEnvelope(payload);
  if (validationErrors.length > 0) {
    sendError(res, 400, "invalid_schema", "Envelope failed schema validation", {
      errors: validationErrors
    });
    logRequest(400);
    return;
  }

  const signatureDecision = evaluateEnvelopeSignaturePolicy(payload, signatureConfig);
  if (signatureDecision.warning) {
    console.log(
      JSON.stringify({
        event: "signature_warning",
        code: signatureDecision.warning.code || "signature_invalid",
        message: signatureDecision.warning.message || "Signature validation warning",
        details: signatureDecision.warning.details,
        envelope_id:
          payload && typeof (payload as { id?: unknown }).id === "string"
            ? (payload as { id: string }).id
            : "-"
      })
    );
  }
  if (!signatureDecision.allowed && signatureDecision.error) {
    const status = signatureDecision.error.httpStatus || 403;
    sendError(
      res,
      status,
      signatureDecision.error.code || "signature_invalid",
      signatureDecision.error.message || "Signature validation failed",
      signatureDecision.error.details
    );
    logRequest(status);
    return;
  }

  const recipient =
    payload && typeof (payload as { recipient?: unknown }).recipient === "string"
      ? (payload as { recipient: string }).recipient.trim()
      : "";
  if (!recipient) {
    sendError(res, 400, "missing_recipient", "Recipient is required", { recipient: null });
    logRequest(400);
    return;
  }

  if (senderAllowlist.enabled) {
    const sender =
      payload && typeof (payload as { sender?: unknown }).sender === "string"
        ? (payload as { sender: string }).sender.trim()
        : "";
    if (!sender) {
      sendError(res, 403, "unknown_sender", "Sender is required", { sender: null });
      logRequest(403);
      return;
    }
    if (!senderAllowlist.set.has(sender)) {
      sendError(res, 403, "unknown_sender", `Unknown sender: ${sender}`, { sender });
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
    const handler = relay.registry.get(recipient);
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
    id: (payload as { id?: string }).id,
    recipient,
    queued: true,
    queue_depth: enqueueResult.queueDepth
  });
  logRequest(202);
  recordCounter("enqueue", 1, { recipient, path: "relay" });
});

server.listen(port, () => {
  console.log(`AIMTP relay listening on port ${port}${relayPath}`);
});

let shutdownInProgress = false;
function shutdown(reason: string) {
  if (shutdownInProgress) {
    return;
  }
  shutdownInProgress = true;
  console.log(JSON.stringify({ event: "shutdown", reason }));
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  if (summaryTimer) {
    clearInterval(summaryTimer);
    summaryTimer = null;
  }
  if (typeof mailbox.close === "function") {
    mailbox.close();
  }
  server.close(() => {
    process.exit(0);
  });
}

["SIGINT", "SIGTERM"].forEach((signal) => {
  process.on(signal, () => shutdown(signal));
});
