"use strict";

const assert = require("assert");
const http = require("http");
const packageJson = require("../package.json");
const { WebhookRelay, createWebhookRelayServer, Mailbox } = require("../runtime");
const { createEnvelope, createMessage, createTaskRequest } = require("../sdk/js");

const ADMIN_KEY = "super-secret";

function authHeaders(key) {
  return { "X-AIMTP-KEY": key };
}

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
          resolve({ status: res.statusCode, body: null, headers: res.headers });
          return;
        }
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw), headers: res.headers });
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
          resolve({ status: res.statusCode, body: null, headers: res.headers });
          return;
        }
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw), headers: res.headers });
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

function optionsRequest(port, path, headers = {}) {
  const options = {
    hostname: "127.0.0.1",
    port,
    path,
    method: "OPTIONS",
    headers
  };

  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        let body = null;
        if (raw) {
          try {
            body = JSON.parse(raw);
          } catch (_err) {
            body = { raw };
          }
        }
        resolve({ status: res.statusCode, body, headers: res.headers });
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

function buildRequestEnvelope(recipient, idSuffix = "001") {
  const taskId = `task-${idSuffix}`;
  const task = createTaskRequest({
    id: taskId,
    type: "demo",
    input: { payload: "ping" },
    expects_response: true
  });

  return createEnvelope({
    id: `env-${idSuffix}`,
    sender: "agent-a",
    recipient,
    intent: "task.request",
    message: createMessage({
      role: "user",
      content: `Run the demo task ${idSuffix}.`
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
      AIMTP_API_KEY: ADMIN_KEY,
      AIMTP_RECIPIENT_KEYS: undefined,
      AIMTP_CORS_ORIGINS: undefined,
      AIMTP_ALLOWED_RECIPIENTS: "agent-b",
      AIMTP_ALLOWED_SENDERS: "agent-a"
    },
    async () =>
      withServer(new WebhookRelay({ emitResponses: true }), {}, async (port) => {
        const health = await getJson(port, "/healthz");
        assert.strictEqual(health.status, 200);
        assert.strictEqual(health.body.status, "ok");
        assert.strictEqual(health.body.service, "aimtp-relay");
        assert.strictEqual(health.body.version, packageJson.version);

        const ready = await getJson(port, "/readyz");
        assert.strictEqual(ready.status, 200);

        const requestEnvelope = buildRequestEnvelope("agent-b", "001");

        const preflight = await optionsRequest(port, "/aimtp", {
          Origin: "http://localhost:8080"
        });
        assert.strictEqual(preflight.status, 204);
        assert.strictEqual(
          preflight.headers["access-control-allow-origin"],
          "http://localhost:8080"
        );
        assert.strictEqual(
          preflight.headers["access-control-allow-methods"],
          "GET,POST,OPTIONS"
        );
        assert.strictEqual(
          preflight.headers["access-control-allow-headers"],
          "Authorization,Content-Type,X-AIMTP-KEY"
        );

        const peekPreflight = await optionsRequest(port, "/aimtp/peek?recipient=agent-b", {
          Origin: "http://localhost:8080"
        });
        assert.strictEqual(peekPreflight.status, 204);
        assert.strictEqual(
          peekPreflight.headers["access-control-allow-origin"],
          "http://localhost:8080"
        );

        const blockedPreflight = await optionsRequest(port, "/aimtp", {
          Origin: "http://evil.example"
        });
        assert.strictEqual(blockedPreflight.status, 403);
        assert.strictEqual(blockedPreflight.headers["access-control-allow-origin"], undefined);

        const missingAuth = await postJson(port, "/aimtp", requestEnvelope);
        assert.strictEqual(missingAuth.status, 401);

        const invalidAuth = await postJson(port, "/aimtp", requestEnvelope, authHeaders("bad"));
        assert.strictEqual(invalidAuth.status, 403);

        const ok = await postJson(
          port,
          "/aimtp",
          requestEnvelope,
          Object.assign({}, authHeaders(ADMIN_KEY), {
            Origin: "http://localhost:8080"
          })
        );
        assert.strictEqual(ok.status, 202);
        assert.strictEqual(ok.body.status, "accepted");
        assert.strictEqual(ok.body.id, requestEnvelope.id);
        assert.strictEqual(ok.body.recipient, "agent-b");
        assert.strictEqual(ok.body.queued, true);
        assert.strictEqual(ok.body.queue_depth, 1);
        assert.strictEqual(ok.headers["access-control-allow-origin"], "http://localhost:8080");

        const secondEnvelope = buildRequestEnvelope("agent-b", "002");
        const ok2 = await postJson(port, "/aimtp", secondEnvelope, authHeaders(ADMIN_KEY));
        assert.strictEqual(ok2.status, 202);
        assert.strictEqual(ok2.body.queue_depth, 2);

        const badEnvelope = { ...requestEnvelope, spec: "aimtp/0.0" };
        const bad = await postJson(port, "/aimtp", badEnvelope, authHeaders(ADMIN_KEY));
        assert.strictEqual(bad.status, 400);
        assert.strictEqual(bad.body.code, "invalid_schema");

        const missingPeek = await getJson(port, "/aimtp/peek?recipient=agent-b");
        assert.strictEqual(missingPeek.status, 401);

        const invalidPeek = await getJson(
          port,
          "/aimtp/peek?recipient=agent-b",
          authHeaders("bad")
        );
        assert.strictEqual(invalidPeek.status, 403);

        const peek = await getJson(
          port,
          "/aimtp/peek?recipient=agent-b",
          Object.assign({}, authHeaders(ADMIN_KEY), {
            Origin: "http://localhost:8080"
          })
        );
        assert.strictEqual(peek.status, 200);
        assert.strictEqual(peek.body.count, 2);
        assert.strictEqual(peek.headers["access-control-allow-origin"], "http://localhost:8080");

        const peekDisallowedOrigin = await getJson(
          port,
          "/aimtp/peek?recipient=agent-b",
          Object.assign({}, authHeaders(ADMIN_KEY), {
            Origin: "http://evil.example"
          })
        );
        assert.strictEqual(peekDisallowedOrigin.status, 200);
        assert.strictEqual(
          peekDisallowedOrigin.headers["access-control-allow-origin"],
          undefined
        );

        const poll = await getJson(
          port,
          "/aimtp/poll?recipient=agent-b&max=1",
          authHeaders(ADMIN_KEY)
        );
        assert.strictEqual(poll.status, 200);
        assert.ok(Array.isArray(poll.body), "expected poll response array");
        assert.strictEqual(poll.body.length, 1);
        assert.strictEqual(poll.body[0].id, requestEnvelope.id);

        const poll2 = await getJson(
          port,
          "/aimtp/poll?recipient=agent-b&max=10",
          authHeaders(ADMIN_KEY)
        );
        assert.strictEqual(poll2.status, 200);
        assert.strictEqual(poll2.body.length, 1);
        assert.strictEqual(poll2.body[0].id, secondEnvelope.id);

        const emptyPoll = await getJson(
          port,
          "/aimtp/poll?recipient=agent-b&max=1",
          authHeaders(ADMIN_KEY)
        );
        assert.strictEqual(emptyPoll.status, 200);
        assert.deepStrictEqual(emptyPoll.body, []);

        const peekEmpty = await getJson(
          port,
          "/aimtp/peek?recipient=agent-b",
          authHeaders(ADMIN_KEY)
        );
        assert.strictEqual(peekEmpty.status, 200);
        assert.strictEqual(peekEmpty.body.count, 0);

        const unknownPeek = await getJson(
          port,
          "/aimtp/peek?recipient=agent-x",
          authHeaders(ADMIN_KEY)
        );
        assert.strictEqual(unknownPeek.status, 404);
        assert.strictEqual(unknownPeek.body.code, "unknown_recipient");

        const unknownPost = await postJson(
          port,
          "/aimtp",
          buildRequestEnvelope("agent-x", "unknown"),
          authHeaders(ADMIN_KEY)
        );
        assert.strictEqual(unknownPost.status, 404);
        assert.strictEqual(unknownPost.body.code, "unknown_recipient");
      })
  );

  if (!ranDefault) {
    return;
  }

  await withEnv(
    {
      AIMTP_RELAY_PATH: "/custom",
      AIMTP_HEALTH_PATH: undefined,
      AIMTP_READY_PATH: undefined,
      AIMTP_API_KEY: ADMIN_KEY,
      AIMTP_RECIPIENT_KEYS: undefined,
      AIMTP_CORS_ORIGINS: undefined,
      AIMTP_ALLOWED_RECIPIENTS: "agent-b",
      AIMTP_ALLOWED_SENDERS: "agent-a"
    },
    async () =>
      withServer(new WebhookRelay({ emitResponses: true }), {}, async (port) => {
        const requestEnvelope = buildRequestEnvelope("agent-b", "custom");
        const ok = await postJson(port, "/custom", requestEnvelope, authHeaders(ADMIN_KEY));
        assert.strictEqual(ok.status, 202);
      })
  );

  await withEnv(
    {
      AIMTP_RELAY_PATH: undefined,
      AIMTP_MAX_BODY_BYTES: "64",
      AIMTP_HEALTH_PATH: undefined,
      AIMTP_READY_PATH: undefined,
      AIMTP_API_KEY: ADMIN_KEY,
      AIMTP_RECIPIENT_KEYS: undefined,
      AIMTP_CORS_ORIGINS: undefined,
      AIMTP_ALLOWED_RECIPIENTS: "agent-b",
      AIMTP_ALLOWED_SENDERS: "agent-a"
    },
    async () =>
      withServer(new WebhookRelay({ emitResponses: true }), {}, async (port) => {
        const tooLarge = { data: "x".repeat(1024) };
        const res = await postJson(port, "/aimtp", tooLarge, authHeaders(ADMIN_KEY));
        assert.strictEqual(res.status, 413);
        assert.strictEqual(res.body.code, "payload_too_large");
      })
  );

  await withEnv(
    {
      AIMTP_RELAY_PATH: undefined,
      AIMTP_HEALTH_PATH: undefined,
      AIMTP_READY_PATH: undefined,
      AIMTP_API_KEY: ADMIN_KEY,
      AIMTP_RECIPIENT_KEYS: undefined,
      AIMTP_CORS_ORIGINS: undefined,
      AIMTP_ALLOWED_RECIPIENTS: "agent-b",
      AIMTP_ALLOWED_SENDERS: "agent-a"
    },
    async () => {
      let now = Date.now();
      const mailbox = new Mailbox({ now: () => now });
      return withServer(
        new WebhookRelay({ emitResponses: true }),
        { mailbox },
        async (port) => {
          const requestEnvelope = buildRequestEnvelope("agent-b", "ttl");
          const ok = await postJson(port, "/aimtp", requestEnvelope, authHeaders(ADMIN_KEY));
          assert.strictEqual(ok.status, 202);
          now += 10 * 60 * 1000 + 1;
          const peek = await getJson(
            port,
            "/aimtp/peek?recipient=agent-b",
            authHeaders(ADMIN_KEY)
          );
          assert.strictEqual(peek.status, 200);
          assert.strictEqual(peek.body.count, 0);
          const poll = await getJson(
            port,
            "/aimtp/poll?recipient=agent-b&max=1",
            authHeaders(ADMIN_KEY)
          );
          assert.strictEqual(poll.status, 200);
          assert.deepStrictEqual(poll.body, []);
        }
      );
    }
  );

  await withEnv(
    {
      AIMTP_RELAY_PATH: undefined,
      AIMTP_HEALTH_PATH: undefined,
      AIMTP_READY_PATH: undefined,
      AIMTP_API_KEY: ADMIN_KEY,
      AIMTP_RECIPIENT_KEYS: undefined,
      AIMTP_CORS_ORIGINS: undefined,
      AIMTP_ALLOWED_RECIPIENTS: "agent-b",
      AIMTP_ALLOWED_SENDERS: "agent-a"
    },
    async () =>
      withServer(new WebhookRelay({ emitResponses: true }), {}, async (port) => {
        for (let i = 0; i < 101; i += 1) {
          const envelope = buildRequestEnvelope("agent-b", String(i).padStart(3, "0"));
          const res = await postJson(port, "/aimtp", envelope, authHeaders(ADMIN_KEY));
          assert.strictEqual(res.status, 202);
          if (i === 100) {
            assert.strictEqual(res.body.queue_depth, 100);
          }
        }

        const poll = await getJson(
          port,
          "/aimtp/poll?recipient=agent-b&max=1",
          authHeaders(ADMIN_KEY)
        );
        assert.strictEqual(poll.status, 200);
        assert.strictEqual(poll.body.length, 1);
        assert.strictEqual(poll.body[0].id, "env-001");
      })
  );

  await withEnv(
    {
      AIMTP_RELAY_PATH: undefined,
      AIMTP_HEALTH_PATH: undefined,
      AIMTP_READY_PATH: undefined,
      AIMTP_API_KEY: undefined,
      AIMTP_RECIPIENT_KEYS: "agent-a:key-a,agent-b:key-b",
      AIMTP_CORS_ORIGINS: undefined,
      AIMTP_ALLOWED_RECIPIENTS: "agent-a,agent-b",
      AIMTP_ALLOWED_SENDERS: "agent-a"
    },
    async () =>
      withServer(new WebhookRelay({ emitResponses: true }), {}, async (port) => {
        const envelopeA = buildRequestEnvelope("agent-a", "iso");
        const ok = await postJson(port, "/aimtp", envelopeA, authHeaders("key-a"));
        assert.strictEqual(ok.status, 202);

        const blockedPost = await postJson(
          port,
          "/aimtp",
          buildRequestEnvelope("agent-b", "iso-block"),
          authHeaders("key-a")
        );
        assert.strictEqual(blockedPost.status, 403);

        const blockedPoll = await getJson(
          port,
          "/aimtp/poll?recipient=agent-b&max=1",
          authHeaders("key-a")
        );
        assert.strictEqual(blockedPoll.status, 403);

        const allowedPoll = await getJson(
          port,
          "/aimtp/poll?recipient=agent-a&max=1",
          authHeaders("key-a")
        );
        assert.strictEqual(allowedPoll.status, 200);
        assert.strictEqual(allowedPoll.body.length, 1);
        assert.strictEqual(allowedPoll.body[0].id, envelopeA.id);
      })
  );

  console.log("OK: runtime relay test");
}

main();
