#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";

const repoRoot = path.resolve(process.cwd());
const require = createRequire(import.meta.url);
const {
  applyTrustBundleDeltaToPath,
  processReceiptEnvelope,
  signReceipt,
  TRUST_BUNDLE_INVALID
} = require(path.resolve(repoRoot, "dist", "index.js"));

function computeBundleKeyFingerprint(publicKeyPem) {
  const normalizedPem = publicKeyPem.replace(/\r\n/g, "\n").trim();
  return createHash("sha256").update(normalizedPem).digest("hex").slice(0, 12);
}

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${stableStringifyJson(value[key])}`);
    return `{${parts.join(",")}}`;
  }
  throw new Error(`unsupported_value_type:${typeof value}`);
}

function canonicalizeTrustBundleForSigning(bundle) {
  return Buffer.from(
    stableStringifyJson({
      ...bundle,
      signature: undefined
    }),
    "utf8"
  );
}

function signTrustBundle(bundle, signer, privateKeyPem) {
  const signable = {
    ...bundle,
    signer,
    sigAlg: "ed25519",
    signature: undefined
  };
  const signature = signBytes(
    null,
    canonicalizeTrustBundleForSigning(signable),
    privateKeyPem
  ).toString("base64");
  return {
    ...signable,
    signature
  };
}

function baseReceipt() {
  return {
    receiptId: "rotation-receipt-001",
    envelopeId: "rotation-env-001",
    intentId: "rotation-intent-001",
    type: "receipt.completed",
    timestamp: "2026-02-19T10:00:00.000Z",
    metadata: { outputHash: "rotation-ok" }
  };
}

function evaluateReceipt(receipt, bundlePath, signer, signerPublicKeyPem) {
  return processReceiptEnvelope(
    { receipt },
    {
      mode: "warn",
      env: {
        INTENTOS_TRUST_VERSION: "v2",
        INTENTOS_TRUST_BUNDLE_PATH: bundlePath,
        INTENTOS_TRUST_BUNDLE_REQUIRE_SIGNATURE: "on",
        INTENTOS_TRUST_BUNDLE_TRUSTED_SIGNERS_JSON: JSON.stringify({
          [signer]: signerPublicKeyPem
        })
      }
    }
  );
}

function testKeyRotationV2SuccessAndFailureAtomicity() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "aimtp-trust-key-rotation-"));
  const bundlePath = path.join(tempDir, "trust-bundle.json");

  const { publicKey: oldPublicKey, privateKey: oldPrivateKey } = generateKeyPairSync("ed25519");
  const { publicKey: newPublicKey, privateKey: newPrivateKey } = generateKeyPairSync("ed25519");
  const { publicKey: signerPublicKey, privateKey: signerPrivateKey } = generateKeyPairSync("ed25519");
  const oldPublicKeyPem = oldPublicKey.export({ type: "spki", format: "pem" }).toString();
  const oldPrivateKeyPem = oldPrivateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const newPublicKeyPem = newPublicKey.export({ type: "spki", format: "pem" }).toString();
  const newPrivateKeyPem = newPrivateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const signerPublicKeyPem = signerPublicKey.export({ type: "spki", format: "pem" }).toString();
  const signerPrivateKeyPem = signerPrivateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const signer = "signer://rotation-admin";
  const issuer = "relay://rotation";
  const oldFingerprint = computeBundleKeyFingerprint(oldPublicKeyPem);

  const baseBundle = {
    bundleVersion: "v3",
    bundleId: "bundle-rotation-001",
    issuedAtSec: 1760600000,
    issuers: {
      [issuer]: {
        keys: [
          {
            kid: "old-key",
            alg: "ed25519",
            publicKeyPem: oldPublicKeyPem
          }
        ]
      }
    }
  };
  writeJson(bundlePath, signTrustBundle(baseBundle, signer, signerPrivateKeyPem));

  const oldSignedBefore = signReceipt(baseReceipt(), oldPrivateKeyPem, issuer, { trustVersion: "v2" });
  const newSignedBefore = signReceipt(baseReceipt(), newPrivateKeyPem, issuer, { trustVersion: "v2" });
  const oldBefore = evaluateReceipt(oldSignedBefore, bundlePath, signer, signerPublicKeyPem);
  const newBefore = evaluateReceipt(newSignedBefore, bundlePath, signer, signerPublicKeyPem);
  assert.equal(oldBefore.accepted, true);
  assert.equal(newBefore.accepted, false);

  const beforeSuccess = fs.readFileSync(bundlePath, "utf8");
  applyTrustBundleDeltaToPath(bundlePath, {
    version: "v1",
    addKeys: [
      {
        issuer,
        key: {
          kid: "new-key",
          alg: "ed25519",
          publicKeyPem: newPublicKeyPem
        }
      }
    ],
    revokeKeys: [
      {
        issuer,
        kid: "old-key"
      }
    ]
  }, {
    env: {
      INTENTOS_TRUST_VERSION: "v2"
    }
  });
  const rotatedUnsigned = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
  writeJson(bundlePath, signTrustBundle(rotatedUnsigned, signer, signerPrivateKeyPem));
  const afterSuccess = fs.readFileSync(bundlePath, "utf8");
  assert.notEqual(afterSuccess, beforeSuccess, "successful rotation should mutate bundle state");
  const parsedAfterSuccess = JSON.parse(afterSuccess);
  assert.ok(parsedAfterSuccess.revocations.issuerKeys[issuer].includes(oldFingerprint));
  assert.ok(parsedAfterSuccess.revocations.keys.includes(oldFingerprint));

  const oldSignedAfter = signReceipt(baseReceipt(), oldPrivateKeyPem, issuer, { trustVersion: "v2" });
  const newSignedAfter = signReceipt(baseReceipt(), newPrivateKeyPem, issuer, { trustVersion: "v2" });
  const oldAfter = evaluateReceipt(oldSignedAfter, bundlePath, signer, signerPublicKeyPem);
  const newAfter = evaluateReceipt(newSignedAfter, bundlePath, signer, signerPublicKeyPem);
  assert.equal(oldAfter.accepted, false);
  assert.match(oldAfter.reason, /invalid signature|signature invalid/i);
  assert.equal(newAfter.accepted, true);
  assert.equal(newAfter.reason, "signature valid");

  const beforeFailure = fs.readFileSync(bundlePath, "utf8");
  assert.throws(
    () =>
      applyTrustBundleDeltaToPath(
        bundlePath,
        {
          version: "v1",
          revokeKeys: {
            issuer,
            kid: "non-existent-key"
          }
        },
        {
          env: {
            INTENTOS_TRUST_VERSION: "v2"
          }
        }
      ),
    new RegExp(TRUST_BUNDLE_INVALID)
  );
  const afterFailure = fs.readFileSync(bundlePath, "utf8");
  assert.equal(afterFailure, beforeFailure, "failed rotation delta must not mutate bundle state");
}

function main() {
  testKeyRotationV2SuccessAndFailureAtomicity();
  console.log("OK: trust key rotation v2 tests");
}

main();
