#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import Ajv from "ajv";

const repoRoot = path.resolve(process.cwd());
const verifyToolPath = path.resolve(repoRoot, "tools", "trust-bundle-verify.mjs");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.resolve(repoRoot, relativePath), "utf8"));
}

function buildValidator() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const anchorSchema = readJson("spec/identity-anchor-v0.4.schema.json");
  const anchorSetSchema = readJson("spec/identity-anchor-set-v0.4.schema.json");
  const revocationSetSchema = readJson("spec/revocation-set-v0.4.schema.json");
  const revocationProofSchema = readJson("spec/revocation-proof-v0.4.schema.json");
  const trustBundleSchema = readJson("spec/trust-bundle-v0.4.schema.json");

  ajv.addSchema(anchorSchema, anchorSchema.$id);
  ajv.addSchema(anchorSetSchema, anchorSetSchema.$id);
  ajv.addSchema(revocationSetSchema, revocationSetSchema.$id);
  ajv.addSchema(revocationProofSchema, revocationProofSchema.$id);
  return ajv.compile(trustBundleSchema);
}

function makeMinimalBundle() {
  return {
    type: "trust_bundle",
    version: "0.4",
    createdAt: 1760500000,
    issuer: "relay://alpha"
  };
}

function makeInvalidRevocationsBundle() {
  return {
    ...makeMinimalBundle(),
    revocations: {
      set: "not-an-object"
    }
  };
}

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function runVerify(bundlePath, envOverrides = {}) {
  const env = {
    ...process.env,
    INTENTOS_PROTOCOL_VERSION: "0.4",
    INTENTOS_TRUST_BUNDLE: "on",
    ...envOverrides
  };
  return spawnSync(process.execPath, [verifyToolPath, "--in", bundlePath], {
    cwd: repoRoot,
    env,
    encoding: "utf8"
  });
}

function parseSummary(stdout) {
  const lines = String(stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return JSON.parse(lines[lines.length - 1] || "{}");
}

function testSchemaValidationForMinimalBundle() {
  const validate = buildValidator();
  const ok = validate(makeMinimalBundle());
  assert.equal(ok, true, `expected minimal bundle valid, got: ${JSON.stringify(validate.errors || [])}`);
}

function testSchemaValidationRejectsWrongRevocationType() {
  const validate = buildValidator();
  const ok = validate(makeInvalidRevocationsBundle());
  assert.equal(ok, false, "expected invalid revocations block to fail schema");
}

function testPolicyEnforceRejectsInvalidBundle() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "aimtp-trust-bundle-enforce-"));
  const bundlePath = path.join(tempDir, "bundle-invalid.json");
  writeJson(bundlePath, makeInvalidRevocationsBundle());

  const result = runVerify(bundlePath, {
    INTENTOS_TRUST_BUNDLE_POLICY: "enforce"
  });
  assert.notEqual(result.status, 0, "enforce mode should reject invalid bundle");
  const summary = parseSummary(result.stdout);
  assert.equal(summary.accepted, false);
  assert.match(String(summary.errors?.[0] || ""), /trust_bundle_invalid/);
}

function testPolicyWarnAllowsWithWarning() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "aimtp-trust-bundle-warn-"));
  const bundlePath = path.join(tempDir, "bundle-invalid.json");
  writeJson(bundlePath, makeInvalidRevocationsBundle());

  const result = runVerify(bundlePath, {
    INTENTOS_TRUST_BUNDLE_POLICY: "warn"
  });
  assert.equal(result.status, 0, `warn mode should not fail, got ${result.status}`);
  const summary = parseSummary(result.stdout);
  assert.equal(summary.accepted, false);
  assert.match(String(summary.warnings?.[0] || ""), /trust_bundle_invalid/);
}

function main() {
  testSchemaValidationForMinimalBundle();
  testSchemaValidationRejectsWrongRevocationType();
  testPolicyEnforceRejectsInvalidBundle();
  testPolicyWarnAllowsWithWarning();
  console.log("OK: trust bundle tests");
}

main();
