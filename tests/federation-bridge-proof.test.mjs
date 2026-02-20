#!/usr/bin/env node

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";

const repoRoot = path.resolve(process.cwd());
const require = createRequire(import.meta.url);
const { createBridgeProof, processReceiptEnvelope, signReceipt } = require(
  path.resolve(repoRoot, "dist", "index.js")
);

function makeReceipt(suffix) {
  return {
    receiptId: `bridge-${suffix}-receipt`,
    envelopeId: `bridge-${suffix}-env`,
    intentId: `bridge-${suffix}-intent`,
    type: "receipt.completed",
    timestamp: "2026-02-19T13:00:00.000Z",
    metadata: { outputHash: `sha256:${suffix}` }
  };
}

function evaluate(receipt, trustedKeys, bridgeProof) {
  return processReceiptEnvelope(
    { receipt },
    {
      mode: "warn",
      trustVersion: "v2",
      trustedReceiptKeys: trustedKeys,
      ...(bridgeProof ? { trustBridgeProofJson: JSON.stringify(bridgeProof) } : {}),
      env: {
        INTENTOS_TRUST_VERSION: "v2"
      }
    }
  );
}

function testFederationBridgeProofSemantics() {
  const a = generateKeyPairSync("ed25519");
  const b = generateKeyPairSync("ed25519");
  const c = generateKeyPairSync("ed25519");

  const aPublic = a.publicKey.export({ type: "spki", format: "pem" }).toString();
  const bPublic = b.publicKey.export({ type: "spki", format: "pem" }).toString();
  const cPublic = c.publicKey.export({ type: "spki", format: "pem" }).toString();
  const bPrivate = b.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const cPrivate = c.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const trustedByA = {
    "relay://a": aPublic,
    "relay://b": bPublic
  };

  const receiptFromC = signReceipt(makeReceipt("from-c"), cPrivate, "relay://c", { trustVersion: "v2" });

  const noProof = evaluate(receiptFromC, trustedByA, null);
  assert.equal(noProof.accepted, false, "no proof should reject");
  assert.match(noProof.reason, /unknown issuer|untrusted issuer/i);

  const nowSec = Math.floor(Date.now() / 1000);
  const invalidSigProof = createBridgeProof(
    {
      issuer: "relay://b",
      subject: "relay://c",
      subjectPublicKeyPem: cPublic,
      issuedAt: nowSec - 5,
      expiresAt: nowSec + 60
    },
    cPrivate
  );
  const invalidSig = evaluate(receiptFromC, trustedByA, invalidSigProof);
  assert.equal(invalidSig.accepted, false, "invalid bridge proof signature should reject");
  assert.match(invalidSig.reason, /bridge proof signature invalid/i);

  const expiredProof = createBridgeProof(
    {
      issuer: "relay://b",
      subject: "relay://c",
      subjectPublicKeyPem: cPublic,
      issuedAt: nowSec - 120,
      expiresAt: nowSec - 10
    },
    bPrivate
  );
  const expired = evaluate(receiptFromC, trustedByA, expiredProof);
  assert.equal(expired.accepted, false, "expired bridge proof should reject");
  assert.match(expired.reason, /bridge proof expired/i);

  const validProof = createBridgeProof(
    {
      issuer: "relay://b",
      subject: "relay://c",
      subjectPublicKeyPem: cPublic,
      issuedAt: nowSec - 5,
      expiresAt: nowSec + 60
    },
    bPrivate
  );
  const valid = evaluate(receiptFromC, trustedByA, validProof);
  assert.equal(valid.accepted, true, "valid bridge proof should allow C verification");
  assert.equal(valid.trusted, true);
  assert.match(valid.reason, /bridge proof valid/i);
}

function main() {
  testFederationBridgeProofSemantics();
  console.log("OK: federation bridge proof tests");
}

main();
