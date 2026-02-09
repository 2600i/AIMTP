"use strict";

const assert = require("assert");
const crypto = require("crypto");
const http = require("http");
const { WebhookRelay, createWebhookRelayServer } = require("../runtime");
const { createProof } = require("../runtime/identity");

const ADMIN_KEY = "intentos-authz-admin";

function authHeaders(key) {
  return {
    "X-AIMTP-KEY": key
  };
}

function keyMaterial() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
  };
}

function makeIdentity(id, keys) {
  return {
    id,
    role: "agent",
    keys: [
      {
        kid: `${id}#k1`,
        alg: "ed25519",
        public_key: keys.publicKey,
        purposes: ["assertion"]
      }
    ],
    issued_at: "2025-01-01T00:00:00Z",
    expires_at: "2030-01-01T00:00:00Z"
  };
}

function makeCapabilityDoc(params, privateKey) {
  const doc = {
    id: params.id,
    type: "aimtp.capability",
    issuer: params.identity.id,
    subject: params.identity.id,
    scopes: [
      {
        action: params.action,
        resource: params.resource
      }
    ],
    issued_at: "2025-01-01T00:00:00Z",
    expires_at: "2030-01-01T00:00:00Z"
  };
  doc.proof = createProof(doc, privateKey, {
    kid: params.identity.keys[0].kid,
    createdAt: "2026-02-09T00:00:00Z",
    expiresAt: "2028-02-09T00:00:00Z"
  });
  return doc;
}

function buildAuthEnvelope(params) {
  const envelope = {
    id: params.id,
    intent: params.intent,
    identity: params.identity,
    capabilities: {
      chain: [params.capabilityDoc],
      identities: {
        [params.identity.id]: params.identity
      }
    }
  };
  envelope.proof = createProof(envelope, params.privateKey, {
    kid: params.identity.keys[0].kid,
    createdAt: "2026-02-09T00:00:00Z",
    expiresAt: "2028-02-09T00:00:00Z"
  });
  return envelope;
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
      console.log("SKIP: intentos authz test (listen not permitted)");
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

async function testLogModeAcceptsMissingIdentityAndCapabilities() {
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
      const response = await postJson(
        port,
        "/intentos/intent",
        { goal: "Draft support response" },
        authHeaders(ADMIN_KEY)
      );
      assert.strictEqual(response.status, 202);
      assert.ok(response.body.intent_id);
      assert.strictEqual(response.body.status, "submitted");
    }
  );

  return ran;
}

