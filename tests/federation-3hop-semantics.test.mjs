#!/usr/bin/env node

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

const repoRoot = path.resolve(process.cwd());
const require = createRequire(import.meta.url);
const { processReceiptEnvelope, signReceipt } = require(path.resolve(repoRoot, "dist", "index.js"));

function exportPublicPem(publicKey) {
  return publicKey.export({ type: "spki", format: "pem" }).toString();
}

function exportPrivatePem(privateKey) {
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

function makeReceipt(idSuffix) {
  return {
    receiptId: `fed-3hop-${idSuffix}-receipt`,
    envelopeId: `fed-3hop-${idSuffix}-env`,
    intentId: `fed-3hop-${idSuffix}-intent`,
    type: "receipt.completed",
    timestamp: "2026-02-19T12:00:00.000Z",
    metadata: { outputHash: `sha256:${idSuffix}` }
  };
}

function evaluate(receipt, trustedReceiptKeys) {
  return processReceiptEnvelope(
    { receipt },
    {
      mode: "warn",
      trustVersion: "v2",
      trustedReceiptKeys,
      env: {
        INTENTOS_TRUST_VERSION: "v2"
      }
    }
  );
}

function testDirectTrustRequiredForThreeHopFederation() {
  const aKeys = generateKeyPairSync("ed25519");
  const bKeys = generateKeyPairSync("ed25519");
  const cKeys = generateKeyPairSync("ed25519");

  const aPublic = exportPublicPem(aKeys.publicKey);
  const bPublic = exportPublicPem(bKeys.publicKey);
  const cPublic = exportPublicPem(cKeys.publicKey);
  const aPrivate = exportPrivatePem(aKeys.privateKey);
  const bPrivate = exportPrivatePem(bKeys.privateKey);
  const cPrivate = exportPrivatePem(cKeys.privateKey);

  const receiptFromA = signReceipt(makeReceipt("a"), aPrivate, "relay://a", { trustVersion: "v2" });
  const receiptFromB = signReceipt(makeReceipt("b"), bPrivate, "relay://b", { trustVersion: "v2" });
  const receiptFromC = signReceipt(makeReceipt("c"), cPrivate, "relay://c", { trustVersion: "v2" });

  const trustedByA = {
    "relay://a": aPublic,
    "relay://b": bPublic
  };
  const trustedByB = {
    "relay://a": aPublic,
    "relay://b": bPublic,
    "relay://c": cPublic
  };
  const trustedByC = {
    "relay://b": bPublic,
    "relay://c": cPublic
  };

  const case1 = evaluate(receiptFromA, trustedByB);
  assert.equal(case1.accepted, true, "B should directly trust A");
  assert.equal(case1.trusted, true);

  const case2 = evaluate(receiptFromB, trustedByC);
  assert.equal(case2.accepted, true, "C should directly trust B");
  assert.equal(case2.trusted, true);

  const case3 = evaluate(receiptFromC, trustedByA);
  assert.equal(case3.accepted, false, "A should reject C without direct trust");
  assert.equal(case3.trusted, false);
  assert.match(case3.reason, /untrusted issuer|unknown issuer/i);
}

function main() {
  testDirectTrustRequiredForThreeHopFederation();
  console.log("OK: federation 3hop semantics tests");
}

main();
