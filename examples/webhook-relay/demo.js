"use strict";

const http = require("http");
const { WebhookRelay, createWebhookRelayServer } = require("../../runtime");
const {
  createEnvelope,
  createMessage,
  createTaskRequest,
  createTaskResponse
} = require("../../sdk/js");

function postJson(port, path, payload) {
  const body = JSON.stringify(payload);
  const options = {
    hostname: "127.0.0.1",
    port,
    path,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body)
    }
  };

  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        if (!raw) {
          resolve({ status: res.statusCode, body: null });
          return;
        }
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const relay = new WebhookRelay({ emitResponses: true });

  relay.registerAgent("agent-b", async (envelope, context) => {
    if (!context.task || context.task.kind !== "request") {
      return;
    }

    const runningEnvelope = createEnvelope({
      sender: "agent-b",
      recipient: context.sender,
      intent: "task.response",
      message: createMessage({
        role: "assistant",
        content: `Task ${context.task.id} is running.`
      }),
      task: createTaskResponse({
        id: `${context.task.id}-running`,
        in_response_to: context.task.id,
        status: "running"
      })
    });

    context.emit(runningEnvelope);

    const succeededEnvelope = createEnvelope({
      sender: "agent-b",
      recipient: context.sender,
      intent: "task.response",
      message: createMessage({
        role: "assistant",
        content: `Task ${context.task.id} succeeded.`
      }),
      task: createTaskResponse({
        id: `${context.task.id}-succeeded`,
        in_response_to: context.task.id,
        status: "succeeded",
        output: { result: "done" }
      })
    });

    context.emit(succeededEnvelope);
  });

  const server = createWebhookRelayServer(relay, { path: "/inbox" });
  await new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener("listening", onListen);
      reject(err);
    };
    const onListen = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListen);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  const port = address.port;

  const requestEnvelope = createEnvelope({
    sender: "agent-a",
    recipient: "agent-b",
    intent: "task.request",
    message: createMessage({
      role: "user",
      content: "Run the demo task."
    }),
    task: createTaskRequest({
      id: "task-001",
      type: "demo",
      input: { payload: "ping" },
      expects_response: true
    })
  });

  const response = await postJson(port, "/inbox", requestEnvelope);
  console.log(`HTTP ${response.status}`);
  console.log(JSON.stringify(response.body, null, 2));

  server.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
