#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";

const repoRoot = path.resolve(process.cwd());
const require = createRequire(import.meta.url);
const { processReceiptEnvelope, signReceipt } = require(path.resolve(repoRoot, "dist", "index.js"));

function stableStringifyJson(value) {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("non_finite_number");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringifyJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${stableStringifyJson(value[key])}`);
    return `{${parts.join(",")}}`;
  }
  throw new Error(`unsupported_value_type:${typeof value}`);
}

function computeKeyFingerprint(publicKeyPem) {
  const normalizedPem = publicKeyPem.replace(/\r\n/g, "\n").trim();
  return createHash("sha256").update(normalizedPem).digest("hex").slice(0, 12);
}

function canonicalizeBridgeProofPayload(bridge) {
  return Buffer.from(
    stableStringifyJson({
      issuer: bridge.issuer,
      subject: bridge.subject,
      subjectPublicKeyPem: bridge.subjectPublicKeyPem,
      subjectKeyFingerprint: bridge.subjectKeyFingerprint,
      issuedAt: bridge.issuedAt,
      expiresAt: bridge.expiresAt,
      sigAlg: bridge.sigAlg
    }),
    "utf8"
  );
}

function makeBridgeProof(issuerPrivateKeyPem, issuer, subject, subjectPublicKeyPem, issuedAt, expiresAt) {
  const payload = {
    issuer,
    subject,
    subjectPublicKeyPem,
    subjectKeyFingerprint: computeKeyFingerprint(subjectPublicKeyPem),
    issuedAt,
    expiresAt,
    sigAlg: "ed25519"
  };
  return {
    ...payload,
    signature: signBytes(null, canonicalizeBridgeProofPayload(payload), issuerPrivateKeyPem).toString("base64")
  };
}

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
  const invalidSigProof = makeBridgeProof(
    cPrivate,
    "relay://b",
    "relay://c",
    cPublic,
    nowSec - 5,
    nowSec + 60
  );
  const invalidSig = evaluate(receiptFromC, trustedByA, invalidSigProof);
  assert.equal(invalidSig.accepted, false, "invalid bridge proof signature should reject");
  assert.match(invalidSig.reason, /bridge proof signature invalid/i);

  const expiredProof = makeBridgeProof(
    bPrivate,
    "relay://b",
    "relay://c",
    cPublic,
    nowSec - 120,
    nowSec - 10
  );
  const expired = evaluate(receiptFromC, trustedByA, expiredProof);
  assert.equal(expired.accepted, false, "expired bridge proof should reject");
  assert.match(expired.reason, /bridge proof expired/i);

  const validProof = makeBridgeProof(
    bPrivate,
    "relay://b",
    "relay://c",
    cPublic,
    nowSec - 5,
    nowSec + 60
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
