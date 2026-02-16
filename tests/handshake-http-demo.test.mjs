#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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

function createRevocationSetFile(entries) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimtp-handshake-http-revocation-"));
  const filePath = path.join(tempDir, "revocations.json");
  const payload = {
    type: "revocations",
    specVersion: "0.4",
    issuer: "relay://tests",
    issuedAt: Math.floor(Date.now() / 1000),
    revocations: entries
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { tempDir, filePath };
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

function testRevocationEnforceViaDemo() {
  const result = runHandshakeHttpTool({
    INTENTOS_PROTOCOL_VERSION: "0.4",
    INTENTOS_FEDERATION: "on",
    INTENTOS_IDENTITY: "on",
    INTENTOS_REVOCATION_POLICY: "enforce",
    INTENTOS_HANDSHAKE_REVOCATION_CASE: "peer"
  });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stderr}`);
  assert.match(result.stdout, /REVOCATION ENFORCE REJECT OK/);
}

function testRevocationWarnViaDemo() {
  const result = runHandshakeHttpTool({
    INTENTOS_PROTOCOL_VERSION: "0.4",
    INTENTOS_FEDERATION: "on",
    INTENTOS_IDENTITY: "on",
    INTENTOS_REVOCATION_POLICY: "warn",
    INTENTOS_HANDSHAKE_REVOCATION_CASE: "peer"
  });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stderr}`);
  assert.match(result.stdout, /REVOCATION WARN ALLOW OK/);
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

function hasErrorWithFragment(body, fragment) {
  const errors = body && body.details && Array.isArray(body.details.errors) ? body.details.errors : [];
  return errors.some((entry) => typeof entry === "string" && entry.includes(fragment));
}

async function testSchemaMissingRequiredFieldRejects() {
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
          helloId: "hello-schema-missing-required",
          senderPeerId: "peer-alpha",
          recipientPeerId: "peer-beta",
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
        assert.equal(response.status, 400, `expected 400, got ${response.status}`);
        const body = await response.json();
        assert.equal(body.code, "invalid_schema");
        assert.equal(hasErrorWithFragment(body, "required property"), true);
        assert.equal(hasErrorWithFragment(body, "nonce"), true);
      } finally {
        if (server.listening) {
          await closeServer(server);
        }
      }
    }
  );
}

async function testSchemaWrongCapabilitiesTypeRejectsWhenNegotiationOn() {
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
          helloId: "hello-schema-capability-type",
          senderPeerId: "peer-alpha",
          recipientPeerId: "peer-beta",
          nonce: "nonce-schema-capability-type",
          timestamp: new Date().toISOString(),
          capabilitiesOffered: { invalid: true },
          capabilitiesRequired: "federation-handshake-http"
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
        assert.equal(body.code, "invalid_schema");
        assert.equal(hasErrorWithFragment(body, "capabilitiesOffered"), true);
        assert.equal(hasErrorWithFragment(body, "capabilitiesRequired"), true);
      } finally {
        if (server.listening) {
          await closeServer(server);
        }
      }
    }
  );
}

async function testSchemaUnknownFieldHandlingIsConsistent() {
  const runOne = async (negotiationMode, helloId, nonce) => {
    await withEnv(
      {
        INTENTOS_PROTOCOL_VERSION: "0.4",
        INTENTOS_FEDERATION: "on",
        INTENTOS_IDENTITY: "on",
        INTENTOS_HANDSHAKE_NEGOTIATION: negotiationMode
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
            helloId,
            senderPeerId: "peer-alpha",
            recipientPeerId: "peer-beta",
            nonce,
            timestamp: new Date().toISOString(),
            unknownField: "not-allowed"
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
          assert.equal(body.code, "invalid_schema");
          assert.equal(hasErrorWithFragment(body, "must NOT have additional properties"), true);
        } finally {
          if (server.listening) {
            await closeServer(server);
          }
        }
      }
    );
  };

  await runOne("off", "hello-schema-unknown-off", "nonce-schema-unknown-off");
  await runOne("on", "hello-schema-unknown-on", "nonce-schema-unknown-on");
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

