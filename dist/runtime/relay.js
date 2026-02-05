"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const http = __importStar(require("http"));
const mailbox_1 = require("./mailbox");
const { WebhookRelay, RelayError } = require("../../runtime/relay");
const { validateEnvelope } = require("../../runtime/validation");
const { createEnvelope, createMessage, createTaskResponse } = require("../../sdk/js");
const packageJson = require("../../package.json");
const DEFAULT_PORT = 8787;
const DEFAULT_PATH = "/aimtp";
const DEFAULT_HEALTH_PATH = "/healthz";
const DEFAULT_READY_PATH = "/readyz";
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_POLL_MAX = 1;
const MAX_POLL_LIMIT = 50;
const DEFAULT_CORS_ORIGINS = ["http://localhost:8080", "http://127.0.0.1:8080"];
const RECIPIENT_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/;
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
function parseOptionalEnvInt(value) {
    if (!value || value.trim() === "") {
        return undefined;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return undefined;
    }
    return parsed;
}
function envPath(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined) {
        return fallback;
    }
    const trimmed = raw.trim();
    return trimmed;
}
function parseAllowlist(value) {
    if (!value) {
        return { enabled: false, set: new Set() };
    }
    const entries = value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    return { enabled: entries.length > 0, set: new Set(entries) };
}
function parseRecipientKeys(value) {
    if (!value) {
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
        keyToRecipients.get(key)?.add(recipient);
    });
    return { enabled: keyToRecipients.size > 0, keyToRecipients };
}
function parseKeyRecipients(value) {
    if (!value) {
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
        recipients.forEach((recipient) => bucket?.add(recipient));
    });
    return { enabled: keyToRecipients.size > 0, keyToRecipients };
}
function mergeRecipientKeys(...entries) {
    const keyToRecipients = new Map();
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
function parseCorsOrigins(value) {
    if (value === undefined) {
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
        adminKey: apiKey,
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
            req.on("error", () => { });
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
                const error = new Error("Request body exceeds maximum size");
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
function isRelayError(err) {
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
const relayPath = relayPathInput.length > 1 && relayPathInput.endsWith("/")
    ? relayPathInput.slice(0, -1)
    : relayPathInput;
const peekPath = `${relayPath}/peek`;
const pollPath = `${relayPath}/poll`;
const mailboxPath = `${relayPath}/mailbox`;
const healthPath = envPath("AIMTP_HEALTH_PATH", DEFAULT_HEALTH_PATH) || DEFAULT_HEALTH_PATH;
const readyPath = envPath("AIMTP_READY_PATH", DEFAULT_READY_PATH);
const readyEnabled = readyPath !== "";
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
    ? { enabled: false, set: new Set() }
    : parsedAllowlist;
const senderAllowlist = parseAllowlist(process.env.AIMTP_ALLOWED_SENDERS);
const mailboxStoreType = (0, mailbox_1.parseMailboxStoreType)(process.env.AIMTP_STORE || process.env.AIMTP_MAILBOX_STORE);
const mailboxSqlitePathRaw = process.env.AIMTP_MAILBOX_SQLITE_PATH?.trim();
const mailboxSqlitePath = mailboxSqlitePathRaw && mailboxSqlitePathRaw.length > 0 ? mailboxSqlitePathRaw : undefined;
const mailboxTtlMs = parseOptionalEnvInt(process.env.AIMTP_MAILBOX_TTL_MS);
const mailboxMaxQueueLength = parseOptionalEnvInt(process.env.AIMTP_MAILBOX_MAX_QUEUE_LENGTH);
const mailboxMaxRecipients = parseOptionalEnvInt(process.env.AIMTP_MAILBOX_MAX_RECIPIENTS);
const mailboxCleanupIntervalMs = parseOptionalEnvInt(process.env.AIMTP_MAILBOX_CLEANUP_INTERVAL_MS);
const redisUrl = process.env.AIMTP_REDIS_URL?.trim();
const redisHost = process.env.AIMTP_REDIS_HOST?.trim();
const redisPort = parseOptionalEnvInt(process.env.AIMTP_REDIS_PORT);
const redisDb = parseOptionalEnvInt(process.env.AIMTP_REDIS_DB);
const redisUsername = process.env.AIMTP_REDIS_USERNAME?.trim();
const redisPassword = process.env.AIMTP_REDIS_PASSWORD?.trim();
const redisKeyPrefix = process.env.AIMTP_REDIS_KEY_PREFIX?.trim();
const redisCliPath = process.env.AIMTP_REDIS_CLI_PATH?.trim();
const redisCommandTimeoutMs = parseOptionalEnvInt(process.env.AIMTP_REDIS_TIMEOUT_MS);
const mailbox = (0, mailbox_1.createMailboxStore)({
    type: mailboxStoreType,
    sqlitePath: mailboxSqlitePath,
    ttlMs: mailboxTtlMs,
    maxQueueLength: mailboxMaxQueueLength,
    maxRecipients: mailboxMaxRecipients,
    redisUrl,
    redisHost,
    redisPort,
    redisDb,
    redisUsername,
    redisPassword,
    redisKeyPrefix,
    redisCliPath,
    redisCommandTimeoutMs,
    logger: console
});
let cleanupTimer = null;
if (mailboxCleanupIntervalMs && mailboxCleanupIntervalMs > 0 && mailbox.cleanupExpired) {
    cleanupTimer = setInterval(() => {
        try {
            mailbox.cleanupExpired?.();
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.log(`mailbox_cleanup_failed error=${message}`);
        }
    }, mailboxCleanupIntervalMs);
    cleanupTimer.unref();
}
console.log(JSON.stringify({
    event: "allowlist_state",
    enabled: recipientAllowlist.enabled,
    key_count: recipientKeys.keyToRecipients.size
}));
if (recipientAllowlist.enabled) {
    console.log(JSON.stringify({
        event: "allowlist_recipients",
        count: recipientAllowlist.set.size
    }));
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
    if (readyEnabled && url.pathname === readyPath) {
        if (method !== "GET") {
            sendError(res, 405, "method_not_allowed", "Method not allowed");
            return;
        }
        if (server.listening) {
            sendJson(res, 200, { status: "ready" });
        }
        else {
            sendJson(res, 503, { status: "not_ready" });
        }
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
    const isMailboxPath = url.pathname === mailboxPath;
    const isRelayPath = url.pathname === relayPath;
    if (!isPeek && !isPoll && !isMailboxPath && !isRelayPath) {
        sendError(res, 404, "not_found", "Not Found");
        logRequest(404);
        return;
    }
    const allowedOrigin = resolveAllowedOrigin(req, corsOrigins);
    if (method === "OPTIONS") {
        if (!allowedOrigin) {
            sendError(res, 403, "forbidden", "Origin not allowed");
            if (isPeek || isPoll) {
                logMailbox(403);
            }
            else {
                logRequest(403);
            }
            return;
        }
        setCorsHeaders(res, allowedOrigin);
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type,X-AIMTP-KEY");
        res.setHeader("Access-Control-Max-Age", "600");
        res.statusCode = 204;
        res.end();
        if (isPeek || isPoll) {
            logMailbox(204);
        }
        else {
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
            if (isPeek || isPoll) {
                logMailbox(401);
            }
            else {
                logRequest(401);
            }
            return;
        }
        sendError(res, 403, "forbidden", "Invalid API key");
        if (isPeek || isPoll) {
            logMailbox(403);
        }
        else {
            logRequest(403);
        }
        return;
    }
    if (isPeek || isPoll) {
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
        }
        else {
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
            sendJson(res, 200, { recipient, count: result.count });
            logMailbox(200, recipient, result.count);
            return;
        }
        const maxItems = parseMaxParam(url.searchParams.get("max"));
        const items = mailbox.poll(recipient, maxItems);
        sendJson(res, 200, items);
        logMailbox(200, recipient, items.length);
        return;
    }
    if (isMailboxPath) {
        if (method !== "POST") {
            sendError(res, 405, "method_not_allowed", "Method not allowed");
            logRequest(405);
            return;
        }
        let payload;
        try {
            const raw = await readRequestBody(req, maxBytes);
            payload = JSON.parse(raw);
        }
        catch (err) {
            if (isRelayError(err) && err.code === "payload_too_large") {
                sendError(res, 413, "payload_too_large", "Request body exceeds maximum size");
                logRequest(413);
                return;
            }
            sendError(res, 400, "invalid_json", "Invalid JSON payload");
            logRequest(400);
            return;
        }
        const recipient = payload && typeof payload.recipient === "string"
            ? payload.recipient.trim()
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
        const body = payload;
        const message = body.message ?? body.payload;
        if (message === undefined) {
            sendError(res, 400, "invalid_request", "Message payload is required");
            logRequest(400);
            return;
        }
        mailbox.enqueue(recipient, message);
        const id = message && typeof message === "object" && "id" in message
            ? message.id
            : undefined;
        sendJson(res, 200, {
            ok: true,
            recipient,
            id
        });
        logRequest(200);
        return;
    }
    if (method !== "POST") {
        sendError(res, 405, "method_not_allowed", "Method not allowed");
        logRequest(405);
        return;
    }
    let payload;
    try {
        const raw = await readRequestBody(req, maxBytes);
        payload = JSON.parse(raw);
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
            logEnvelope = payload;
        }
    }
    catch (err) {
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
    const recipient = payload && typeof payload.recipient === "string"
        ? payload.recipient.trim()
        : "";
    if (!recipient) {
        sendError(res, 400, "missing_recipient", "Recipient is required", { recipient: null });
        logRequest(400);
        return;
    }
    if (senderAllowlist.enabled) {
        const sender = payload && typeof payload.sender === "string"
            ? payload.sender.trim()
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
    }
    else {
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
        id: payload.id,
        recipient,
        queued: true,
        queue_depth: enqueueResult.queueDepth
    });
    logRequest(202);
});
server.listen(port, () => {
    console.log(`AIMTP relay listening on port ${port}${relayPath}`);
});
let shutdownInProgress = false;
function shutdown(reason) {
    if (shutdownInProgress) {
        return;
    }
    shutdownInProgress = true;
    console.log(JSON.stringify({ event: "shutdown", reason }));
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
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
