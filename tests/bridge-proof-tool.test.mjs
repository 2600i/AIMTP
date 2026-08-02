#!/usr/bin/env node

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(process.cwd());
const toolPath = path.resolve(repoRoot, "tools", "bridge-proof.mjs");

function exportPublicPem(publicKey) {
  return publicKey.export({ type: "spki", format: "pem" }).toString();
}

function exportPrivatePem(privateKey) {
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function runTool(args) {
  return spawnSync(process.execPath, [toolPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: "utf8"
  });
}

function testBridgeProofToolMintThenVerify() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimtp-bridge-proof-tool-"));
  const issuerKeyPath = path.join(tempDir, "issuer-private.pem");
  const subjectKeyPath = path.join(tempDir, "subject-public.pem");
  const proofPath = path.join(tempDir, "proof.json");
  const trustedKeysPath = path.join(tempDir, "trusted-keys.json");

  const issuerPair = generateKeyPairSync("ed25519");
  const subjectPair = generateKeyPairSync("ed25519");
  const issuerPrivatePem = exportPrivatePem(issuerPair.privateKey);
  const issuerPublicPem = exportPublicPem(issuerPair.publicKey);
  const subjectPublicPem = exportPublicPem(subjectPair.publicKey);
  fs.writeFileSync(issuerKeyPath, issuerPrivatePem, "utf8");
  fs.writeFileSync(subjectKeyPath, subjectPublicPem, "utf8");

  const mint = runTool([
    "mint",
    "--issuer",
    "relay://b",
    "--subject",
    "relay://c",
    "--subject-key",
    subjectKeyPath,
    "--ttl",
    "120",
    "--out",
    proofPath,
    "--issuer-key",
    issuerKeyPath
  ]);
  assert.equal(mint.status, 0, `expected mint to succeed\n${mint.stderr}`);
  assert.match(String(mint.stdout), /^OK BRIDGE_PROOF_MINTED /m);

  const proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
  assert.equal(proof.version, "v1");
  assert.equal(proof.issuer, "relay://b");
  assert.equal(proof.subject, "relay://c");
  assert.ok(typeof proof.signature === "string" && proof.signature.length > 0);

  writeJson(trustedKeysPath, { "relay://b": issuerPublicPem });
  const verifyOk = runTool([
    "verify",
    "--proof",
    proofPath,
    "--trusted-keys",
    trustedKeysPath
  ]);
  assert.equal(verifyOk.status, 0, `expected verify to succeed\n${verifyOk.stderr}`);
  assert.match(String(verifyOk.stdout), /^OK BRIDGE_PROOF_VALID /m);

  const tamperedProofPath = path.join(tempDir, "proof-tampered.json");
  const tamperedProof = { ...proof, signature: "AA==" };
  writeJson(tamperedProofPath, tamperedProof);
  const verifyTampered = runTool([
    "verify",
    "--proof",
    tamperedProofPath,
    "--trusted-keys",
    trustedKeysPath
  ]);
  assert.notEqual(verifyTampered.status, 0);
  assert.match(String(verifyTampered.stdout), /^ERROR TRUST_SIGNATURE_INVALID /m);
}

function main() {
  testBridgeProofToolMintThenVerify();
  console.log("OK: bridge proof tool tests");
}

main();
