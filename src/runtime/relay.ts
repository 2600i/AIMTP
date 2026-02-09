import * as http from "http";

const { WebhookRelay } = require("../../runtime/relay") as {
  WebhookRelay: new (options?: { emitResponses?: boolean }) => {
    registerAgent: (
      agentId: string,
      handler: (envelope: unknown, context: any) => void | Promise<void>
    ) => void;
  };
};

const { createWebhookRelayServer } = require("../../runtime/http") as {
  createWebhookRelayServer: (
    relay: unknown,
    options?: Record<string, unknown>
  ) => http.Server;
};

const { createEnvelope, createMessage, createTaskResponse } = require("../../sdk/js") as {
  createEnvelope: (payload: any) => any;
  createMessage: (payload: any) => any;
  createTaskResponse: (payload: any) => any;
};

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
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

const port = parsePort(process.env.PORT, 8787);
const server = createWebhookRelayServer(relay, {});

server.listen(port, () => {
  const relayPath = process.env.AIMTP_RELAY_PATH?.trim() || "/aimtp";
  console.log(`AIMTP relay listening on port ${port}${relayPath}`);
});

let shutdownInProgress = false;
function shutdown(reason: string): void {
  if (shutdownInProgress) {
    return;
  }
  shutdownInProgress = true;
  console.log(JSON.stringify({ event: "shutdown", reason }));
  server.close(() => {
    process.exit(0);
  });
}

["SIGINT", "SIGTERM"].forEach((signal) => {
  process.on(signal, () => shutdown(signal));
});
