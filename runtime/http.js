"use strict";

const http = require("http");
const { RelayError } = require("./relay");
const packageJson = require("../package.json");

const DEFAULT_PATH = "/aimtp";
const DEFAULT_HEALTH_PATH = "/healthz";
const DEFAULT_READY_PATH = "/readyz";
const DEFAULT_MAX_BYTES = 1024 * 1024;

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

function evaluateAuth(req, apiKey) {
  if (!apiKey) {
    return { enabled: false, status: "disabled", ok: true };
  }
  const provided = extractAuthKey(req);
  if (!provided) {
    return { enabled: true, status: "missing", ok: false };
  }
  if (provided !== apiKey) {
    return { enabled: true, status: "invalid", ok: false };
  }
  return { enabled: true, status: "ok", ok: true };
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
  const recipientAllowlist = parseAllowlist(process.env.AIMTP_ALLOWED_RECIPIENTS);
  const senderAllowlist = parseAllowlist(process.env.AIMTP_ALLOWED_SENDERS);
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
    const authResult = evaluateAuth(req, apiKey);
    const authStatus = authResult.status;
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

    const pathMatches = url.pathname === path;
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

    if (!pathMatches) {
      sendError(res, 404, "not_found", "Not Found");
      logRequest(404);
      return;
    }

    if (authResult.enabled && !authResult.ok) {
      if (authStatus === "missing") {
        sendError(res, 401, "unauthorized", "Missing API key");
        logRequest(401);
        return;
      }
      sendError(res, 403, "forbidden", "Invalid API key");
      logRequest(403);
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

    const isEnvelopeObject =
      payload && typeof payload === "object" && !Array.isArray(payload);

    if (senderAllowlist.enabled && isEnvelopeObject) {
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

    if (recipientAllowlist.enabled && isEnvelopeObject) {
      const recipient =
        typeof payload.recipient === "string" ? payload.recipient.trim() : "";
      if (!recipient) {
        sendError(res, 400, "invalid_request", "Recipient is required", {
          recipient: null
        });
        logRequest(400);
        return;
      }
      if (!recipientAllowlist.set.has(recipient)) {
        sendError(res, 404, "unknown_recipient", `Unknown recipient: ${recipient}`, {
          recipient
        });
        logRequest(404);
        return;
      }
    }

    try {
      const result = await relay.receive(payload);
      if (result && result.__aimtpAccepted) {
        sendJson(res, 202, {
          status: result.status,
          id: result.id,
          recipient: result.recipient
        });
        logRequest(202);
        return;
      }

      if (relay.emitResponses) {
        sendJson(res, 200, result);
        logRequest(200);
      } else {
        res.statusCode = 204;
        res.end();
        logRequest(204);
      }
    } catch (err) {
      if (err instanceof RelayError) {
        if (err.code === "invalid_envelope" || err.code === "invalid_response") {
          sendError(res, 400, "invalid_schema", err.message, err.details);
          logRequest(400);
          return;
        }
        if (err.code === "missing_recipient") {
          sendError(res, 400, err.code, err.message, err.details);
          logRequest(400);
          return;
        }
        if (err.code === "unknown_recipient") {
          sendError(res, 404, err.code, err.message, err.details);
          logRequest(404);
          return;
        }
        if (err.code === "handler_error") {
          sendError(res, 500, "handler_error", err.message);
          logRequest(500);
          return;
        }
        sendError(res, 500, err.code || "internal_error", err.message || "Internal error");
        logRequest(500);
        return;
      }

      sendError(res, 500, "internal_error", "Internal server error");
      logRequest(500);
    }
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
