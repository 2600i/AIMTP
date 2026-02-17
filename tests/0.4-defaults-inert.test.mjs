#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import Ajv from "ajv";

const repoRoot = path.resolve(process.cwd());
const require = createRequire(import.meta.url);

const {
  loadIdentityAnchorsFromDistribution
} = require("../dist/runtime/intentos/identity-anchor-distribution.js");
const {
  loadRevocationsFromDistribution
} = require("../dist/runtime/intentos/revocation-distribution.js");
const {
  loadTrustBundleFromDistribution
} = require("../dist/runtime/intentos/trust-bundle-distribution.js");

const GATE_ENV_KEYS = [
  "INTENTOS_PROTOCOL_VERSION",
  "INTENTOS_FEDERATION",
  "INTENTOS_IDENTITY",
  "INTENTOS_HANDSHAKE_PEER_VERIFY",
  "INTENTOS_HANDSHAKE_NEGOTIATION",
  "INTENTOS_HANDSHAKE_SEND_ANCHORS",
  "INTENTOS_HANDSHAKE_REVOCATION_CASE",
  "INTENTOS_REVOCATIONS",
  "INTENTOS_REVOCATION_POLICY",
  "INTENTOS_REVOCATION_PROOF",
  "INTENTOS_TRUST_DISTRIBUTION",
  "INTENTOS_TRUST_BUNDLE",
  "INTENTOS_TRUST_BUNDLE_POLICY",
  "INTENTOS_TRUST_BUNDLE_PATH",
  "INTENTOS_TRUST_HTTP_BUNDLE_URL",
  "INTENTOS_TRUST_IDENTITY_ANCHORS_PATH",
  "INTENTOS_TRUST_HTTP_IDENTITY_ANCHORS_URL",
  "INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH",
  "INTENTOS_TRUST_HTTP_REVOCATIONS_URL",
  "INTENTOS_TRUST_BUNDLE_REVOCATIONS_PROOF_PATH",
  "INTENTOS_TRUST_HTTP_REVOCATIONS_PROOF_URL",
  "INTENTOS_TRUSTED_REVOCATION_KEYS_JSON",
  "INTENTOS_RECEIPT_POLICY",
  "INTENTOS_IDENTITY_POLICY",
  "INTENTOS_IDENTITY_MAX_TIMESTAMP_SKEW_SEC"
];

function gateClearedEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const key of GATE_ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      continue;
    }
    delete env[key];
  }
  return env;
}

function runTool(relativePath, args = [], envOverrides = {}) {
  const toolPath = path.resolve(repoRoot, relativePath);
  return spawnSync(process.execPath, [toolPath, ...args], {
    cwd: repoRoot,
    env: gateClearedEnv(envOverrides),
    encoding: "utf8"
  });
}

function parseLastJsonLine(stdoutText) {
  const line = String(stdoutText || "")
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .pop();
  assert.ok(line, "expected JSON output line");
  return JSON.parse(line);
}

