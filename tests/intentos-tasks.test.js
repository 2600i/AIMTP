"use strict";

const assert = require("assert");
const http = require("http");
const { WebhookRelay, createWebhookRelayServer } = require("../runtime");

const ADMIN_KEY = "intentos-tasks-admin";

function authHeaders(key) {
  return { "X-AIMTP-KEY": key };
}

function postJson(port, routePath, payload, headers = {}) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: routePath,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...headers
        }
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          const parsed = raw ? JSON.parse(raw) : null;
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function getJson(port, routePath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: routePath,
        method: "GET",
        headers
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          const parsed = raw ? JSON.parse(raw) : null;
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
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

async function withServer(env, fn) {
  const previous = {};
  Object.keys(env).forEach((key) => {
    previous[key] = Object.prototype.hasOwnProperty.call(process.env, key)
      ? process.env[key]
      : undefined;
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = String(env[key]);
    }
  });

  const relay = new WebhookRelay({ emitResponses: true });
  relay.registerAgent("agent.intentos.default", () => ({ __aimtpAccepted: true }));
  relay.registerAgent("service.intentos.orchestrator", () => ({ __aimtpAccepted: true }));

  const server = createWebhookRelayServer(relay, { mailboxStoreType: "memory" });

  try {
    await startServer(server);
  } catch (err) {
    Object.keys(env).forEach((key) => {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    });
    if (err && err.code === "EPERM") {
      console.log("SKIP: intentos tasks test (listen not permitted)");
      return false;
    }
    throw err;
  }

  const port = server.address().port;
  try {
    await fn(port);
  } finally {
    server.close();
    Object.keys(env).forEach((key) => {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    });
  }

  return true;
}

async function main() {
  const ran = await withServer(
    {
      AIMTP_API_KEY: ADMIN_KEY,
      AIMTP_STORE: "memory",
      INTENTOS: "on",
      INTENTOS_MODE: "log",
      AIMTP_IDENTITY: undefined,
      AIMTP_CAPABILITIES: undefined
    },
    async (port) => {
      const submit = await postJson(
        port,
        "/intentos/intent",
        { goal: "Classify and draft a response" },
        authHeaders(ADMIN_KEY)
      );
      assert.strictEqual(submit.status, 202);
      assert.ok(submit.body.intent_id);

      const createA = await postJson(
        port,
        "/intentos/task",
        {
          intent_id: submit.body.intent_id,
          type: "classify",
          input: { goal: "Classify and draft a response" }
        },
        authHeaders(ADMIN_KEY)
      );
      assert.strictEqual(createA.status, 202);

      const createB = await postJson(
        port,
        "/intentos/task",
        {
          intent_id: submit.body.intent_id,
          type: "draft_reply",
          input: { goal: "Classify and draft a response" }
        },
        authHeaders(ADMIN_KEY)
      );
      assert.strictEqual(createB.status, 202);

      const listAll = await getJson(
        port,
        `/intentos/tasks?intent_id=${encodeURIComponent(submit.body.intent_id)}&limit=10`,
        authHeaders(ADMIN_KEY)
      );
      assert.strictEqual(listAll.status, 200);
      assert.ok(listAll.body);
      assert.ok(Array.isArray(listAll.body.tasks));
      assert.strictEqual(listAll.body.tasks.length, 2);

      const taskTypes = listAll.body.tasks.map((task) => task.type).sort();
      assert.deepStrictEqual(taskTypes, ["classify", "draft_reply"]);

      const filtered = await getJson(
        port,
        `/intentos/tasks?intent_id=${encodeURIComponent(submit.body.intent_id)}&status=queued&limit=1`,
        authHeaders(ADMIN_KEY)
      );
      assert.strictEqual(filtered.status, 200);
      assert.ok(Array.isArray(filtered.body.tasks));
      assert.strictEqual(filtered.body.tasks.length, 1);
    }
  );

  if (!ran) {
    return;
  }

  console.log("OK: intentos tasks tests");
}

main();
