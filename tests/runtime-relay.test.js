"use strict";

const assert = require("assert");
const http = require("http");
const packageJson = require("../package.json");
const { WebhookRelay, createWebhookRelayServer } = require("../runtime");
const {
  createEnvelope,
  createMessage,
  createTaskRequest,
  createTaskResponse
} = require("../sdk/js");

function postJson(port, path, payload, headers = {}) {
  const body = JSON.stringify(payload);
  const options = {
    hostname: "127.0.0.1",
    port,
    path,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      ...headers
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

function getJson(port, path, headers = {}) {
  const options = {
    hostname: "127.0.0.1",
    port,
    path,
    method: "GET",
    headers
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

async function withEnv(values, fn) {
  const previous = {};
  Object.keys(values).forEach((key) => {
    previous[key] = Object.prototype.hasOwnProperty.call(process.env, key)
      ? process.env[key]
      : undefined;
    if (values[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = String(values[key]);
    }
  });
  try {
    return await fn();
  } finally {
    Object.keys(values).forEach((key) => {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    });
  }
}

function createResponderRelay() {
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

  return relay;
}

function createErrorRelay() {
  const relay = new WebhookRelay({ emitResponses: true });
  relay.registerAgent("agent-error", async () => {
    throw new Error("boom");
  });
  return relay;
}

function buildRequestEnvelope(recipient) {
  const task = createTaskRequest({
    id: "task-001",
    type: "demo",
    input: { payload: "ping" },
    expects_response: true
  });

  return createEnvelope({
    sender: "agent-a",
    recipient,
    intent: "task.request",
    message: createMessage({
      role: "user",
      content: "Run the demo task."
    }),
    task
  });
}

async function withServer(relay, options, fn) {
  const server = createWebhookRelayServer(relay, options);

  try {
    await startServer(server);
  } catch (err) {
    if (err && err.code === "EPERM") {
      console.log("SKIP: runtime relay test (listen not permitted)");
      return false;
    }
    throw err;
  }

  const address = server.address();
  const port = address.port;

  try {
    await fn(port);
  } finally {
    server.close();
  }

  return true;
}

async function main() {
  const ranDefault = await withEnv(
    {
      AIMTP_RELAY_PATH: undefined,
      AIMTP_HEALTH_PATH: undefined,
      AIMTP_READY_PATH: undefined,
      AIMTP_API_KEY: undefined,
      AIMTP_ALLOWED_RECIPIENTS: undefined,
      AIMTP_ALLOWED_SENDERS: undefined
    },
    async () =>
      withServer(createResponderRelay(), {}, async (port) => {
        const health = await getJson(port, "/healthz");
        assert.strictEqual(health.status, 200);
        assert.strictEqual(health.body.status, "ok");
        assert.strictEqual(health.body.service, "aimtp-relay");
        assert.strictEqual(health.body.version, packageJson.version);

        const ready = await getJson(port, "/readyz");
        assert.strictEqual(ready.status, 200);

        const requestEnvelope = buildRequestEnvelope("agent-b");
        const ok = await postJson(port, "/aimtp", requestEnvelope);
        assert.strictEqual(ok.status, 200);
        assert.ok(Array.isArray(ok.body), "expected response array");

        if (ok.body.length > 0) {
          ok.body.forEach((response) => {
            if (response.task && response.task.kind === "response") {
              assert.strictEqual(response.task.in_response_to, requestEnvelope.task.id);
            }
          });
        }

        const badEnvelope = { ...requestEnvelope, spec: "aimtp/0.0" };
        const bad = await postJson(port, "/aimtp", badEnvelope);
        assert.strictEqual(bad.status, 400);
        assert.strictEqual(bad.body.code, "invalid_schema");
      })
  );

  if (!ranDefault) {
    return;
  }

  await withEnv(
    {
      AIMTP_RELAY_PATH: undefined,
      AIMTP_HEALTH_PATH: undefined,
      AIMTP_READY_PATH: undefined,
      AIMTP_API_KEY: undefined,
      AIMTP_ALLOWED_RECIPIENTS: "agent-a,agent-b",
      AIMTP_ALLOWED_SENDERS: undefined
    },
    async () =>
      withServer(createResponderRelay(), {}, async (port) => {
        const allowed = buildRequestEnvelope("agent-b");
        const ok = await postJson(port, "/aimtp", allowed);
        assert.strictEqual(ok.status, 200);

        const blocked = buildRequestEnvelope("agent-x");
        const res = await postJson(port, "/aimtp", blocked);
        assert.strictEqual(res.status, 404);
        assert.strictEqual(res.body.code, "unknown_recipient");
      })
  );

  await withEnv(
    {
      AIMTP_RELAY_PATH: "/custom",
      AIMTP_HEALTH_PATH: undefined,
      AIMTP_READY_PATH: undefined,
      AIMTP_API_KEY: undefined,
      AIMTP_ALLOWED_RECIPIENTS: undefined,
      AIMTP_ALLOWED_SENDERS: undefined
    },
    async () =>
      withServer(createResponderRelay(), {}, async (port) => {
        const requestEnvelope = buildRequestEnvelope("agent-b");
        const ok = await postJson(port, "/custom", requestEnvelope);
        assert.strictEqual(ok.status, 200);
      })
  );

  await withEnv(
    {
      AIMTP_RELAY_PATH: undefined,
      AIMTP_MAX_BODY_BYTES: "64",
      AIMTP_HEALTH_PATH: undefined,
      AIMTP_READY_PATH: undefined,
      AIMTP_API_KEY: undefined,
      AIMTP_ALLOWED_RECIPIENTS: undefined,
      AIMTP_ALLOWED_SENDERS: undefined
    },
    async () =>
      withServer(createResponderRelay(), {}, async (port) => {
        const tooLarge = { data: "x".repeat(1024) };
        const res = await postJson(port, "/aimtp", tooLarge);
        assert.strictEqual(res.status, 413);
        assert.strictEqual(res.body.code, "payload_too_large");
      })
  );

  await withEnv(
    {
      AIMTP_RELAY_PATH: undefined,
      AIMTP_HEALTH_PATH: undefined,
      AIMTP_READY_PATH: undefined,
      AIMTP_API_KEY: undefined,
      AIMTP_ALLOWED_RECIPIENTS: undefined,
      AIMTP_ALLOWED_SENDERS: undefined
    },
    async () =>
      withServer(createErrorRelay(), {}, async (port) => {
        const requestEnvelope = buildRequestEnvelope("agent-error");
        const res = await postJson(port, "/aimtp", requestEnvelope);
        assert.strictEqual(res.status, 500);
        assert.strictEqual(res.body.code, "handler_error");
      })
  );

  await withEnv(
    {
      AIMTP_RELAY_PATH: undefined,
      AIMTP_HEALTH_PATH: undefined,
      AIMTP_READY_PATH: undefined,
      AIMTP_API_KEY: "super-secret",
      AIMTP_ALLOWED_RECIPIENTS: undefined,
      AIMTP_ALLOWED_SENDERS: undefined
    },
    async () =>
      withServer(createResponderRelay(), {}, async (port) => {
        const requestEnvelope = buildRequestEnvelope("agent-b");

        const missing = await postJson(port, "/aimtp", requestEnvelope);
        assert.strictEqual(missing.status, 401);
        assert.strictEqual(missing.body.code, "unauthorized");
        assert.strictEqual(missing.body.message, "Missing API key");

        const invalid = await postJson(port, "/aimtp", requestEnvelope, {
          Authorization: "Bearer wrong-key"
        });
        assert.strictEqual(invalid.status, 403);
        assert.strictEqual(invalid.body.code, "forbidden");
        assert.strictEqual(invalid.body.message, "Invalid API key");

        const ok = await postJson(port, "/aimtp", requestEnvelope, {
          "X-AIMTP-KEY": "super-secret"
        });
        assert.strictEqual(ok.status, 200);
        assert.ok(Array.isArray(ok.body), "expected response array");

        const health = await getJson(port, "/healthz");
        assert.strictEqual(health.status, 200);
      })
  );

  console.log("OK: runtime relay test");
}

main();
