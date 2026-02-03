"use strict";

const http = require("http");
const { RelayError } = require("./relay");

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new RelayError("payload_too_large", "Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });

    req.on("error", (err) => {
      reject(err);
    });
  });
}

function createWebhookRelayServer(relay, options = {}) {
  const path = options.path || "/inbox";
  const maxBytes = options.maxBytes || 1024 * 1024;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (req.method !== "POST" || url.pathname !== path) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }

    let payload;
    try {
      const raw = await readRequestBody(req, maxBytes);
      payload = JSON.parse(raw);
    } catch (err) {
      if (err instanceof RelayError && err.code === "payload_too_large") {
        sendJson(res, 413, { error: { code: err.code, message: err.message } });
        return;
      }
      sendJson(res, 400, {
        error: { code: "invalid_json", message: "Invalid JSON payload" }
      });
      return;
    }

    try {
      const responses = await relay.receive(payload);
      if (relay.emitResponses) {
        sendJson(res, 200, responses);
      } else {
        res.statusCode = 204;
        res.end();
      }
    } catch (err) {
      if (err instanceof RelayError) {
        let status = 500;
        if (
          err.code === "invalid_envelope" ||
          err.code === "missing_recipient" ||
          err.code === "invalid_response"
        ) {
          status = 400;
        } else if (err.code === "unknown_recipient") {
          status = 404;
        }
        sendJson(res, status, {
          error: {
            code: err.code,
            message: err.message,
            details: err.details
          }
        });
        return;
      }

      sendJson(res, 500, {
        error: { code: "internal_error", message: "Internal server error" }
      });
    }
  });
}

module.exports = {
  createWebhookRelayServer
};
