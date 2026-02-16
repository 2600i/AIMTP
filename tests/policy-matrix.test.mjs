#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { WebhookRelay, createWebhookRelayServer } = require("../runtime");

const repoRoot = path.resolve(process.cwd());
const identityAnchorFetchToolPath = path.resolve(repoRoot, "tools", "identity-anchor-fetch.mjs");

const peerVerifyModes = ["off", "warn", "enforce"];
const negotiationModes = ["off", "on"];
const identityPolicyModes = ["off", "warn", "enforce"];

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
  return Buffer.from(
    JSON.stringify({
      nonce: hello.nonce,
      timestamp: hello.timestamp,
      senderPeerId: hello.senderPeerId,
      senderRelayUrl: hello.senderRelayUrl || "",
      capabilitiesOffered: canonicalizeCapabilityList(hello.capabilitiesOffered),
      capabilitiesRequired: canonicalizeCapabilityList(hello.capabilitiesRequired)
    }),
    "utf8"
  );
}

function createSignedInlineAnchor(peerId, suffix) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const anchor = {
    type: "IdentityAnchor",
    protocolVersion: "0.4",
    anchorId: `anchor-matrix-${suffix}`,
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
    previous.set(
      key,
      Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined
    );
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

function parseIdentityFetchWarnings(stderr) {
  return String(stderr || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry && entry.event === "intentos_identity_anchor_distribution");
}

function runIdentityAnchorFetch(envOverrides) {
  const env = { ...process.env, ...envOverrides };
  return spawnSync(process.execPath, [identityAnchorFetchToolPath], {
    cwd: repoRoot,
    env,
    encoding: "utf8"
  });
}

function buildMissingRequiredHello(caseId) {
  return {
    type: "HandshakeHello",
    protocolVersion: "0.4",
    helloId: `hello-matrix-missing-required-${caseId}`,
    senderPeerId: "peer-alpha",
    recipientPeerId: "peer-beta",
    timestamp: new Date().toISOString()
  };
}

function buildNegotiationMissingHello(caseId) {
  return {
    type: "HandshakeHello",
    protocolVersion: "0.4",
    helloId: `hello-matrix-negotiation-missing-${caseId}`,
    senderPeerId: "peer-alpha",
    recipientPeerId: "peer-beta",
    nonce: `nonce-matrix-negotiation-missing-${caseId}`,
    timestamp: new Date().toISOString(),
    capabilitiesOffered: ["federation-handshake-http", "identity-anchor-exchange"],
    capabilitiesRequired: ["missing-cap-z", "missing-cap-a", "missing-cap-z"]
  };
}

function buildPeerProofKeyMismatchHello(caseId, signedInline) {
  const hello = {
    type: "HandshakeHello",
    protocolVersion: "0.4",
    helloId: `hello-matrix-peer-proof-key-mismatch-${caseId}`,
    senderPeerId: "peer-alpha",
    recipientPeerId: "peer-beta",
    nonce: `nonce-matrix-peer-proof-key-mismatch-${caseId}`,
    timestamp: new Date().toISOString(),
    identityAnchorsInline: [signedInline.anchor]
  };
  hello.peerProof = createPeerProof(hello, signedInline.privateKey, "anchor-key-not-presented");
  return hello;
}

async function requestHandshake(port, hello) {
  const response = await fetch(`http://127.0.0.1:${port}/aimtp/intentos/federation/handshake`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(hello)
  });
  const body = await response.json();
  return { status: response.status, body };
}

