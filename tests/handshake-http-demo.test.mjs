#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const repoRoot = path.resolve(process.cwd());
const toolPath = path.resolve(repoRoot, "tools", "handshake-http-demo.mjs");
const require = createRequire(import.meta.url);
const { WebhookRelay, createWebhookRelayServer } = require("../runtime");

function runHandshakeHttpTool(envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  return spawnSync(process.execPath, [toolPath], {
    cwd: repoRoot,
    env,
    encoding: "utf8"
  });
}

function canonicalizeIdentityAnchor(anchor) {
  return Buffer.from(
    JSON.stringify({
      type: anchor.type,
      protocolVersion: anchor.protocolVersion,
      anchorId: anchor.anchorId,
      peerId: anchor.peerId,
      publicKeyPem: anchor.publicKeyPem,
      timestamp: anchor.timestamp
    }),
    "utf8"
  );
}

function canonicalizeHandshakePeerProofPayload(hello) {
  const capabilitiesOffered = canonicalizeCapabilityList(hello.capabilitiesOffered);
  const capabilitiesRequired = canonicalizeCapabilityList(hello.capabilitiesRequired);
  return Buffer.from(
    JSON.stringify({
      nonce: hello.nonce,
      timestamp: hello.timestamp,
      senderPeerId: hello.senderPeerId,
      senderRelayUrl: hello.senderRelayUrl || "",
      capabilitiesOffered,
      capabilitiesRequired
    }),
    "utf8"
  );
}

function canonicalizeCapabilityList(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return Array.from(
    new Set(
      values
        .filter((value) => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    )
  ).sort();
}

function createSignedInlineAnchor(peerId, suffix = "1") {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const anchor = {
    type: "IdentityAnchor",
    protocolVersion: "0.4",
    anchorId: `anchor-inline-${suffix}`,
    peerId,
    publicKeyPem,
    timestamp: new Date().toISOString()
  };
  const signature = crypto
    .sign(null, canonicalizeIdentityAnchor(anchor), privateKey)
    .toString("base64");
  return {
    anchor: {
      ...anchor,
      alg: "ed25519",
      kid: `${peerId}#key-${suffix}`,
      signature
    },
    privateKey
  };
}

function createPeerProof(hello, privateKey, keyId) {
  return {
    keyId,
    nonce: hello.nonce,
    signature: crypto
      .sign(null, canonicalizeHandshakePeerProofPayload(hello), privateKey)
      .toString("base64")
  };
}

async function captureConsoleLogs(fn) {
  const original = console.log;
  const logs = [];
  console.log = (...args) => {
    logs.push(
      args
        .map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
        .join(" ")
    );
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return logs;
}

function startServer(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener("listening", onListen);
      reject(error);
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

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function withEnv(overrides, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function testDefaultEnvironmentSkipsHandshakeHttpDemo() {
  const result = runHandshakeHttpTool({
    INTENTOS_PROTOCOL_VERSION: "",
    INTENTOS_FEDERATION: "",
    INTENTOS_IDENTITY: ""
  });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stderr}`);
  assert.match(result.stdout, /HANDSHAKE HTTP SKIPPED/);
}

function testInlineAnchorExchangeViaDemo() {
  const result = runHandshakeHttpTool({
    INTENTOS_PROTOCOL_VERSION: "0.4",
    INTENTOS_FEDERATION: "on",
    INTENTOS_IDENTITY: "on",
    INTENTOS_HANDSHAKE_SEND_ANCHORS: "inline"
  });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stderr}`);
  assert.match(result.stdout, /ANCHOR EXCHANGE OK/);
}

function testInlineAnchorExchangeViaDemoEnforcePeerVerify() {
  const result = runHandshakeHttpTool({
    INTENTOS_PROTOCOL_VERSION: "0.4",
    INTENTOS_FEDERATION: "on",
    INTENTOS_IDENTITY: "on",
    INTENTOS_HANDSHAKE_PEER_VERIFY: "enforce",
    INTENTOS_HANDSHAKE_SEND_ANCHORS: "inline"
  });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stderr}`);
  assert.match(result.stdout, /ANCHOR EXCHANGE OK/);
}

function testSetIdAnchorExchangeViaDemo() {
  const result = runHandshakeHttpTool({
    INTENTOS_PROTOCOL_VERSION: "0.4",
    INTENTOS_FEDERATION: "on",
    INTENTOS_IDENTITY: "on",
    INTENTOS_HANDSHAKE_SEND_ANCHORS: "setid"
  });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stderr}`);
  assert.match(result.stdout, /ANCHOR EXCHANGE OK/);
}