async function testPeerVerifyEnforceRejectsMismatchedKeyIdReference() {
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

        const inline = createSignedInlineAnchor("peer-alpha", "mismatch-key-id");
        const hello = {
          type: "HandshakeHello",
          protocolVersion: "0.4",
          helloId: "hello-peer-proof-keyid-mismatch",
          senderPeerId: "peer-alpha",
          recipientPeerId: "peer-beta",
          nonce: "nonce-peer-proof-keyid-mismatch",
          timestamp: new Date().toISOString(),
          identityAnchorsInline: [inline.anchor]
        };
        hello.peerProof = createPeerProof(hello, inline.privateKey, "anchor-id-not-presented");

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
        assert.equal(body.code, "handshake_peer_proof_key_unknown");
        assert.equal(body.details.acceptedIdentityAnchors, false);
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

async function testRevocationsOffLeavesHandshakeBehaviorUnchanged() {
  const revocations = createRevocationSetFile([
    {
      subject: "peer-alpha",
      kind: "peer",
      revokedAt: Math.floor(Date.now() / 1000),
      reason: "test_revocation_off"
    }
  ]);
  await withEnv(
    {
      INTENTOS_PROTOCOL_VERSION: "0.4",
      INTENTOS_FEDERATION: "on",
      INTENTOS_IDENTITY: "on",
      INTENTOS_REVOCATIONS: "off",
      INTENTOS_REVOCATION_POLICY: "enforce",
      INTENTOS_TRUST_DISTRIBUTION: "fs",
      INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH: revocations.filePath
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
          helloId: "hello-revocation-off",
          senderPeerId: "peer-alpha",
          recipientPeerId: "peer-beta",
          nonce: "nonce-revocation-off",
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
        assert.equal(response.status, 200, `expected 200, got ${response.status}`);
        const body = await response.json();
        assert.equal(body.type, "HandshakeAck");
      } finally {
        if (server.listening) {
          await closeServer(server);
        }
      }
    }
  );
  fs.rmSync(revocations.tempDir, { recursive: true, force: true });
}

async function testRevocationEnforceRejectsRevokedPeer() {
  const revocations = createRevocationSetFile([
    {
      subject: "peer-alpha",
      kind: "peer",
      revokedAt: Math.floor(Date.now() / 1000),
      reason: "test_peer_enforce"
    }
  ]);
  await withEnv(
    {
      INTENTOS_PROTOCOL_VERSION: "0.4",
      INTENTOS_FEDERATION: "on",
      INTENTOS_IDENTITY: "on",
      INTENTOS_REVOCATIONS: "on",
      INTENTOS_REVOCATION_POLICY: "enforce",
      INTENTOS_TRUST_DISTRIBUTION: "fs",
      INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH: revocations.filePath
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
          helloId: "hello-revoked-peer-enforce",
          senderPeerId: "peer-alpha",
          recipientPeerId: "peer-beta",
          nonce: "nonce-revoked-peer-enforce",
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
        assert.equal(response.status, 400, `expected 400, got ${response.status}`);
        const body = await response.json();
        assert.equal(body.code, "handshake_peer_revoked");
        assert.equal(body.details.subject, "peer-alpha");
      } finally {
        if (server.listening) {
          await closeServer(server);
        }
      }
    }
  );
  fs.rmSync(revocations.tempDir, { recursive: true, force: true });
}

async function testRevocationEnforceRejectsRevokedKey() {
  const inline = createSignedInlineAnchor("peer-alpha", "revoked-key-enforce");
  const revocations = createRevocationSetFile([
    {
      subject: inline.anchor.kid,
      kind: "key",
      revokedAt: Math.floor(Date.now() / 1000),
      reason: "test_key_enforce"
    }
  ]);
  await withEnv(
    {
      INTENTOS_PROTOCOL_VERSION: "0.4",
      INTENTOS_FEDERATION: "on",
      INTENTOS_IDENTITY: "on",
      INTENTOS_REVOCATIONS: "on",
      INTENTOS_REVOCATION_POLICY: "enforce",
      INTENTOS_TRUST_DISTRIBUTION: "fs",
      INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH: revocations.filePath
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
          helloId: "hello-revoked-key-enforce",
          senderPeerId: "peer-alpha",
          recipientPeerId: "peer-beta",
          nonce: "nonce-revoked-key-enforce",
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
        assert.equal(body.code, "handshake_key_revoked");
        assert.equal(body.details.subject, inline.anchor.kid);
      } finally {
        if (server.listening) {
          await closeServer(server);
        }
      }
    }
  );
  fs.rmSync(revocations.tempDir, { recursive: true, force: true });
}

async function testRevocationEnforceRejectsRevokedAnchor() {
  const inline = createSignedInlineAnchor("peer-alpha", "revoked-anchor-enforce");
  const revocations = createRevocationSetFile([
    {
      subject: inline.anchor.anchorId,
      kind: "anchor",
      revokedAt: Math.floor(Date.now() / 1000),
      reason: "test_anchor_enforce"
    }
  ]);
  await withEnv(
    {
      INTENTOS_PROTOCOL_VERSION: "0.4",
      INTENTOS_FEDERATION: "on",
      INTENTOS_IDENTITY: "on",
      INTENTOS_REVOCATIONS: "on",
      INTENTOS_REVOCATION_POLICY: "enforce",
      INTENTOS_TRUST_DISTRIBUTION: "fs",
      INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH: revocations.filePath
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
          helloId: "hello-revoked-anchor-enforce",
          senderPeerId: "peer-alpha",
          recipientPeerId: "peer-beta",
          nonce: "nonce-revoked-anchor-enforce",
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
        assert.equal(body.code, "anchor_revoked");
        assert.equal(body.details.subject, inline.anchor.anchorId);
      } finally {
        if (server.listening) {
          await closeServer(server);
        }
      }
    }
  );
  fs.rmSync(revocations.tempDir, { recursive: true, force: true });
}

