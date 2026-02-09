"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const {
  buildRelayDescriptor,
  loadTrustPolicy,
  resolveDestinationRelayId,
  stableJsonStringify,
  verifyRelayDescriptor
} = require("../runtime/federation");
const { WebhookRelay, createWebhookRelayServer } = require("../runtime");
const { createEnvelope, createMessage } = require("../sdk/js");

const ADMIN_KEY = "federation-admin-key";

function writeJsonFile(name, payload) {
  const filePath = path.join(
    os.tmpdir(),
    `aimtp-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  return filePath;
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

function postJson(port, routePath, payload, headers = {}) {
  const body = JSON.stringify(payload);
  const options = {
    hostname: "127.0.0.1",
    port,
    path: routePath,
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
        const raw = Buffer.concat(chunks).toString("utf8");
        const parsed = raw ? JSON.parse(raw) : null;
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
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

async function withServer(relay, options, fn) {
  const server = createWebhookRelayServer(relay, options);
  try {
    await startServer(server);
  } catch (err) {
    if (err && err.code === "EPERM") {
      console.log("SKIP: federation relay network tests (listen not permitted)");
      return false;
    }
    throw err;
  }
  const address = server.address();
  try {
    await fn(address.port);
  } finally {
    server.close();
  }
  return true;
}

function buildEnvelope(recipient, id) {
  return createEnvelope({
    id,
    sender: "agent-sender",
    recipient,
    intent: "task.request",
    message: createMessage({ role: "user", content: "federation hello" })
  });
}

async function testCanonicalizationAndSigning() {
  const unordered = {
    z: 1,
    a: { d: 4, b: 2 },
    list: [{ y: 1, x: 2 }]
  };
  const reordered = {
    list: [{ x: 2, y: 1 }],
    a: { b: 2, d: 4 },
    z: 1
  };
  assert.strictEqual(stableJsonStringify(unordered), stableJsonStringify(reordered));

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const config = {
    relayId: "relay.alpha.example",
    relayEndpoint: "http://relay.alpha.example",
    relayPublicKey: publicKey.export({ format: "pem", type: "spki" }),
    relayPrivateKey: privateKey.export({ format: "pem", type: "pkcs8" }),
    descriptorTtlSec: 60
  };
  const nowMs = Date.parse("2026-02-06T00:00:00Z");
  const descriptor = buildRelayDescriptor(config, nowMs);
  const trustedEntry = {
    relay_id: "relay.alpha.example",
    endpoint: "http://relay.alpha.example",
    public_key: config.relayPublicKey,
    alg: "ed25519"
  };
  const verified = verifyRelayDescriptor(descriptor, trustedEntry, { nowMs, clockSkewSec: 0 });
  assert.strictEqual(verified.ok, true);

  const badDescriptor = {
    ...descriptor,
    signature: {
      ...descriptor.signature,
      sig: descriptor.signature.sig.slice(0, -2) + "AA"
    }
  };
  const badVerify = verifyRelayDescriptor(badDescriptor, trustedEntry, {
    nowMs,
    clockSkewSec: 0
  });
  assert.strictEqual(badVerify.ok, false);
  assert.strictEqual(badVerify.code, "federation_descriptor_signature_verification_failed");
}

async function testTrustPolicyAndRouting() {
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  const policyPath = writeJsonFile("federation-trust", {
    trusted_relays: [
      {
        relay_id: "relay.partner.example",
        endpoint: "http://relay.partner.example",
        public_key: publicKey.export({ format: "pem", type: "spki" }),
        alg: "ed25519",
        expires_at: "2027-01-01T00:00:00Z"
      },
      {
        relay_id: "relay.expired.example",
        endpoint: "http://relay.expired.example",
        public_key: publicKey.export({ format: "pem", type: "spki" }),
        alg: "ed25519",
        expires_at: "2020-01-01T00:00:00Z"
      }
    ],
    domains: {
      "partner.example": "relay.partner.example"
    }
  });

  const policy = loadTrustPolicy(policyPath, { allowHttpEndpoints: true });
  assert.strictEqual(policy.trustedRelays.size, 2);
  assert.strictEqual(resolveDestinationRelayId("worker:partner.example", policy.domains), "relay.partner.example");
  assert.strictEqual(resolveDestinationRelayId("worker:other.example", policy.domains), "other.example");

  const { publicKey: relayPub, privateKey: relayPriv } = crypto.generateKeyPairSync("ed25519");
  const descriptor = buildRelayDescriptor(
    {
      relayId: "relay.partner.example",
      relayEndpoint: "http://relay.partner.example",
      relayPublicKey: relayPub.export({ format: "pem", type: "spki" }),
      relayPrivateKey: relayPriv.export({ format: "pem", type: "pkcs8" }),
      descriptorTtlSec: 60
    },
    Date.parse("2026-02-06T00:00:00Z")
  );

  const endpointMismatch = verifyRelayDescriptor(
    descriptor,
    {
      relay_id: "relay.partner.example",
      endpoint: "http://not-matching.example",
      public_key: relayPub.export({ format: "pem", type: "spki" }),
      alg: "ed25519"
    },
    { nowMs: Date.parse("2026-02-06T00:00:01Z"), clockSkewSec: 0 }
  );
  assert.strictEqual(endpointMismatch.ok, false);
  assert.strictEqual(endpointMismatch.code, "federation_endpoint_mismatch");

  const expiredTrustResult = verifyRelayDescriptor(
    descriptor,
    {
      relay_id: "relay.partner.example",
      endpoint: "http://relay.partner.example",
      public_key: relayPub.export({ format: "pem", type: "spki" }),
      alg: "ed25519",
      expires_at: "2020-01-01T00:00:00Z"
    },
    { nowMs: Date.parse("2026-02-06T00:00:01Z"), clockSkewSec: 0 }
  );
  assert.strictEqual(expiredTrustResult.ok, false);
  assert.strictEqual(expiredTrustResult.code, "federation_trust_entry_expired");

  fs.rmSync(policyPath, { force: true });
}

async function testInboundFederationRejects() {
  const { publicKey: localPub, privateKey: localPriv } = crypto.generateKeyPairSync("ed25519");
  const { publicKey: remotePub, privateKey: remotePriv } = crypto.generateKeyPairSync("ed25519");

  const trustPath = writeJsonFile("federation-inbound", {
    trusted_relays: [
      {
        relay_id: "relay.remote.example",
        endpoint: "http://relay.remote.example",
        public_key: remotePub.export({ format: "pem", type: "spki" }),
        alg: "ed25519",
        expires_at: "2027-01-01T00:00:00Z"
      }
    ],
    domains: {
      "remote.example": "relay.remote.example"
    }
  });

  const relay = new WebhookRelay({ emitResponses: true });
  relay.registerAgent("worker:local.test", async () => {});

  await withEnv(
    {
      AIMTP_STORE: "memory",
      AIMTP_API_KEY: ADMIN_KEY,
      AIMTP_FEDERATION: "on",
      AIMTP_RELAY_ID: "relay.local.example",
      AIMTP_RELAY_ENDPOINT: "http://relay.local.example",
      AIMTP_RELAY_PUBLIC_KEY: localPub.export({ format: "pem", type: "spki" }),
      AIMTP_RELAY_PRIVATE_KEY: localPriv.export({ format: "pem", type: "pkcs8" }),
      AIMTP_TRUSTED_RELAYS_PATH: trustPath,
      AIMTP_TRUST_POLICY_MODE: "explicit",
      AIMTP_SIGNATURE_POLICY: "off",
      AIMTP_LOCAL_DOMAINS: "local.test"
    },
    async () =>
      withServer(relay, { allowInsecureFederation: true }, async (port) => {
        const baseDescriptor = buildRelayDescriptor(
          {
            relayId: "relay.remote.example",
            relayEndpoint: "http://relay.remote.example",
            relayPublicKey: remotePub.export({ format: "pem", type: "spki" }),
            relayPrivateKey: remotePriv.export({ format: "pem", type: "pkcs8" }),
            descriptorTtlSec: 300
          },
          Date.now()
        );

        const envelope = buildEnvelope("worker:local.test", "env-fed-1");

        const badSig = {
          ...baseDescriptor,
          signature: {
            ...baseDescriptor.signature,
            sig: `${baseDescriptor.signature.sig.slice(0, -2)}AA`
          }
        };
        const badSigRes = await postJson(port, "/federation/envelope", {
          descriptor: badSig,
          envelope
        });
        assert.strictEqual(badSigRes.status, 401);
        assert.strictEqual(
          badSigRes.body.code,
          "federation_descriptor_signature_verification_failed"
        );

        const untrustedDescriptor = buildRelayDescriptor(
          {
            relayId: "relay.unknown.example",
            relayEndpoint: "http://relay.unknown.example",
            relayPublicKey: remotePub.export({ format: "pem", type: "spki" }),
            relayPrivateKey: remotePriv.export({ format: "pem", type: "pkcs8" }),
            descriptorTtlSec: 300
          },
          Date.now()
        );
        const untrustedRes = await postJson(port, "/federation/envelope", {
          descriptor: untrustedDescriptor,
          envelope
        });
        assert.strictEqual(untrustedRes.status, 403);
        assert.strictEqual(untrustedRes.body.code, "federation_untrusted_relay");

        const expiredDescriptor = buildRelayDescriptor(
          {
            relayId: "relay.remote.example",
            relayEndpoint: "http://relay.remote.example",
            relayPublicKey: remotePub.export({ format: "pem", type: "spki" }),
            relayPrivateKey: remotePriv.export({ format: "pem", type: "pkcs8" }),
            descriptorTtlSec: 1
          },
          Date.parse("2020-01-01T00:00:00Z")
        );
        const expiredRes = await postJson(port, "/federation/envelope", {
          descriptor: expiredDescriptor,
          envelope
        });
        assert.strictEqual(expiredRes.status, 401);
        assert.strictEqual(expiredRes.body.code, "federation_descriptor_expired");

        const hopRes = await postJson(
          port,
          "/federation/envelope",
          { descriptor: baseDescriptor, envelope },
          { "x-aimtp-hop": "2" }
        );
        assert.strictEqual(hopRes.status, 403);
        assert.strictEqual(hopRes.body.code, "federation_hop_limit_exceeded");
      })
  );

  fs.rmSync(trustPath, { force: true });
}

async function testOutboundDisabledDoesNotForward() {
  const relay = new WebhookRelay({ emitResponses: true });
  relay.registerAgent("worker:local.test", async () => {});

  const remoteHits = { count: 0 };
  const remoteServer = http.createServer((req, res) => {
    remoteHits.count += 1;
    res.statusCode = 202;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "accepted" }));
  });
  try {
    await startServer(remoteServer);
  } catch (err) {
    if (err && err.code === "EPERM") {
      console.log("SKIP: federation outbound network tests (listen not permitted)");
      return;
    }
    throw err;
  }
  const remoteAddress = remoteServer.address();

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const trustPath = writeJsonFile("federation-outbound-off", {
    trusted_relays: [
      {
        relay_id: "partner.example",
        endpoint: `http://127.0.0.1:${remoteAddress.port}`,
        public_key: publicKey.export({ format: "pem", type: "spki" }),
        alg: "ed25519"
      }
    ],
    domains: {
      "partner.example": "partner.example"
    }
  });

  try {
    await withEnv(
      {
        AIMTP_STORE: "memory",
        AIMTP_API_KEY: ADMIN_KEY,
        AIMTP_FEDERATION: "off",
        AIMTP_RELAY_ID: "relay.local.example",
        AIMTP_RELAY_ENDPOINT: "http://relay.local.example",
        AIMTP_RELAY_PUBLIC_KEY: publicKey.export({ format: "pem", type: "spki" }),
        AIMTP_RELAY_PRIVATE_KEY: privateKey.export({ format: "pem", type: "pkcs8" }),
        AIMTP_TRUSTED_RELAYS_PATH: trustPath,
        AIMTP_SIGNATURE_POLICY: "off"
      },
      async () =>
        withServer(relay, { allowInsecureFederation: true }, async (port) => {
          const envelope = buildEnvelope("worker:partner.example", "env-fed-off-1");
          const res = await postJson(port, "/aimtp", envelope, {
            "x-aimtp-key": ADMIN_KEY
          });
          assert.strictEqual(res.status, 404);
          assert.strictEqual(res.body.code, "unknown_recipient");
        })
    );

    assert.strictEqual(remoteHits.count, 0, "federation-off should not forward");
  } finally {
    fs.rmSync(trustPath, { force: true });
    remoteServer.close();
  }
}

async function main() {
  await testCanonicalizationAndSigning();
  await testTrustPolicyAndRouting();
  await testInboundFederationRejects();
  await testOutboundDisabledDoesNotForward();
  console.log("OK: federation tests");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