function testCapabilityNegotiationViaDemo() {
  const result = runHandshakeHttpTool({
    INTENTOS_PROTOCOL_VERSION: "0.4",
    INTENTOS_FEDERATION: "on",
    INTENTOS_IDENTITY: "on",
    INTENTOS_HANDSHAKE_NEGOTIATION: "on"
  });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stderr}`);
  assert.match(result.stdout, /HANDSHAKE HTTP OK/);
  assert.match(result.stdout, /CAPABILITY NEGOTIATION OK/);
}

async function testEndpointReturns404WhenNotGated() {
  await withEnv(
    {
      INTENTOS_PROTOCOL_VERSION: "",
      INTENTOS_FEDERATION: "",
      INTENTOS_IDENTITY: ""
    },
    async () => {
      const relay = new WebhookRelay();
      const server = createWebhookRelayServer(relay);
      try {
        await startServer(server);
        const address = server.address();
        assert(address && typeof address === "object", "expected server address");
        const hello = {
          type: "HandshakeHello",
          protocolVersion: "0.4",
          helloId: "hello-404",
          senderPeerId: "peer-alpha",
          recipientPeerId: "peer-beta",
          nonce: "nonce-404",
          timestamp: new Date().toISOString()
        };
        const response = await fetch(
          `http://127.0.0.1:${address.port}/aimtp/intentos/federation/handshake`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(hello)
          }
        );
        assert.equal(response.status, 404, `expected 404, got ${response.status}`);
      } finally {
        if (server.listening) {
          await closeServer(server);
        }
      }
    }
  );
}

async function testInvalidInlineSignatureRejects() {
  await withEnv(
    {
      INTENTOS_PROTOCOL_VERSION: "0.4",
      INTENTOS_FEDERATION: "on",
      INTENTOS_IDENTITY: "on"
    },
    async () => {
      const relay = new WebhookRelay();
      const server = createWebhookRelayServer(relay);
      try {
        await startServer(server);
        const address = server.address();
        assert(address && typeof address === "object", "expected server address");
        const hello = {
          type: "HandshakeHello",
          protocolVersion: "0.4",
          helloId: "hello-inline-bad",
          senderPeerId: "peer-alpha",
          recipientPeerId: "peer-beta",
          nonce: "nonce-inline-bad",
          timestamp: new Date().toISOString(),
          identityAnchorsInline: [
            {
              type: "IdentityAnchor",
              protocolVersion: "0.4",
              anchorId: "anchor-inline-bad",
              peerId: "peer-alpha",
              publicKeyPem: "-----BEGIN PUBLIC KEY-----\\ninvalid\\n-----END PUBLIC KEY-----\\n",
              timestamp: new Date().toISOString(),
              alg: "ed25519",
              kid: "peer-alpha#bad",
              signature: "aW52YWxpZA=="
            }
          ]
        };
        const response = await fetch(
          `http://127.0.0.1:${address.port}/aimtp/intentos/federation/handshake`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(hello)
          }
        );
        assert.equal(response.status, 400, `expected 400, got ${response.status}`);
        const body = await response.json();
        assert.equal(body.code, "handshake_identity_anchor_signature_invalid");
        assert.equal(body.details.acceptedIdentityAnchors, false);
      } finally {
        if (server.listening) {
          await closeServer(server);
        }
      }
    }
  );
}

