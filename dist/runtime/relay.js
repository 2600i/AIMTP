"use strict";

const { WebhookRelay, createWebhookRelayServer } = require("../../runtime");
const { createEnvelope, createMessage, createTaskResponse } = require("../../sdk/js");

const DEFAULT_PORT = 8787;
const DEFAULT_PATH = "/aimtp";

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

function parseUrl(raw) {
  try {
    return new URL(raw);
  } catch (err) {
    return null;
  }
}

const parsedUrl = parseUrl(process.env.AIMTP_RELAY_URL || "");
const host = (parsedUrl && parsedUrl.hostname) || "127.0.0.1";
const port = parseEnvInt(process.env.PORT, parsedUrl ? Number(parsedUrl.port) : DEFAULT_PORT);
const path =
  (process.env.AIMTP_RELAY_PATH && process.env.AIMTP_RELAY_PATH.trim()) ||
  (parsedUrl && parsedUrl.pathname) ||
  DEFAULT_PATH;

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

const server = createWebhookRelayServer(relay, { path });

server.listen(port, host, () => {
  console.log(`AIMTP relay listening on http://${host}:${port}${path}`);
});

function shutdown() {
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
