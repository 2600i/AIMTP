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

const AUDITED_GATE_DEFAULTS = {
  INTENTOS_PROTOCOL_VERSION: "unset",
  INTENTOS_FEDERATION: "off",
  INTENTOS_IDENTITY: "off",
  INTENTOS_HANDSHAKE_PEER_VERIFY: "off",
  INTENTOS_HANDSHAKE_NEGOTIATION: "off",
  INTENTOS_HANDSHAKE_SEND_ANCHORS: "off",
  INTENTOS_HANDSHAKE_REVOCATION_CASE: "off",
  INTENTOS_REVOCATIONS: "off",
  INTENTOS_REVOCATION_POLICY: "off",
  INTENTOS_REVOCATION_PROOF: "off",
  INTENTOS_TRUST_DISTRIBUTION: "off",
  INTENTOS_TRUST_BUNDLE: "off",
  INTENTOS_TRUST_BUNDLE_POLICY: "off",
  INTENTOS_IDENTITY_POLICY: "off",
  INTENTOS_IDENTITY_MAX_TIMESTAMP_SKEW_SEC: "300"
};

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
  "INTENTOS_TRUST_SNAPSHOT_STATE_PATH",
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

function normalizeDocumentedDefault(value) {
  return String(value)
    .replace(/`/g, "")
    .replace(/\s+\(documented\)\s*$/i, "")
    .trim();
}

function docsGateDefaultRows() {
  const gateDocPath = path.resolve(repoRoot, "docs", "0.4-gates.md");
  const rows = [];
  for (const line of fs.readFileSync(gateDocPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("| `INTENTOS_")) {
      continue;
    }
    const columns = trimmed
      .split("|")
      .slice(1, -1)
      .map((entry) => entry.trim());
    if (columns.length < 3) {
      continue;
    }
    rows.push({
      envVar: normalizeDocumentedDefault(columns[0]),
      defaultValue: normalizeDocumentedDefault(columns[2])
    });
  }
  return rows;
}

function buildExplicitDefaultEnv() {
  const env = {};
  for (const [envVar, defaultValue] of Object.entries(AUDITED_GATE_DEFAULTS)) {
    if (defaultValue === "unset") {
      continue;
    }
    env[envVar] = defaultValue;
  }
  return env;
}

function assertDistributionLoadersInert(env, context) {
  const anchors = loadIdentityAnchorsFromDistribution(env);
  assert.equal(anchors.skipped, true, `${context}: anchors should be skipped`);
  assert.equal(anchors.mode, "off", `${context}: anchor mode should be off`);
  assert.equal(anchors.anchorCount, 0, `${context}: anchor count should be zero`);

  const revocations = loadRevocationsFromDistribution(env);
  assert.equal(revocations.skipped, true, `${context}: revocations should be skipped`);
  assert.equal(revocations.mode, "off", `${context}: revocation mode should be off`);
  assert.equal(revocations.accepted, true, `${context}: revocations should be accepted in inert mode`);
  assert.equal(revocations.revocationCount, 0, `${context}: revocation count should be zero`);

  const bundle = loadTrustBundleFromDistribution(env);
  assert.equal(bundle.skipped, true, `${context}: trust bundle should be skipped`);
  assert.equal(bundle.mode, "off", `${context}: trust bundle mode should be off`);
  assert.equal(bundle.accepted, true, `${context}: trust bundle should be accepted in inert mode`);
  assert.equal(bundle.bundle, null, `${context}: no trust bundle should be loaded`);
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
  assertDistributionLoadersInert({}, "baseline");
  assertDistributionLoadersInert(buildExplicitDefaultEnv(), "explicit-defaults");
}

function testEachGateDefaultValueIsInert() {
  for (const [envVar, defaultValue] of Object.entries(AUDITED_GATE_DEFAULTS)) {
    const env = {};
    if (defaultValue !== "unset") {
      env[envVar] = defaultValue;
    }
    assertDistributionLoadersInert(env, `${envVar}=${defaultValue}`);
  }
}

function testGateDefaultsDocumentedExactlyOnce() {
  const rows = docsGateDefaultRows();
  const perEnvCount = new Map();
  for (const row of rows) {
    perEnvCount.set(row.envVar, (perEnvCount.get(row.envVar) || 0) + 1);
  }

  for (const [envVar, expectedDefault] of Object.entries(AUDITED_GATE_DEFAULTS)) {
    assert.equal(perEnvCount.get(envVar), 1, `expected one table row for ${envVar}`);
    const row = rows.find((entry) => entry.envVar === envVar);
    assert.ok(row, `missing docs row for ${envVar}`);
    assert.equal(row.defaultValue, expectedDefault, `unexpected documented default for ${envVar}`);
  }
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

function testDefaultToolPathsAreInertAndStateSafe(envOverrides = {}) {
  const handshake = runTool("tools/handshake-demo.mjs", [], envOverrides);
  assert.equal(handshake.status, 0, `expected handshake-demo exit 0, got ${handshake.status}\n${handshake.stderr}`);
  assert.match(handshake.stdout, /HANDSHAKE SKIPPED/);

  const anchor = runTool("tools/identity-anchor-demo.mjs", [], envOverrides);
  assert.equal(anchor.status, 0, `expected identity-anchor-demo exit 0, got ${anchor.status}\n${anchor.stderr}`);
  assert.match(anchor.stdout, /ANCHOR SKIPPED/);

  const revocationFetch = runTool("tools/revocation-fetch.mjs", [], envOverrides);
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

  const verifyBundle = runTool("tools/trust-bundle-verify.mjs", ["--in", bundlePath], envOverrides);
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
  ], envOverrides);
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
  testEachGateDefaultValueIsInert();
  testGateDefaultsDocumentedExactlyOnce();
  testDefaultTrustDiagReportsNaOrDisabled();
  testDefaultToolPathsAreInertAndStateSafe();
  testDefaultToolPathsAreInertAndStateSafe(buildExplicitDefaultEnv());
  console.log("OK: 0.4 defaults inert tests");
}

main();
