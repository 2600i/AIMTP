#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(process.cwd());
const toolPath = path.resolve(repoRoot, "tools", "trust-bundle-delta-apply.mjs");

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function computeBundleKeyFingerprint(publicKeyPem) {
  const normalizedPem = publicKeyPem.replace(/\r\n/g, "\n").trim();
  return createHash("sha256").update(normalizedPem).digest("hex").slice(0, 12);
}

function runTool(args) {
  return spawnSync(process.execPath, [toolPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: "utf8"
  });
}

function testToolAppliesDeltaOnSuccessAndPreservesStateOnFailure() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "aimtp-trust-delta-tool-"));
  const statePath = path.join(tempDir, "trust-bundle.json");
  const successDeltaPath = path.join(tempDir, "delta-success.json");
  const failureDeltaPath = path.join(tempDir, "delta-failure.json");

  const { publicKey: oldPublicKey } = generateKeyPairSync("ed25519");
  const { publicKey: newPublicKey } = generateKeyPairSync("ed25519");
  const oldPublicKeyPem = oldPublicKey.export({ type: "spki", format: "pem" }).toString();
  const newPublicKeyPem = newPublicKey.export({ type: "spki", format: "pem" }).toString();
  const oldFingerprint = computeBundleKeyFingerprint(oldPublicKeyPem);
  const issuer = "relay://tool-rotation";

  writeJson(statePath, {
    bundleVersion: "v3",
    bundleId: "bundle-tool-001",
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
  });

  writeJson(successDeltaPath, {
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
  });

  const beforeSuccess = fs.readFileSync(statePath, "utf8");
  const success = runTool([
    "--state",
    statePath,
    "--delta",
    successDeltaPath,
    "--trust-version",
    "v2"
  ]);
  assert.equal(success.status, 0, `expected success exit 0, got ${success.status}\n${success.stderr}`);
  assert.match(String(success.stdout), /^OK\s*$/m);

  const afterSuccess = fs.readFileSync(statePath, "utf8");
  assert.notEqual(afterSuccess, beforeSuccess, "success path should mutate state");
  const parsedSuccess = JSON.parse(afterSuccess);
  assert.ok(parsedSuccess.issuers[issuer].keys.some((entry) => entry.kid === "new-key"));
  assert.ok(parsedSuccess.issuers[issuer].keys.some((entry) => entry.kid === "old-key"));
  assert.ok(parsedSuccess.revocations.issuerKeys[issuer].includes(oldFingerprint));

  writeJson(failureDeltaPath, {
    version: "v1",
    revokeKeys: {
      issuer,
      kid: "old-key"
    }
  });

  const beforeFailure = fs.readFileSync(statePath, "utf8");
  const failure = runTool([
    "--state",
    statePath,
    "--delta",
    failureDeltaPath,
    "--trust-version",
    "v2"
  ]);
  assert.notEqual(failure.status, 0, "expected failure exit code");
  assert.match(String(failure.stdout), /^ERROR TRUST_BUNDLE_INVALID /m);

  const afterFailure = fs.readFileSync(statePath, "utf8");
  assert.equal(afterFailure, beforeFailure, "failure path must not mutate state");
}

function main() {
  testToolAppliesDeltaOnSuccessAndPreservesStateOnFailure();
  console.log("OK: trust bundle delta tool tests");
}

main();
