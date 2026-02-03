"use strict";

const assert = require("assert");
const http = require("http");
const { WebhookRelay, createWebhookRelayServer } = require("../runtime");
const {
  createEnvelope,
  createMessage,
  createTaskRequest,
  createTaskResponse
} = require("../sdk/js");

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

function startServer(server) {
  return new Promise((resolve, reject) => {
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
}

async function main() {
  const relay = new WebhookRelay({ emitResponses: true });

  relay.registerAgent("agent-b", async (_envelope, context) => {
    if (!context.task || context.task.kind !== "request") {
      return;
    }

    const responseTaskId = `${context.task.id}-resp-001`;
    const responseEnvelope = createEnvelope({
      sender: "agent-b",
      recipient: context.sender,
      intent: "task.response",
      message: createMessage({
        role: "assistant",
        content: `Task ${context.task.id} done.`
      }),
      task: createTaskResponse({
        id: responseTaskId,
        in_response_to: context.task.id,
        status: "succeeded",
        output: { ok: true }
      })
    });

    context.emit(responseEnvelope);
  });

  const server = createWebhookRelayServer(relay, { path: "/inbox" });

  try {
    await startServer(server);
  } catch (err) {
    if (err && err.code === "EPERM") {
      console.log("SKIP: runtime relay test (listen not permitted)");
      return;
    }
    throw err;
  }

  const address = server.address();
  const port = address.port;

  try {
    const requestTask = createTaskRequest({
      id: "task-001",
      type: "demo",
      input: { payload: "ping" },
      expects_response: true
    });

    const requestEnvelope = createEnvelope({
      sender: "agent-a",
      recipient: "agent-b",
      intent: "task.request",
      message: createMessage({
        role: "user",
        content: "Run the demo task."
      }),
      task: requestTask
    });

    const ok = await postJson(port, "/inbox", requestEnvelope);
    assert.strictEqual(ok.status, 200);
    assert.ok(Array.isArray(ok.body), "expected response array");

    if (ok.body.length > 0) {
      ok.body.forEach((response) => {
        if (response.task && response.task.kind === "response") {
          assert.strictEqual(response.task.in_response_to, requestTask.id);
        }
      });
    }

    const badEnvelope = { ...requestEnvelope, spec: "aimtp/0.0" };
    const bad = await postJson(port, "/inbox", badEnvelope);
    assert.strictEqual(bad.status, 400);
  } finally {
    server.close();
  }

  console.log("OK: runtime relay test");
}

main();
