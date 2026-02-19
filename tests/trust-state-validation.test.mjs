#!/usr/bin/env node

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
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

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function baseReceipt() {
  return {
    receiptId: "state-shape-receipt-001",
    envelopeId: "state-shape-env-001",
    intentId: "state-shape-intent-001",
    type: "receipt.completed",
    timestamp: "2026-02-19T11:00:00.000Z",
    metadata: { outputHash: "state-shape-ok" }
  };
}

function makeValidState(issuer, publicKeyPem) {
  return {
    bundleVersion: "v3",
    bundleId: "state-shape-bundle-001",
    issuedAtSec: 1760600000,
    issuers: {
      [issuer]: {
        keys: [
          {
            kid: "issuer-key-1",
            alg: "ed25519",
            publicKeyPem
          }
        ]
      }
    }
  };
}

function evaluateWithStatePath(receipt, statePath) {
  return processReceiptEnvelope(
    { receipt },
    {
      mode: "warn",
      env: {
        INTENTOS_TRUST_VERSION: "v2",
        INTENTOS_TRUST_BUNDLE_PATH: statePath
      }
    }
  );
}

function assertStateRejectedAsInvalid(receipt, statePath, context) {
  const result = evaluateWithStatePath(receipt, statePath);
  assert.equal(result.accepted, false, `${context}: should reject malformed state`);
  assert.equal(result.trusted, false, `${context}: should not trust malformed state`);
  assert.equal(result.errorCode, TRUST_BUNDLE_INVALID, `${context}: should map to TRUST_BUNDLE_INVALID`);
}

function testRejectsMalformedTrustStateShapesAndCorruptedJson() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "aimtp-trust-state-shape-"));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const issuer = "relay://state-shape";
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const signedReceipt = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });

  const malformedKeysPath = path.join(tempDir, "state-malformed-keys.json");
  writeJson(malformedKeysPath, {
    ...makeValidState(issuer, publicKeyPem),
    keys: {
      issuer,
      key: {
        kid: "bad",
        alg: "ed25519",
        publicKeyPem
      }
    }
  });
  assertStateRejectedAsInvalid(signedReceipt, malformedKeysPath, "malformed keys array");

  const malformedAnchorsPath = path.join(tempDir, "state-malformed-anchors.json");
  writeJson(malformedAnchorsPath, {
    ...makeValidState(issuer, publicKeyPem),
    anchors: ["not-an-anchor-object"]
  });
  assertStateRejectedAsInvalid(signedReceipt, malformedAnchorsPath, "malformed anchors array");

  const wrongTypesPath = path.join(tempDir, "state-wrong-types.json");
  writeJson(wrongTypesPath, {
    ...makeValidState(issuer, publicKeyPem),
    revokedKeys: { key: "bad" },
    revokedAnchors: "bad"
  });
  assertStateRejectedAsInvalid(signedReceipt, wrongTypesPath, "wrong revoked field types");

  const corruptedJsonPath = path.join(tempDir, "state-corrupted.json");
  fs.writeFileSync(corruptedJsonPath, "{not-json\n", "utf8");
  assertStateRejectedAsInvalid(signedReceipt, corruptedJsonPath, "corrupted json load");
}

function testDeltaPreStateValidationRejectsAndMutatesNothing() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "aimtp-trust-state-delta-pre-"));
  const statePath = path.join(tempDir, "state.json");

  writeJson(statePath, {
    bundleVersion: "v3",
    bundleId: "state-delta-invalid-001",
    issuedAtSec: 1760600000,
    issuers: {
      "relay://delta": {
        keys: [
          {
            kid: "key-1",
            alg: "ed25519",
            publicKeyPem: "-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----"
          }
        ]
      }
    },
    keys: "bad"
  });

  const beforeFailure = fs.readFileSync(statePath, "utf8");
  assert.throws(
    () =>
      applyTrustBundleDeltaToPath(
        statePath,
        {
          version: "v1",
          addKeys: [
            {
              issuer: "relay://delta",
              key: {
                kid: "key-2",
                alg: "ed25519",
                publicKeyPem: "-----BEGIN PUBLIC KEY-----\nMIIC\n-----END PUBLIC KEY-----"
              }
            }
          ]
        },
        {
          env: {
            INTENTOS_TRUST_VERSION: "v2"
          }
        }
      ),
    new RegExp(TRUST_BUNDLE_INVALID)
  );
  const afterFailure = fs.readFileSync(statePath, "utf8");
  assert.equal(afterFailure, beforeFailure, "pre-state validation failure must not mutate state");
}

function main() {
  testRejectsMalformedTrustStateShapesAndCorruptedJson();
  testDeltaPreStateValidationRejectsAndMutatesNothing();
  console.log("OK: trust state validation tests");
}

main();