async function testPeerVerifyEnforceRejectsMissingProof() {
  await withEnv(
    {
      INTENTOS_PROTOCOL_VERSION: "0.4",
      INTENTOS_FEDERATION: "on",
      INTENTOS_IDENTITY: "on",
      INTENTOS_HANDSHAKE_PEER_VERIFY: "enforce"
    },
    async () => {
      const relay = new WebhookRelay();
      const server = createWebhookRelayServer(relay);
      try {
        await startServer(server);
        const address = server.address();
        assert(address && typeof address === "object", "expected server address");

        const inline = createSignedInlineAnchor("peer-alpha", "missing-proof");
        const hello = {
          type: "HandshakeHello",
          protocolVersion: "0.4",
          helloId: "hello-peer-proof-missing",
          senderPeerId: "peer-alpha",
          recipientPeerId: "peer-beta",
          nonce: "nonce-peer-proof-missing",
          timestamp: new Date().toISOString(),
          identityAnchorsInline: [inline.anchor]
        };

        const response = await fetch(
          `http://127.0.0.1:${address.port}/aimtp/intentos/federation/handshake`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(hello)
          }
        );
        assert.equal(response.status, 400, `expected 400, got ${response.status}`);
        const body = await response.json();
        assert.equal(body.code, "handshake_peer_proof_missing");
        assert.equal(body.details.acceptedIdentityAnchors, false);
        assert.deepEqual(body.details.errors, ["peerProof is required when anchors are presented"]);
      } finally {
        if (server.listening) {
          await closeServer(server);
        }
      }
    }
  );
}

async function testPeerVerifyEnforceRejectsInvalidSignature() {
  await withEnv(
    {
      INTENTOS_PROTOCOL_VERSION: "0.4",
      INTENTOS_FEDERATION: "on",
      INTENTOS_IDENTITY: "on",
      INTENTOS_HANDSHAKE_PEER_VERIFY: "enforce"
    },
    async () => {
      const relay = new WebhookRelay();
      const server = createWebhookRelayServer(relay);
      try {
        await startServer(server);
        const address = server.address();
        assert(address && typeof address === "object", "expected server address");

        const inline = createSignedInlineAnchor("peer-alpha", "bad-proof");
        const hello = {
          type: "HandshakeHello",
          protocolVersion: "0.4",
          helloId: "hello-peer-proof-invalid",
          senderPeerId: "peer-alpha",
          recipientPeerId: "peer-beta",
          nonce: "nonce-peer-proof-invalid",
          timestamp: new Date().toISOString(),
          identityAnchorsInline: [inline.anchor],
          peerProof: {
            keyId: inline.anchor.anchorId,
            nonce: "nonce-peer-proof-invalid",
            signature: "aW52YWxpZA=="
          }
        };

        const response = await fetch(
          `http://127.0.0.1:${address.port}/aimtp/intentos/federation/handshake`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(hello)
          }
        );
        assert.equal(response.status, 400, `expected 400, got ${response.status}`);
        const body = await response.json();
        assert.equal(body.code, "handshake_peer_proof_invalid");
        assert.equal(body.details.acceptedIdentityAnchors, false);
        assert.deepEqual(body.details.errors, ["peerProof signature verification failed"]);
      } finally {
        if (server.listening) {
          await closeServer(server);
        }
      }
    }
  );
}