function testHandshakeSchemaOptionalFieldsRemainOptional() {
  const schemaPath = path.resolve(repoRoot, "spec", "federation-handshake-v0.4.schema.json");
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));

  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);

  const hello = {
    type: "HandshakeHello",
    protocolVersion: "0.4",
    helloId: "hello-minimal",
    senderPeerId: "peer-a",
    recipientPeerId: "peer-b",
    nonce: "nonce-minimal",
    timestamp: new Date().toISOString()
  };
  assert.equal(Object.prototype.hasOwnProperty.call(hello, "identityAnchorSetId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(hello, "identityAnchorsInline"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(hello, "peerProof"), false);
  assert.equal(validate(hello), true, `hello should validate: ${(validate.errors || []).map((e) => e.message).join("; ")}`);

  const ack = {
    type: "HandshakeAck",
    protocolVersion: "0.4",
    helloId: hello.helloId,
    senderPeerId: "peer-b",
    recipientPeerId: "peer-a",
    nonce: hello.nonce,
    helloTimestamp: hello.timestamp,
    accepted: true,
    acceptedIdentityAnchors: false,
    resolvedAnchorSetId: null,
    capabilitiesAccepted: [],
    capabilitiesMissing: [],
    timestamp: new Date().toISOString()
  };
  assert.equal(validate(ack), true, `ack should validate: ${(validate.errors || []).map((e) => e.message).join("; ")}`);
}

function testDistributionLoadersDisabledByDefault() {
  const env = {};

  const anchors = loadIdentityAnchorsFromDistribution(env);
  assert.equal(anchors.skipped, true);
  assert.equal(anchors.mode, "off");
  assert.equal(anchors.anchorCount, 0);

  const revocations = loadRevocationsFromDistribution(env);
  assert.equal(revocations.skipped, true);
  assert.equal(revocations.mode, "off");
  assert.equal(revocations.accepted, true);
  assert.equal(revocations.revocationCount, 0);

  const bundle = loadTrustBundleFromDistribution(env);
  assert.equal(bundle.skipped, true);
  assert.equal(bundle.mode, "off");
  assert.equal(bundle.accepted, true);
  assert.equal(bundle.bundle, null);
}

function testDefaultTrustDiagReportsNaOrDisabled() {
  const result = runTool("tools/trust-diag.mjs", ["--json"]);
  assert.equal(result.status, 0, `expected trust-diag exit 0, got ${result.status}\n${result.stderr}`);

  const report = JSON.parse(String(result.stdout || "").trim());
  assert.equal(report.distribution.mode, "off");
  assert.equal(report.distribution.target, "n/a");
  assert.equal(report.snapshot.path, "n/a");
  assert.equal(report.contentIds.bundleId, "n/a");
  assert.equal(report.contentIds.revocationsId, "n/a");
}

function testDefaultToolPathsAreInertAndStateSafe() {
  const handshake = runTool("tools/handshake-demo.mjs");
  assert.equal(handshake.status, 0, `expected handshake-demo exit 0, got ${handshake.status}\n${handshake.stderr}`);
  assert.match(handshake.stdout, /HANDSHAKE SKIPPED/);

  const anchor = runTool("tools/identity-anchor-demo.mjs");
  assert.equal(anchor.status, 0, `expected identity-anchor-demo exit 0, got ${anchor.status}\n${anchor.stderr}`);
  assert.match(anchor.stdout, /ANCHOR SKIPPED/);

  const revocationFetch = runTool("tools/revocation-fetch.mjs");
  assert.equal(revocationFetch.status, 0, `expected revocation-fetch exit 0, got ${revocationFetch.status}\n${revocationFetch.stderr}`);
  const revocationSummary = parseLastJsonLine(revocationFetch.stdout);
  assert.equal(revocationSummary.skipped, true);
  assert.equal(revocationSummary.accepted, true);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimtp-04-defaults-inert-"));
  const bundlePath = path.join(tempDir, "bundle.json");
  const storeDir = path.join(tempDir, "store");
  fs.writeFileSync(
    bundlePath,
    `${JSON.stringify({ type: "trust_bundle", version: "0.4", createdAt: 1760600000, issuer: "relay://test" }, null, 2)}\n`,
    "utf8"
  );

  const verifyBundle = runTool("tools/trust-bundle-verify.mjs", ["--in", bundlePath]);
  assert.equal(verifyBundle.status, 0, `expected trust-bundle-verify exit 0, got ${verifyBundle.status}\n${verifyBundle.stderr}`);
  const verifySummary = parseLastJsonLine(verifyBundle.stdout);
  assert.equal(verifySummary.skipped, true);
  assert.equal(verifySummary.accepted, true);

  const applyBundle = runTool("tools/trust-bundle-apply.mjs", [
    "--in",
    bundlePath,
    "--store",
    storeDir,
    "--policy",
    "off",
    "--ci"
  ]);
  assert.equal(applyBundle.status, 0, `expected trust-bundle-apply exit 0, got ${applyBundle.status}\n${applyBundle.stderr}`);
  const applySummary = parseLastJsonLine(applyBundle.stdout);
  assert.equal(applySummary.applied, false);
  assert.equal(Array.isArray(applySummary.pathsWritten), true);
  assert.equal(applySummary.pathsWritten.length, 0);
  assert.equal(fs.existsSync(storeDir), false, "policy off should not create store artifacts");
}

function main() {
  testHandshakeSchemaOptionalFieldsRemainOptional();
  testDistributionLoadersDisabledByDefault();
  testDefaultTrustDiagReportsNaOrDisabled();
  testDefaultToolPathsAreInertAndStateSafe();
  console.log("OK: 0.4 defaults inert tests");
}

main();