async function assertHandshakeMatrixCase(combo, caseId) {
  await withEnv(
    {
      INTENTOS_PROTOCOL_VERSION: "0.4",
      INTENTOS_FEDERATION: "on",
      INTENTOS_IDENTITY: "on",
      INTENTOS_HANDSHAKE_PEER_VERIFY: combo.peerVerify,
      INTENTOS_HANDSHAKE_NEGOTIATION: combo.negotiation,
      INTENTOS_IDENTITY_POLICY: combo.identityPolicy
    },
    async () => {
      const relay = new WebhookRelay();
      const server = createWebhookRelayServer(relay);
      try {
        await startServer(server);
        const address = server.address();
        assert(address && typeof address === "object", "expected server address");
        const port = address.port;

        // A) Missing required field -> always schema 400 in gated 0.4 federation mode.
        const missingRequired = await requestHandshake(port, buildMissingRequiredHello(caseId));
        assert.equal(
          missingRequired.status,
          400,
          `A failed for ${caseId}: expected 400, got ${missingRequired.status}`
        );
        assert.equal(
          missingRequired.body.code,
          "invalid_schema",
          `A failed for ${caseId}: expected invalid_schema`
        );

        // B) Required capability missing -> 400 with deterministic missing list only when negotiation=on.
        if (combo.negotiation === "on") {
          const negotiationMissing = await requestHandshake(port, buildNegotiationMissingHello(caseId));
          assert.equal(
            negotiationMissing.status,
            400,
            `B failed for ${caseId}: expected 400, got ${negotiationMissing.status}`
          );
          assert.equal(
            negotiationMissing.body.code,
            "handshake_capability_required_missing",
            `B failed for ${caseId}: expected handshake_capability_required_missing`
          );
          assert.deepEqual(
            canonicalizeCapabilityList(
              negotiationMissing.body.details && negotiationMissing.body.details.capabilitiesMissing
            ),
            ["missing-cap-a", "missing-cap-z"],
            `B failed for ${caseId}: capabilitiesMissing mismatch`
          );
        }

        // C) Peer proof key reference mismatch -> behavior varies by peer verify mode.
        const signedInline = createSignedInlineAnchor("peer-alpha", caseId);
        const peerProofHello = buildPeerProofKeyMismatchHello(caseId, signedInline);
        if (combo.peerVerify === "enforce") {
          const enforceResult = await requestHandshake(port, peerProofHello);
          assert.equal(
            enforceResult.status,
            400,
            `C failed for ${caseId}: expected 400, got ${enforceResult.status}`
          );
          assert.equal(
            enforceResult.body.code,
            "handshake_peer_proof_key_unknown",
            `C failed for ${caseId}: expected handshake_peer_proof_key_unknown`
          );
          assert.equal(
            enforceResult.body.details && enforceResult.body.details.acceptedIdentityAnchors,
            false,
            `C failed for ${caseId}: acceptedIdentityAnchors should be false in enforce`
          );
        } else if (combo.peerVerify === "warn") {
          const logs = await captureConsoleLogs(async () => {
            const warnResult = await requestHandshake(port, peerProofHello);
            assert.equal(
              warnResult.status,
              200,
              `C failed for ${caseId}: expected 200, got ${warnResult.status}`
            );
            assert.equal(warnResult.body.type, "HandshakeAck", `C failed for ${caseId}: expected HandshakeAck`);
            assert.equal(
              warnResult.body.acceptedIdentityAnchors,
              false,
              `C failed for ${caseId}: acceptedIdentityAnchors should be false in warn`
            );
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
          assert.equal(warningEvents.length, 1, `C failed for ${caseId}: expected one warning event`);
          assert.equal(
            warningEvents[0].code,
            "handshake_peer_proof_key_unknown",
            `C failed for ${caseId}: warning code mismatch`
          );
        } else {
          const offResult = await requestHandshake(port, peerProofHello);
          assert.equal(
            offResult.status,
            200,
            `C failed for ${caseId}: expected 200, got ${offResult.status}`
          );
          assert.equal(offResult.body.type, "HandshakeAck", `C failed for ${caseId}: expected HandshakeAck`);
          assert.equal(
            offResult.body.acceptedIdentityAnchors,
            true,
            `C failed for ${caseId}: acceptedIdentityAnchors should stay true in off`
          );
        }
      } finally {
        if (server.listening) {
          await closeServer(server);
        }
      }
    }
  );
}

function assertIdentityAnchorIngestionMatrixCase(combo, caseId, invalidAnchorSetPath) {
  // Runtime currently gates ingestion policy behavior through INTENTOS_RECEIPT_POLICY.
  const result = runIdentityAnchorFetch({
    INTENTOS_PROTOCOL_VERSION: "0.4",
    INTENTOS_IDENTITY: "on",
    INTENTOS_TRUST_DISTRIBUTION: "fs",
    INTENTOS_TRUST_IDENTITY_ANCHORS_PATH: invalidAnchorSetPath,
    INTENTOS_IDENTITY_POLICY: combo.identityPolicy,
    INTENTOS_RECEIPT_POLICY: combo.identityPolicy
  });

  if (combo.identityPolicy === "enforce") {
    assert.notEqual(result.status, 0, `D failed for ${caseId}: enforce should reject`);
    assert.match(
      result.stderr,
      /identity_anchor_fetch_schema_invalid/,
      `D failed for ${caseId}: enforce diagnostic mismatch`
    );
    return;
  }

  assert.equal(result.status, 0, `D failed for ${caseId}: expected exit 0`);
  assert.match(result.stdout, /FETCH OK count=0/, `D failed for ${caseId}: expected fallback count=0`);
  const warningEvents = parseIdentityFetchWarnings(result.stderr);
  if (combo.identityPolicy === "warn") {
    assert.equal(warningEvents.length, 1, `D failed for ${caseId}: warn should emit one warning`);
    assert.equal(warningEvents[0].mode, "warn", `D failed for ${caseId}: warning mode mismatch`);
    assert.match(
      String(warningEvents[0].diagnostic || ""),
      /identity_anchor_fetch_schema_invalid/,
      `D failed for ${caseId}: warning diagnostic mismatch`
    );
  } else {
    assert.equal(warningEvents.length, 0, `D failed for ${caseId}: off should be inert`);
  }
}

function buildInvalidAnchorSetFile() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "aimtp-policy-matrix-"));
  const badPath = path.join(tempDir, "identity-anchors-invalid-schema.json");
  const payload = {
    type: "identity-anchors",
    protocolVersion: "0.4",
    anchors: [],
    unexpected: true
  };
  fs.writeFileSync(badPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { tempDir, badPath };
}

function buildMatrix() {
  const matrix = [];
  for (const peerVerify of peerVerifyModes) {
    for (const negotiation of negotiationModes) {
      for (const identityPolicy of identityPolicyModes) {
        matrix.push({ peerVerify, negotiation, identityPolicy });
      }
    }
  }
  return matrix;
}

async function main() {
  const matrix = buildMatrix();
  const invalidAnchorSet = buildInvalidAnchorSetFile();
  try {
    for (const combo of matrix) {
      const caseId = `peer=${combo.peerVerify}|neg=${combo.negotiation}|identity=${combo.identityPolicy}`;
      await assertHandshakeMatrixCase(combo, caseId);
      assertIdentityAnchorIngestionMatrixCase(combo, caseId, invalidAnchorSet.badPath);
    }
  } finally {
    fs.rmSync(invalidAnchorSet.tempDir, { recursive: true, force: true });
  }
  console.log("OK: policy matrix tests");
}

main();