async function testEnforceModeRequiresValidIdentityAndCapabilities() {
  const keys = keyMaterial();
  const identity = makeIdentity("did:aimtp:agent.test", keys);

  const ran = await withServer(
    {
      AIMTP_API_KEY: ADMIN_KEY,
      AIMTP_STORE: "memory",
      INTENTOS: "on",
      INTENTOS_MODE: "enforce",
      AIMTP_IDENTITY: undefined,
      AIMTP_CAPABILITIES: undefined
    },
    async (port) => {
      const missing = await postJson(
        port,
        "/intentos/intent",
        { goal: "Draft support response" },
        authHeaders(ADMIN_KEY)
      );
      assert.strictEqual(missing.status, 401);
      assert.strictEqual(missing.body.code, "unauthorized");
      assert.strictEqual(missing.body.reason_code, "identity_required");

      const badCapabilityDoc = makeCapabilityDoc(
        {
          id: "cap:bad-submit",
          identity,
          action: "task.claim",
          resource: "task:task-x"
        },
        keys.privateKey
      );
      const badEnvelope = buildAuthEnvelope({
        id: "env-bad-submit",
        intent: "intent.submit",
        identity,
        capabilityDoc: badCapabilityDoc,
        privateKey: keys.privateKey
      });

      const badCapabilityResponse = await postJson(
        port,
        "/intentos/intent",
        {
          goal: "Draft support response",
          envelope: badEnvelope
        },
        authHeaders(ADMIN_KEY)
      );
      assert.strictEqual(badCapabilityResponse.status, 403);
      assert.strictEqual(badCapabilityResponse.body.code, "unauthorized");
      assert.strictEqual(badCapabilityResponse.body.reason_code, "capability_scope_mismatch");

      const submitCapabilityDoc = makeCapabilityDoc(
        {
          id: "cap:submit",
          identity,
          action: "intent.submit",
          resource: "intentbox:default"
        },
        keys.privateKey
      );
      const submitEnvelope = buildAuthEnvelope({
        id: "env-good-submit",
        intent: "intent.submit",
        identity,
        capabilityDoc: submitCapabilityDoc,
        privateKey: keys.privateKey
      });

      const validSubmit = await postJson(
        port,
        "/intentos/intent",
        {
          goal: "Draft support response",
          envelope: submitEnvelope
        },
        authHeaders(ADMIN_KEY)
      );
      assert.strictEqual(validSubmit.status, 202);
      assert.ok(validSubmit.body.intent_id);

      const taskCreate = await postJson(
        port,
        "/intentos/task",
        {
          intent_id: validSubmit.body.intent_id,
          type: "classify",
          input: { goal: "Draft support response" }
        },
        authHeaders(ADMIN_KEY)
      );
      assert.strictEqual(taskCreate.status, 202);
      const taskId = taskCreate.body.task_id;
      assert.ok(taskId);

      const claimMissing = await postJson(
        port,
        `/intentos/task/${encodeURIComponent(taskId)}/claim`,
        { agent_id: identity.id },
        authHeaders(ADMIN_KEY)
      );
      assert.strictEqual(claimMissing.status, 401);
      assert.strictEqual(claimMissing.body.reason_code, "identity_required");

      const claimCapabilityDoc = makeCapabilityDoc(
        {
          id: "cap:claim",
          identity,
          action: "task.claim",
          resource: `task:${taskId}`
        },
        keys.privateKey
      );
      const claimEnvelope = buildAuthEnvelope({
        id: "env-good-claim",
        intent: "task.claim",
        identity,
        capabilityDoc: claimCapabilityDoc,
        privateKey: keys.privateKey
      });

      const claimGood = await postJson(
        port,
        `/intentos/task/${encodeURIComponent(taskId)}/claim`,
        {
          agent_id: identity.id,
          envelope: claimEnvelope
        },
        authHeaders(ADMIN_KEY)
      );
      assert.strictEqual(claimGood.status, 200);
      assert.strictEqual(claimGood.body.status, "claimed");

      const resultBadCapabilityDoc = makeCapabilityDoc(
        {
          id: "cap:bad-result",
          identity,
          action: "task.claim",
          resource: `task:${taskId}`
        },
        keys.privateKey
      );
      const resultBadEnvelope = buildAuthEnvelope({
        id: "env-bad-result",
        intent: "task.result",
        identity,
        capabilityDoc: resultBadCapabilityDoc,
        privateKey: keys.privateKey
      });

      const resultBad = await postJson(
        port,
        `/intentos/task/${encodeURIComponent(taskId)}/result`,
        {
          agent_id: identity.id,
          output: { category: "analysis" },
          envelope: resultBadEnvelope
        },
        authHeaders(ADMIN_KEY)
      );
      assert.strictEqual(resultBad.status, 403);
      assert.strictEqual(resultBad.body.reason_code, "capability_scope_mismatch");

      const listMissing = await getJson(
        port,
        "/intentos/tasks?limit=10",
        authHeaders(ADMIN_KEY)
      );
      assert.strictEqual(listMissing.status, 401);
      assert.strictEqual(listMissing.body.code, "unauthorized");
      assert.strictEqual(listMissing.body.reason_code, "identity_required");

      const listCapabilityDoc = makeCapabilityDoc(
        {
          id: "cap:list",
          identity,
          action: "task.list",
          resource: "taskbox:default"
        },
        keys.privateKey
      );
      const listEnvelope = buildAuthEnvelope({
        id: "env-good-list",
        intent: "task.list",
        identity,
        capabilityDoc: listCapabilityDoc,
        privateKey: keys.privateKey
      });
      const listAllowed = await getJson(
        port,
        `/intentos/tasks?limit=10&auth=${encodeURIComponent(JSON.stringify({ envelope: listEnvelope }))}`,
        authHeaders(ADMIN_KEY)
      );
      assert.strictEqual(listAllowed.status, 200);
      assert.ok(Array.isArray(listAllowed.body.tasks));
    }
  );

  return ran;
}

async function main() {
  const ranLog = await testLogModeAcceptsMissingIdentityAndCapabilities();
  if (!ranLog) {
    return;
  }

  const ranEnforce = await testEnforceModeRequiresValidIdentityAndCapabilities();
  if (!ranEnforce) {
    return;
  }

  console.log("OK: intentos authz tests");
}

main();
