#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";

const repoRoot = path.resolve(process.cwd());
const require = createRequire(import.meta.url);
const {
  applyTrustBundleDeltaToPath,
  TRUST_ANCHOR_REVOKED,
  TRUST_BUNDLE_INVALID,
  TRUST_SIGNATURE_INVALID
} = require(path.resolve(repoRoot, "dist", "index.js"));

function computeBundleKeyFingerprint(publicKeyPem) {
  const normalizedPem = publicKeyPem.replace(/\r\n/g, "\n").trim();
  return createHash("sha256").update(normalizedPem).digest("hex").slice(0, 12);
}

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function makeAnchor(anchorId, publicKeyPem, timestamp) {
  return {
    anchorId,
    peerId: "peer://alpha",
    publicKeyPem,
    timestamp,
    alg: "ed25519",
    kid: `${anchorId}#kid`,
    signature: "aW52YWxpZA=="
  };
}

function testDeltaApplySuccessMutatesStateAndFailureMutatesNothing() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "aimtp-trust-delta-apply-"));
  const bundlePath = path.join(tempDir, "trust-bundle.json");
  const nowIso = "2026-02-19T09:00:00.000Z";
  const nowMs = Date.parse(nowIso);

  const { publicKey: oldPublicKey } = generateKeyPairSync("ed25519");
  const { publicKey: newPublicKey } = generateKeyPairSync("ed25519");
  const { publicKey: oldAnchorPublicKey } = generateKeyPairSync("ed25519");
  const { publicKey: newAnchorPublicKey } = generateKeyPairSync("ed25519");
  const { publicKey: badAnchorPublicKey } = generateKeyPairSync("ed25519");
  const oldPublicKeyPem = oldPublicKey.export({ type: "spki", format: "pem" }).toString();
  const newPublicKeyPem = newPublicKey.export({ type: "spki", format: "pem" }).toString();
  const oldAnchorPublicKeyPem = oldAnchorPublicKey.export({ type: "spki", format: "pem" }).toString();
  const newAnchorPublicKeyPem = newAnchorPublicKey.export({ type: "spki", format: "pem" }).toString();
  const badAnchorPublicKeyPem = badAnchorPublicKey.export({ type: "spki", format: "pem" }).toString();
  const issuer = "relay://delta-issuer";
  const oldFingerprint = computeBundleKeyFingerprint(oldPublicKeyPem);

  writeJson(bundlePath, {
    bundleVersion: "v3",
    bundleId: "bundle-delta-001",
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
    },
    anchors: [makeAnchor("anchor://old", oldAnchorPublicKeyPem, nowIso)]
  });

  const beforeSuccess = fs.readFileSync(bundlePath, "utf8");
  const successResult = applyTrustBundleDeltaToPath(
    bundlePath,
    {
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
      ],
      addAnchors: [makeAnchor("anchor://new", newAnchorPublicKeyPem, nowIso)]
    },
    {
      nowMs,
      env: {
        INTENTOS_TRUST_VERSION: "v2"
      }
    }
  );
  assert.equal(successResult.applied, true);
  const afterSuccess = fs.readFileSync(bundlePath, "utf8");
  assert.notEqual(afterSuccess, beforeSuccess, "success path should mutate bundle state");

  const parsedSuccess = JSON.parse(afterSuccess);
  assert.equal(parsedSuccess.issuers[issuer].keys.length, 2);
  assert.ok(parsedSuccess.issuers[issuer].keys.some((entry) => entry.kid === "new-key"));
  assert.ok(parsedSuccess.issuers[issuer].keys.some((entry) => entry.kid === "old-key"));
  assert.ok(parsedSuccess.revocations.issuerKeys[issuer].includes(oldFingerprint));
  assert.ok(parsedSuccess.revocations.keys.includes(oldFingerprint));
  assert.ok(parsedSuccess.anchors.some((entry) => entry.anchorId === "anchor://old"));
  assert.ok(parsedSuccess.anchors.some((entry) => entry.anchorId === "anchor://new"));

  const beforeFailure = fs.readFileSync(bundlePath, "utf8");
  assert.throws(
    () =>
      applyTrustBundleDeltaToPath(
        bundlePath,
        {
          version: "v1",
          revokeKeys: {
            issuer,
            kid: "old-key"
          }
        },
        {
          nowMs,
          env: {
            INTENTOS_TRUST_VERSION: "v2"
          }
        }
      ),
    new RegExp(TRUST_BUNDLE_INVALID)
  );
  const afterMalformedFailure = fs.readFileSync(bundlePath, "utf8");
  assert.equal(afterMalformedFailure, beforeFailure, "malformed delta must not mutate bundle state");

  assert.throws(
    () =>
      applyTrustBundleDeltaToPath(
        bundlePath,
        {
          version: "v1",
          revokeAnchors: [{ anchorId: "anchor://old" }]
        },
        {
          nowMs,
          env: {
            INTENTOS_TRUST_VERSION: "v2"
          }
        }
      ),
    new RegExp(TRUST_ANCHOR_REVOKED)
  );
  const afterRevokedAnchorFailure = fs.readFileSync(bundlePath, "utf8");
  assert.equal(afterRevokedAnchorFailure, beforeFailure, "revoked anchor failure must not mutate bundle state");

  assert.throws(
    () =>
      applyTrustBundleDeltaToPath(
        bundlePath,
        {
          version: "v1",
          addAnchors: [
            {
              anchorId: "anchor://bad",
              peerId: "peer://alpha",
              publicKeyPem: badAnchorPublicKeyPem,
              timestamp: nowIso,
              alg: "ed25519",
              kid: "anchor://bad#kid"
            }
          ]
        },
        {
          nowMs,
          env: {
            INTENTOS_TRUST_VERSION: "v2"
          }
        }
      ),
    new RegExp(TRUST_SIGNATURE_INVALID)
  );
  const afterSignatureFailure = fs.readFileSync(bundlePath, "utf8");
  assert.equal(afterSignatureFailure, beforeFailure, "invalid signature failure must not mutate bundle state");
}

function main() {
  testDeltaApplySuccessMutatesStateAndFailureMutatesNothing();
  console.log("OK: trust bundle delta apply tests");
}

main();
