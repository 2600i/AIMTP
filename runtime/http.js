"use strict";

const http = require("http");
const { RelayError } = require("./relay");
const { Mailbox } = require("./mailbox");
const { validateEnvelope } = require("./validation");
const packageJson = require("../package.json");

const DEFAULT_PATH = "/aimtp";
const DEFAULT_HEALTH_PATH = "/healthz";
const DEFAULT_READY_PATH = "/readyz";
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_POLL_MAX = 1;
const MAX_POLL_LIMIT = 50;

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

function createWebhookRelayServer(relay, options = {}) {
  const path =
    options.path ||
    (process.env.AIMTP_RELAY_PATH && process.env.AIMTP_RELAY_PATH.trim()) ||
    DEFAULT_PATH;
  const relayPath =
    path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const peekPath = `${relayPath}/peek`;
  const pollPath = `${relayPath}/poll`;
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
  const recipientKeys = parseRecipientKeys(process.env.AIMTP_RECIPIENT_KEYS);
  const authConfig = buildAuthConfig(apiKey, recipientKeys);
  const recipientAllowlist = parseAllowlist(process.env.AIMTP_ALLOWED_RECIPIENTS);
  const senderAllowlist = parseAllowlist(process.env.AIMTP_ALLOWED_SENDERS);
  const mailbox =
    options.mailbox || new Mailbox({ now: options.now, logger: options.logger || console });
  const defaultHandler = (envelope, context) => ({
    __aimtpAccepted: true,
    status: "accepted",
    id: envelope.id,
    recipient: context.recipient
  });
  defaultHandler.__aimtpDefault = true;

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

    if (url.pathname === healthPath) {
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
    if (url.pathname === readyPath) {
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
    const isRelayPath = url.pathname === relayPath;

    if (!isPeek && !isPoll && !isRelayPath) {
      sendError(res, 404, "not_found", "Not Found");
      logRequest(404);
      return;
    }

    if (authResult.enabled && !authResult.ok) {
      if (authStatus === "missing") {
        sendError(res, 401, "unauthorized", "Missing API key");
        if (isPeek || isPoll) {
          logMailbox(401);
        } else {
          logRequest(401);
        }
        return;
      }
      sendError(res, 403, "forbidden", "Invalid API key");
      if (isPeek || isPoll) {
        logMailbox(403);
      } else {
        logRequest(403);
      }
      return;
    }

    if (isPeek || isPoll) {
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
        const handler =
          relay && relay.registry && typeof relay.registry.get === "function"
            ? relay.registry.get(recipient)
            : null;
        if (!handler) {
          sendError(res, 404, "unknown_recipient", `Unknown recipient: ${recipient}`, {
            recipient
          });
          logMailbox(404, recipient);
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
  });

  trackedServers.add(server);
  server.on("close", () => {
    trackedServers.delete(server);
  });
  registerShutdownHandlers();
  return server;
}

module.exports = {
  createWebhookRelayServer
};
