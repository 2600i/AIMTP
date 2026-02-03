"use strict";

const { WebhookRelay, createWebhookRelayServer } = require("../../runtime");
const { createEnvelope, createMessage, createTaskResponse } = require("../../sdk/js");

function parseUrl(raw) {
  try {
    return new URL(raw);
  } catch (err) {
    return new URL("http://127.0.0.1:8787/aimtp");
  }
}

const relayUrl = parseUrl(process.env.AIMTP_RELAY_URL || "http://127.0.0.1:8787/aimtp");
const host = relayUrl.hostname || "127.0.0.1";
const port = relayUrl.port ? Number(relayUrl.port) : relayUrl.protocol === "https:" ? 443 : 80;
const path = relayUrl.pathname || "/aimtp";

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
  console.log(`AIMTP relay listening on ${relayUrl.origin}${path}`);
});

function shutdown() {
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
