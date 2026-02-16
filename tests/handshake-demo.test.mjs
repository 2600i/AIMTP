#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(process.cwd());
const toolPath = path.resolve(repoRoot, "tools", "handshake-demo.mjs");

function runHandshakeTool(envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  return spawnSync(process.execPath, [toolPath], {
    cwd: repoRoot,
    env,
    encoding: "utf8"
  });
}

function createRevocationSetFile(entries) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimtp-handshake-demo-revocation-"));
  const filePath = path.join(tempDir, "revocations.json");
  const payload = {
    type: "revocations",
    specVersion: "0.4",
    issuer: "relay://tests",
    issuedAt: Math.floor(Date.now() / 1000),
    revocations: entries
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { tempDir, filePath };
}

function testDefaultEnvironmentSkipsHandshake() {
  const result = runHandshakeTool({
    INTENTOS_PROTOCOL_VERSION: "",
    INTENTOS_FEDERATION: ""
  });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stderr}`);
  assert.match(result.stdout, /HANDSHAKE SKIPPED/);
}

function testEnabledEnvironmentRunsHandshake() {
  const result = runHandshakeTool({
    INTENTOS_PROTOCOL_VERSION: "0.4",
    INTENTOS_FEDERATION: "on"
  });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stderr}`);
  assert.match(result.stdout, /HANDSHAKE OK/);
}

function testRevocationWarnAllowsHandshakeWithWarning() {
  const revocations = createRevocationSetFile([
    {
      subject: "peer-alpha",
      kind: "peer",
      revokedAt: Math.floor(Date.now() / 1000),
      reason: "test_warn"
    }
  ]);
  try {
    const result = runHandshakeTool({
      INTENTOS_PROTOCOL_VERSION: "0.4",
      INTENTOS_FEDERATION: "on",
      INTENTOS_REVOCATIONS: "on",
      INTENTOS_REVOCATION_POLICY: "warn",
      INTENTOS_HANDSHAKE_REVOCATION_CASE: "peer",
      INTENTOS_TRUST_DISTRIBUTION: "fs",
      INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH: revocations.filePath
    });
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stderr}`);
    assert.match(result.stdout, /REVOCATION WARN ALLOW OK/);
    assert.match(result.stdout, /HANDSHAKE OK/);
    assert.match(result.stderr, /handshake_revocation_warning/);
    assert.match(result.stderr, /handshake_peer_revoked/);
  } finally {
    fs.rmSync(revocations.tempDir, { recursive: true, force: true });
  }
}

function testRevocationEnforceRejectsHandshake() {
  const revocations = createRevocationSetFile([
    {
      subject: "peer-alpha",
      kind: "peer",
      revokedAt: Math.floor(Date.now() / 1000),
      reason: "test_enforce"
    }
  ]);
  try {
    const result = runHandshakeTool({
      INTENTOS_PROTOCOL_VERSION: "0.4",
      INTENTOS_FEDERATION: "on",
      INTENTOS_REVOCATIONS: "on",
      INTENTOS_REVOCATION_POLICY: "enforce",
      INTENTOS_HANDSHAKE_REVOCATION_CASE: "peer",
      INTENTOS_TRUST_DISTRIBUTION: "fs",
      INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH: revocations.filePath
    });
    assert.notEqual(result.status, 0, "expected enforce mode revocation to fail");
    assert.match(result.stderr, /handshake_peer_revoked/);
  } finally {
    fs.rmSync(revocations.tempDir, { recursive: true, force: true });
  }
}

function main() {
  testDefaultEnvironmentSkipsHandshake();
  testEnabledEnvironmentRunsHandshake();
  testRevocationWarnAllowsHandshakeWithWarning();
  testRevocationEnforceRejectsHandshake();
  console.log("OK: handshake demo tests");
}

main();
