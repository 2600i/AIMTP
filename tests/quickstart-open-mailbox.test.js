"use strict";

// Regression guard for the documented Quick Start in README.md.
//
// A relay started with nothing but AIMTP_API_KEY (no AIMTP_ALLOWED_RECIPIENTS,
// no registered in-process handlers) must accept envelopes for any well-formed
// recipient. Before this was fixed, POST /aimtp fell through to a registry
// lookup that only ever contained the hardcoded "aimtp-relay" agent, so every
// recipient in the docs returned 404 unknown_recipient and the published
// Quick Start could not be followed.

const assert = require("assert");
const http = require("http");
const { WebhookRelay, createWebhookRelayServer } = require("../runtime");
const { createEnvelope, createMessage } = require("../sdk/js");

const ADMIN_KEY = "quickstart-key";

function authHeaders(key) {
  return { "X-AIMTP-KEY": key };
}

function request(port, method, path, payload, headers = {}) {
  const body = payload === undefined ? null : JSON.stringify(payload);
  const options = {
    hostname: "127.0.0.1",
    port,
    path,
    method,
    headers: Object.assign(
      body === null
        ? {}
        : {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body)
          },
      headers
    )
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
    if (body !== null) {
      req.write(body);
    }
    req.end();
  });
}

const postJson = (port, path, payload, headers) =>
  request(port, "POST", path, payload, headers);
const getJson = (port, path, headers) => request(port, "GET", path, undefined, headers);

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

async function withServer(fn) {
  const server = createWebhookRelayServer(new WebhookRelay({ emitResponses: true }), {});
  try {
    await startServer(server);
  } catch (err) {
    if (err && err.code === "EPERM") {
      console.log("SKIP: quickstart open mailbox test (listen not permitted)");
      return false;
    }
    throw err;
  }
  const { port } = server.address();
  try {
    await fn(port);
  } finally {
    server.close();
  }
  return true;
}

function quickstartEnvelope(recipient, id) {
  return createEnvelope({
    id,
    sender: "agent-a",
    recipient,
    message: createMessage({ role: "user", content: "ping" })
  });
}

// Baseline env: exactly what the README Quick Start tells an operator to set.
const QUICKSTART_ENV = {
  AIMTP_RELAY_PATH: undefined,
  AIMTP_HEALTH_PATH: undefined,
  AIMTP_READY_PATH: undefined,
  AIMTP_RECIPIENT_KEYS: undefined,
  AIMTP_CORS_ORIGINS: undefined,
  AIMTP_ALLOWED_RECIPIENTS: undefined,
  AIMTP_ALLOWED_SENDERS: undefined,
  AIMTP_API_KEY: ADMIN_KEY,
  AIMTP_STORE: "memory"
};

async function testOpenMailboxAcceptsDocumentedRecipient() {
  return withEnv(QUICKSTART_ENV, () =>
    withServer(async (port) => {
      // The exact recipient used in the README examples.
      const accepted = await postJson(
        port,
        "/aimtp",
        quickstartEnvelope("agent-b", "env-quickstart-1"),
        authHeaders(ADMIN_KEY)
      );
      assert.strictEqual(accepted.status, 202, "envelope POST must be accepted");
      assert.strictEqual(accepted.body.status, "accepted");
      assert.strictEqual(accepted.body.recipient, "agent-b");
      assert.strictEqual(accepted.body.queued, true);

      // Full documented lifecycle: peek -> poll -> ack.
      const peek = await getJson(port, "/aimtp/peek?recipient=agent-b", authHeaders(ADMIN_KEY));
      assert.strictEqual(peek.status, 200);
      assert.strictEqual(peek.body.count, 1);

      const poll = await getJson(
        port,
        "/aimtp/poll?recipient=agent-b&max=1",
        authHeaders(ADMIN_KEY)
      );
      assert.strictEqual(poll.status, 200);
      assert.strictEqual(poll.body.length, 1);
      assert.strictEqual(poll.body[0].envelope.id, "env-quickstart-1");

      const ack = await postJson(
        port,
        "/aimtp/ack",
        { recipient: "agent-b", lease_id: poll.body[0].lease_id },
        authHeaders(ADMIN_KEY)
      );
      assert.strictEqual(ack.status, 200);

      const drained = await getJson(
        port,
        "/aimtp/peek?recipient=agent-b",
        authHeaders(ADMIN_KEY)
      );
      assert.strictEqual(drained.body.count, 0, "queue must be empty after ack");
    })
  );
}

async function testOpenMailboxRejectsMalformedRecipient() {
  return withEnv(QUICKSTART_ENV, () =>
    withServer(async (port) => {
      const bad = await postJson(
        port,
        "/aimtp",
        quickstartEnvelope("not a valid recipient!", "env-quickstart-bad"),
        authHeaders(ADMIN_KEY)
      );
      assert.strictEqual(bad.status, 400, "malformed recipient must be rejected");
      assert.strictEqual(bad.body.code, "invalid_request");
    })
  );
}

async function testAllowlistStillEnforced() {
  // Open mode must not weaken the explicit allowlist.
  return withEnv(
    Object.assign({}, QUICKSTART_ENV, { AIMTP_ALLOWED_RECIPIENTS: "agent-b" }),
    () =>
      withServer(async (port) => {
        const allowed = await postJson(
          port,
          "/aimtp",
          quickstartEnvelope("agent-b", "env-allow-1"),
          authHeaders(ADMIN_KEY)
        );
        assert.strictEqual(allowed.status, 202);

        const denied = await postJson(
          port,
          "/aimtp",
          quickstartEnvelope("agent-x", "env-allow-2"),
          authHeaders(ADMIN_KEY)
        );
        assert.strictEqual(denied.status, 404, "allowlist must still reject unknown recipients");
        assert.strictEqual(denied.body.code, "unknown_recipient");
      })
  );
}

async function testAuthStillRequired() {
  return withEnv(QUICKSTART_ENV, () =>
    withServer(async (port) => {
      const noKey = await postJson(port, "/aimtp", quickstartEnvelope("agent-b", "env-noauth"));
      assert.strictEqual(noKey.status, 401, "open mode must not bypass auth");
    })
  );
}

async function main() {
  const ran = await testOpenMailboxAcceptsDocumentedRecipient();
  if (!ran) {
    return;
  }
  await testOpenMailboxRejectsMalformedRecipient();
  await testAllowlistStillEnforced();
  await testAuthStillRequired();
  console.log("OK: quickstart open mailbox tests");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