async function testPeerVerifyWarnAcceptsAndEmitsWarning() {
  await withEnv(
    {
      INTENTOS_PROTOCOL_VERSION: "0.4",
      INTENTOS_FEDERATION: "on",
      INTENTOS_IDENTITY: "on",
      INTENTOS_HANDSHAKE_PEER_VERIFY: "warn"
    },
    async () => {
      const relay = new WebhookRelay();
      const logs = await captureConsoleLogs(async () => {
        const server = createWebhookRelayServer(relay);
        try {
          await startServer(server);
          const address = server.address();
          assert(address && typeof address === "object", "expected server address");

          const inline = createSignedInlineAnchor("peer-alpha", "warn-proof");
          const hello = {
            type: "HandshakeHello",
            protocolVersion: "0.4",
            helloId: "hello-peer-proof-warn",
            senderPeerId: "peer-alpha",
            recipientPeerId: "peer-beta",
            nonce: "nonce-peer-proof-warn",
            timestamp: new Date().toISOString(),
            identityAnchorsInline: [inline.anchor],
            peerProof: {
              keyId: inline.anchor.anchorId,
              nonce: "nonce-peer-proof-warn",
              signature: "aW52YWxpZA=="
            }
          };

          const response = await fetch(
            `http://127.0.0.1:${address.port}/aimtp/intentos/federation/handshake`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(hello)
            }
          );
          assert.equal(response.status, 200, `expected 200, got ${response.status}`);
          const body = await response.json();
          assert.equal(body.type, "HandshakeAck");
          assert.equal(body.acceptedIdentityAnchors, false);
          assert.equal(body.resolvedAnchorSetId, null);
          assert.deepEqual(body.capabilitiesAccepted, []);
          assert.deepEqual(body.capabilitiesMissing, []);
        } finally {
          if (server.listening) {
            await closeServer(server);
          }
        }
      });
      const warningEvents = logs
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((entry) => entry && entry.event === "handshake_peer_verify_warning");
      assert.equal(warningEvents.length, 1, `expected one warning, got ${warningEvents.length}`);
      assert.equal(warningEvents[0].mode, "warn");
      assert.equal(warningEvents[0].code, "handshake_peer_proof_invalid");
      assert.equal(warningEvents[0].hello_id, "hello-peer-proof-warn");
      assert.equal(warningEvents[0].sender_peer_id, "peer-alpha");
    }
  );
}

async function testNegotiationCanonicalizesCapabilityArrays() {
  await withEnv(
    {
      INTENTOS_PROTOCOL_VERSION: "0.4",
      INTENTOS_FEDERATION: "on",
      INTENTOS_IDENTITY: "on",
      INTENTOS_HANDSHAKE_NEGOTIATION: "on"
    },
    async () => {
      const relay = new WebhookRelay();
      const server = createWebhookRelayServer(relay);
      try {
        await startServer(server);
        const address = server.address();
        assert(address && typeof address === "object", "expected server address");
        const hello = {
          type: "HandshakeHello",
          protocolVersion: "0.4",
          helloId: "hello-negotiation-canonical",
          senderPeerId: "peer-alpha",
          recipientPeerId: "peer-beta",
          nonce: "nonce-negotiation-canonical",
          timestamp: new Date().toISOString(),
          capabilitiesOffered: [
            "identity-anchor-exchange",
            "  federation-handshake-http ",
            "capability-negotiation",
            "identity-anchor-exchange"
          ],
          capabilitiesRequired: [
            "federation-handshake-http",
            "capability-negotiation",
            "federation-handshake-http",
            " "
          ]
        };
        const response = await fetch(
          `http://127.0.0.1:${address.port}/aimtp/intentos/federation/handshake`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(hello)
          }
        );
        assert.equal(response.status, 200, `expected 200, got ${response.status}`);
        const body = await response.json();
        assert.equal(body.type, "HandshakeAck");
        assert.deepEqual(body.capabilitiesAccepted, [
          "capability-negotiation",
          "federation-handshake-http",
          "identity-anchor-exchange"
        ]);
        assert.deepEqual(body.capabilitiesMissing, []);
        assert.deepEqual(body.capabilitiesAccepted, canonicalizeCapabilityList(body.capabilitiesAccepted));
        assert.deepEqual(body.capabilitiesMissing, canonicalizeCapabilityList(body.capabilitiesMissing));
      } finally {
        if (server.listening) {
          await closeServer(server);
        }
      }
    }
  );
}

