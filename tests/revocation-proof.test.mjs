#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(process.cwd());
const signToolPath = path.resolve(repoRoot, "tools", "revocation-sign.mjs");
const verifyToolPath = path.resolve(repoRoot, "tools", "revocation-verify.mjs");

function runTool(toolPath, args) {
  return spawnSync(process.execPath, [toolPath, ...args], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8"
  });
}

function makeRevocationSet() {
  return {
    type: "revocations",
    specVersion: "0.4",
    issuer: "relay://alpha",
    issuedAt: 1760400000,
    revocations: [
      {
        subject: "peer://beta",
        kind: "peer",
        revokedAt: 1760400001,
        reason: "policy_violation"
      }
    ]
  };
}

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function testSignAndVerifyPass() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "aimtp-revocation-proof-"));
  const setPath = path.join(tempDir, "revocations.json");
  const proofPath = path.join(tempDir, "revocation-proof.json");
  const trustedKeysPath = path.join(tempDir, "trusted-keys.json");
  const privateKeyPath = path.join(tempDir, "revocation-private.pem");

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  writeJson(setPath, makeRevocationSet());
  fs.writeFileSync(privateKeyPath, privateKeyPem, "utf8");
  writeJson(trustedKeysPath, {
    "relay://alpha#revocations": publicKeyPem
  });

  const signResult = runTool(signToolPath, [
    "--in",
    setPath,
    "--key",
    privateKeyPath,
    "--key-id",
    "relay://alpha#revocations",
    "--out",
    proofPath
  ]);
  assert.equal(signResult.status, 0, `sign tool failed: ${signResult.stderr}`);
  assert.match(signResult.stdout, /REVOCATION SIGN OK/);

  const proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
  assert.equal(proof.type, "RevocationProof");
  assert.equal(proof.version, "0.4");
  assert.equal(proof.keyId, "relay://alpha#revocations");
  assert.equal(proof.alg, "ed25519");
  assert.equal(typeof proof.signature, "string");
  assert.ok(proof.signature.length > 0);

  const verifyResult = runTool(verifyToolPath, [
    "--set",
    setPath,
    "--proof",
    proofPath,
    "--trusted-keys-json",
    `@${trustedKeysPath}`
  ]);
  assert.equal(verifyResult.status, 0, `verify tool failed: ${verifyResult.stderr}`);
  assert.match(verifyResult.stdout, /revocation_proof_verified/);

  const tamperedSet = makeRevocationSet();
  tamperedSet.revocations[0].reason = "tampered_reason";
  writeJson(setPath, tamperedSet);

  const tamperedVerifyResult = runTool(verifyToolPath, [
    "--set",
    setPath,
    "--proof",
    proofPath,
    "--trusted-keys-json",
    `@${trustedKeysPath}`
  ]);
  assert.notEqual(tamperedVerifyResult.status, 0, "tampered set should fail verification");
  assert.match(String(tamperedVerifyResult.stderr || tamperedVerifyResult.stdout), /revocation_proof_invalid/);

  writeJson(setPath, makeRevocationSet());

  const unknownKeysPath = path.join(tempDir, "trusted-keys-unknown.json");
  writeJson(unknownKeysPath, {
    "relay://other#revocations": publicKeyPem
  });
  const unknownKeyVerifyResult = runTool(verifyToolPath, [
    "--set",
    setPath,
    "--proof",
    proofPath,
    "--trusted-keys-json",
    `@${unknownKeysPath}`
  ]);
  assert.notEqual(unknownKeyVerifyResult.status, 0, "unknown key id should fail verification");
  assert.match(
    String(unknownKeyVerifyResult.stderr || unknownKeyVerifyResult.stdout),
    /revocation_proof_key_unknown/
  );

  const missingProofPath = path.join(tempDir, "revocation-proof-missing.json");
  writeJson(missingProofPath, {
    type: "RevocationProof",
    version: "0.4",
    keyId: "relay://alpha#revocations",
    alg: "ed25519",
    createdAt: 1760400100
  });
  const missingProofVerifyResult = runTool(verifyToolPath, [
    "--set",
    setPath,
    "--proof",
    missingProofPath,
    "--trusted-keys-json",
    `@${trustedKeysPath}`
  ]);
  assert.notEqual(missingProofVerifyResult.status, 0, "missing signature should fail verification");
  assert.match(
    String(missingProofVerifyResult.stderr || missingProofVerifyResult.stdout),
    /revocation_proof_missing/
  );
}

function main() {
  testSignAndVerifyPass();
  console.log("OK: revocation proof tests");
}

main();
