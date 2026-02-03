"use strict";

const http = require("http");
const { RelayError } = require("./relay");

const DEFAULT_PATH = "/aimtp";
const DEFAULT_MAX_BYTES = 1024 * 1024;

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
  const maxBytes =
    typeof options.maxBytes === "number"
      ? options.maxBytes
      : parseEnvInt(process.env.AIMTP_MAX_BODY_BYTES, DEFAULT_MAX_BYTES);

  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const pathMatches = url.pathname === path;
    let logEnvelope = null;
    const logRequest = (status) => {
      const envelope = logEnvelope || {};
      const record = {
        id: envelope.id || "-",
        intent: envelope.intent || "-",
        sender: envelope.sender || "-",
        recipient: envelope.recipient || "-",
        status
      };
      console.log(JSON.stringify(record));
    };

    if (!pathMatches) {
      sendError(res, 404, "not_found", "Not Found");
      logRequest(404);
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
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
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

    try {
      const responses = await relay.receive(payload);
      if (relay.emitResponses) {
        sendJson(res, 200, responses);
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
}

module.exports = {
  createWebhookRelayServer
};