async function testRevocationWarnAllowsAndEmitsDeterministicWarnings() {
  const warnCases = [
    {
      caseId: "peer",
      code: "handshake_peer_revoked",
      subject: "peer-alpha",
      buildHello: () => ({
        type: "HandshakeHello",
        protocolVersion: "0.4",
        helloId: "hello-revoked-peer-warn",
        senderPeerId: "peer-alpha",
        recipientPeerId: "peer-beta",
        nonce: "nonce-revoked-peer-warn",
        timestamp: new Date().toISOString()
      })
    },
    {
      caseId: "key",
      code: "handshake_key_revoked",
      buildHello: () => {
        const inline = createSignedInlineAnchor("peer-alpha", "revoked-key-warn");
        return {
          type: "HandshakeHello",
          protocolVersion: "0.4",
          helloId: "hello-revoked-key-warn",
          senderPeerId: "peer-alpha",
          recipientPeerId: "peer-beta",
          nonce: "nonce-revoked-key-warn",
          timestamp: new Date().toISOString(),
          identityAnchorsInline: [inline.anchor],
          __expectedSubject: inline.anchor.kid
        };
      }
    },
    {
      caseId: "anchor",
      code: "anchor_revoked",
      buildHello: () => {
        const inline = createSignedInlineAnchor("peer-alpha", "revoked-anchor-warn");
        return {
          type: "HandshakeHello",
          protocolVersion: "0.4",
          helloId: "hello-revoked-anchor-warn",
          senderPeerId: "peer-alpha",
          recipientPeerId: "peer-beta",
          nonce: "nonce-revoked-anchor-warn",
          timestamp: new Date().toISOString(),
          identityAnchorsInline: [inline.anchor],
          __expectedSubject: inline.anchor.anchorId
        };
      }
    }
  ];

  for (const scenario of warnCases) {
    const hello = scenario.buildHello();
    const expectedSubject = scenario.subject || hello.__expectedSubject;
    const revocations = createRevocationSetFile([
      {
        subject: expectedSubject,
        kind: scenario.caseId,
        revokedAt: Math.floor(Date.now() / 1000),
        reason: `test_${scenario.caseId}_warn`
      }
    ]);

    await withEnv(
      {
        INTENTOS_PROTOCOL_VERSION: "0.4",
        INTENTOS_FEDERATION: "on",
        INTENTOS_IDENTITY: "on",
        INTENTOS_REVOCATIONS: "on",
        INTENTOS_REVOCATION_POLICY: "warn",
        INTENTOS_TRUST_DISTRIBUTION: "fs",
        INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH: revocations.filePath
      },
      async () => {
        const relay = new WebhookRelay();
        const logs = await captureConsoleLogs(async () => {
          const server = createWebhookRelayServer(relay);
          try {
            await startServer(server);
            const address = server.address();
            assert(address && typeof address === "object", "expected server address");
            const requestHello = { ...hello };
            delete requestHello.__expectedSubject;
            const response = await fetch(
              `http://127.0.0.1:${address.port}/aimtp/intentos/federation/handshake`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(requestHello)
              }
            );
            assert.equal(response.status, 200, `expected 200, got ${response.status}`);
            const body = await response.json();
            assert.equal(body.type, "HandshakeAck");
            if (scenario.caseId === "key" || scenario.caseId === "anchor") {
              assert.equal(body.acceptedIdentityAnchors, false);
            }
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
          .filter((entry) => entry && entry.event === "handshake_revocation_warning");
        assert.equal(
          warningEvents.length,
          1,
          `expected one revocation warning for ${scenario.caseId}, got ${warningEvents.length}`
        );
        assert.equal(warningEvents[0].mode, "warn");
        assert.equal(warningEvents[0].code, scenario.code);
        assert.equal(warningEvents[0].subject, expectedSubject);
      }
    );

    fs.rmSync(revocations.tempDir, { recursive: true, force: true });
  }
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
  testRevocationEnforceViaDemo();
  testRevocationWarnViaDemo();
  await testEndpointReturns404WhenNotGated();
  await testSchemaMissingRequiredFieldRejects();
  await testSchemaWrongCapabilitiesTypeRejectsWhenNegotiationOn();
  await testSchemaUnknownFieldHandlingIsConsistent();
  await testInvalidInlineSignatureRejects();
  await testPeerVerifyEnforceRejectsMissingProof();
  await testPeerVerifyEnforceRejectsInvalidSignature();
  await testPeerVerifyEnforceRejectsMismatchedKeyIdReference();
  await testPeerVerifyWarnAcceptsAndEmitsWarning();
  await testRevocationsOffLeavesHandshakeBehaviorUnchanged();
  await testRevocationEnforceRejectsRevokedPeer();
  await testRevocationEnforceRejectsRevokedKey();
  await testRevocationEnforceRejectsRevokedAnchor();
  await testRevocationWarnAllowsAndEmitsDeterministicWarnings();
  await testNegotiationCanonicalizesCapabilityArrays();
  await testNegotiationRequiredMissingRejects();
  await testNegotiationAcceptedIntersection();
  console.log("OK: handshake HTTP demo tests");
}

main();
