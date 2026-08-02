#!/usr/bin/env node

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

const repoRoot = path.resolve(process.cwd());
const require = createRequire(import.meta.url);
const { createBridgeProof, verifyBridgeProof } = require(path.resolve(repoRoot, "dist", "index.js"));

function exportPublicPem(publicKey) {
  return publicKey.export({ type: "spki", format: "pem" }).toString();
}

function exportPrivatePem(privateKey) {
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function testBridgeProofSchemaValidationRejectsMalformedShapes() {
  const issuerPair = generateKeyPairSync("ed25519");
  const subjectPair = generateKeyPairSync("ed25519");
  const issuerPublicPem = exportPublicPem(issuerPair.publicKey);
  const issuerPrivatePem = exportPrivatePem(issuerPair.privateKey);
  const subjectPublicPem = exportPublicPem(subjectPair.publicKey);

  const nowSec = Math.floor(Date.now() / 1000);
  const trustedKeys = {
    "relay://b": issuerPublicPem
  };
  const validProof = createBridgeProof(
    {
      issuer: "relay://b",
      subject: "relay://c",
      subjectPublicKeyPem: subjectPublicPem,
      issuedAt: nowSec - 1,
      expiresAt: nowSec + 120
    },
    issuerPrivatePem
  );
  const validResult = verifyBridgeProof(validProof, trustedKeys, nowSec);
  assert.equal(validResult.valid, true);

  const missingVersion = clone(validProof);
  delete missingVersion.version;
  const missingVersionResult = verifyBridgeProof(missingVersion, trustedKeys, nowSec);
  assert.equal(missingVersionResult.valid, false);
  assert.equal(missingVersionResult.code, "TRUST_BUNDLE_INVALID");
  assert.match(missingVersionResult.reason, /bridge proof invalid/i);

  const wrongTypes = clone(validProof);
  wrongTypes.issuedAt = "not-a-number";
  const wrongTypesResult = verifyBridgeProof(wrongTypes, trustedKeys, nowSec);
  assert.equal(wrongTypesResult.valid, false);
  assert.equal(wrongTypesResult.code, "TRUST_BUNDLE_INVALID");
  assert.match(wrongTypesResult.reason, /bridge proof invalid/i);

  const missingSubjectSelector = clone(validProof);
  delete missingSubjectSelector.subjectKeyFingerprint;
  delete missingSubjectSelector.subjectKeyKid;
  const missingSelectorResult = verifyBridgeProof(missingSubjectSelector, trustedKeys, nowSec);
  assert.equal(missingSelectorResult.valid, false);
  assert.equal(missingSelectorResult.code, "TRUST_BUNDLE_INVALID");
  assert.match(missingSelectorResult.reason, /bridge proof invalid/i);
}

function main() {
  testBridgeProofSchemaValidationRejectsMalformedShapes();
  console.log("OK: bridge proof schema tests");
}

main();
