#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";

const repoRoot = path.resolve(process.cwd());
const require = createRequire(import.meta.url);
const {
  applyTrustBundleToSnapshotStore,
  TRUST_ANCHOR_REVOKED,
  TRUST_BUNDLE_INVALID,
  TRUST_SIGNATURE_INVALID
} = require(path.resolve(repoRoot, "dist", "index.js"));

function makeAnchor(overrides = {}) {
  return {
    type: "IdentityAnchor",
    protocolVersion: "0.4",
    anchorId: "anchor://alpha/1",
    peerId: "peer://alpha",
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\nMFYwEAYHKoZIzj0CAQYFK4EEAAoDQgAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n-----END PUBLIC KEY-----",
    timestamp: "2026-02-19T09:00:00.000Z",
    alg: "ed25519",
    kid: "key://alpha/1",
    signature: "aW52YWxpZA==",
    ...overrides
  };
}

function makeBundle(anchorOverrides = {}, revocations) {
  const bundle = {
    type: "trust_bundle",
    version: "0.4",
    createdAt: 1760600000,
    issuer: "relay://alpha",
    identityAnchors: {
      set: {
        type: "identity-anchors",
        protocolVersion: "0.4",
        setId: "set://alpha/1",
        anchors: [makeAnchor(anchorOverrides)]
      }
    }
  };
  if (revocations) {
    bundle.revocations = revocations;
  }
  return bundle;
}

function expectStrictReject(bundle, expectedCode, testLabel, nowMs = Date.parse("2026-02-19T09:00:00.000Z")) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), `aimtp-trust-v2-strict-${testLabel}-`));
  const storeDir = path.join(tempDir, "snapshot-store");
  assert.equal(fs.existsSync(storeDir), false, "store should not exist before apply");

  let capturedError;
  try {
    applyTrustBundleToSnapshotStore(bundle, {
      storePath: storeDir,
      policy: "off",
      nowMs,
      env: {
        INTENTOS_TRUST_VERSION: "v2"
      }
    });
    assert.fail(`expected ${expectedCode} rejection`);
  } catch (error) {
    capturedError = error;
  }

  assert.ok(capturedError instanceof Error, "expected an Error");
  assert.match(capturedError.message, new RegExp(expectedCode), `expected ${expectedCode} in error message`);
  assert.equal(fs.existsSync(storeDir), false, "strict rejection must not mutate snapshot state");
}

function testStrictV2RejectsMissingAnchorSignature() {
  const bundle = makeBundle({
    signature: undefined
  });
  expectStrictReject(bundle, TRUST_SIGNATURE_INVALID, "missing-signature");
}

function testStrictV2RejectsRevokedAnchor() {
  const bundle = makeBundle({}, {
    set: {
      type: "revocations",
      specVersion: "0.4",
      issuer: "relay://alpha",
      issuedAt: 1760600001,
      revocations: [
        {
          subject: "anchor://alpha/1",
          kind: "anchor",
          revokedAt: 1760600002
        }
      ]
    }
  });
  expectStrictReject(bundle, TRUST_ANCHOR_REVOKED, "revoked-anchor");
}

function testStrictV2RejectsExpiredAnchorTimestamp() {
  const bundle = makeBundle({
    timestamp: "2026-02-19T08:40:00.000Z"
  });
  expectStrictReject(bundle, TRUST_BUNDLE_INVALID, "expired-anchor");
}

function main() {
  testStrictV2RejectsMissingAnchorSignature();
  testStrictV2RejectsRevokedAnchor();
  testStrictV2RejectsExpiredAnchorTimestamp();
  console.log("OK: trust v2 strict mode tests");
}

main();