async function testNegotiationRequiredMissingRejects() {
  await withEnv(
    {
      INTENTOS_PROTOCOL_VERSION: "0.4",
      INTENTOS_FEDERATION: "on",
      INTENTOS_IDENTITY: "on",
      INTENTOS_HANDSHAKE_NEGOTIATION: "on"
    },
    async () => {
      const relay = new WebhookRelay();
      const server = createWebhookRelayServer(relay);
      try {
        await startServer(server);
        const address = server.address();
        assert(address && typeof address === "object", "expected server address");
        const hello = {
          type: "HandshakeHello",
          protocolVersion: "0.4",
          helloId: "hello-negotiation-missing",
          senderPeerId: "peer-alpha",
          recipientPeerId: "peer-beta",
          nonce: "nonce-negotiation-missing",
          timestamp: new Date().toISOString(),
          capabilitiesOffered: [
            "identity-anchor-exchange",
            "  federation-handshake-http ",
            "identity-anchor-exchange"
          ],
          capabilitiesRequired: [
            "missing-capability-b",
            "federation-handshake-http",
            "missing-capability-a",
            "missing-capability-b"
          ]
        };
        const response = await fetch(
          `http://127.0.0.1:${address.port}/aimtp/intentos/federation/handshake`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(hello)
          }
        );
        assert.equal(response.status, 400, `expected 400, got ${response.status}`);
        const body = await response.json();
        assert.equal(body.code, "handshake_capability_required_missing");
        assert.deepEqual(
          canonicalizeCapabilityList(body.details && body.details.capabilitiesAccepted),
          ["federation-handshake-http", "identity-anchor-exchange"]
        );
        assert.deepEqual(
          canonicalizeCapabilityList(body.details && body.details.capabilitiesMissing),
          ["missing-capability-a", "missing-capability-b"]
        );
      } finally {
        if (server.listening) {
          await closeServer(server);
        }
      }
    }
  );
}

async function testNegotiationAcceptedIntersection() {
  await withEnv(
    {
      INTENTOS_PROTOCOL_VERSION: "0.4",
      INTENTOS_FEDERATION: "on",
      INTENTOS_IDENTITY: "on",
      INTENTOS_HANDSHAKE_NEGOTIATION: "on"
    },
    async () => {
      const relay = new WebhookRelay();
      const server = createWebhookRelayServer(relay);
      try {
        await startServer(server);
        const address = server.address();
        assert(address && typeof address === "object", "expected server address");
        const hello = {
          type: "HandshakeHello",
          protocolVersion: "0.4",
          helloId: "hello-negotiation-accepted",
          senderPeerId: "peer-alpha",
          recipientPeerId: "peer-beta",
          nonce: "nonce-negotiation-accepted",
          timestamp: new Date().toISOString(),
          capabilitiesOffered: [
            "identity-anchor-exchange",
            "federation-handshake-http",
            "capability-negotiation",
            "unsupported-demo-capability",
            "identity-anchor-exchange",
            "  federation-handshake-http "
          ],
          capabilitiesRequired: ["federation-handshake-http"]
        };
        const response = await fetch(
          `http://127.0.0.1:${address.port}/aimtp/intentos/federation/handshake`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(hello)
          }
        );
        assert.equal(response.status, 200, `expected 200, got ${response.status}`);
        const body = await response.json();
        assert.equal(body.type, "HandshakeAck");
        assert.deepEqual(body.capabilitiesAccepted, [
          "capability-negotiation",
          "federation-handshake-http",
          "identity-anchor-exchange"
        ]);
        assert.deepEqual(body.capabilitiesMissing, []);
        assert.deepEqual(body.capabilitiesAccepted, canonicalizeCapabilityList(body.capabilitiesAccepted));
        assert.deepEqual(body.capabilitiesMissing, canonicalizeCapabilityList(body.capabilitiesMissing));
      } finally {
        if (server.listening) {
          await closeServer(server);
        }
      }
    }
  );
}

async function main() {
  testDefaultEnvironmentSkipsHandshakeHttpDemo();
  testInlineAnchorExchangeViaDemo();
  testInlineAnchorExchangeViaDemoEnforcePeerVerify();
  testSetIdAnchorExchangeViaDemo();
  testCapabilityNegotiationViaDemo();
  await testEndpointReturns404WhenNotGated();
  await testInvalidInlineSignatureRejects();
  await testPeerVerifyEnforceRejectsMissingProof();
  await testPeerVerifyEnforceRejectsInvalidSignature();
  await testPeerVerifyWarnAcceptsAndEmitsWarning();
  await testNegotiationCanonicalizesCapabilityArrays();
  await testNegotiationRequiredMissingRejects();
  await testNegotiationAcceptedIntersection();
  console.log("OK: handshake HTTP demo tests");
}

main();
