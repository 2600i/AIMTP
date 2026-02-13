#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(process.cwd());
const toolPath = path.resolve(repoRoot, "tools", "trust-diag.mjs");

const CONTROLLED_ENV_KEYS = [
  "INTENTOS",
  "INTENTOS_MODE",
  "INTENTOS_TRUST_VERSION",
  "INTENTOS_RECEIPT_POLICY",
  "INTENTOS_TRUST_DISTRIBUTION",
  "INTENTOS_TRUST_BUNDLE_PATH",
  "INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH",
  "INTENTOS_TRUST_HTTP_BUNDLE_URL",
  "INTENTOS_TRUST_HTTP_REVOCATIONS_URL",
  "INTENTOS_TRUST_HTTP_HEAD_URL",
  "INTENTOS_TRUST_HTTP_CHECKPOINT_URL",
  "INTENTOS_TRUST_HTTP_LOGTAIL_URL",
  "INTENTOS_TRUST_SNAPSHOT_POLICY",
  "INTENTOS_TRUST_SNAPSHOT_STATE_PATH",
  "INTENTOS_TRANSPARENCY_LOG_PATH"
];

function runTool(args = [], envOverrides = {}) {
  const env = { ...process.env };
  for (const key of CONTROLLED_ENV_KEYS) {
    delete env[key];
  }
  Object.assign(env, envOverrides);
  return spawnSync(process.execPath, [toolPath, ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8"
  });
}

function parseJsonStdout(result) {
  const raw = String(result.stdout ?? "").trim();
  assert.ok(raw.length > 0, "expected JSON output");
  return JSON.parse(raw);
}

function testCiEmptyEnvHealthy() {
  const result = runTool(["--ci"]);
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stderr}`);
  const parsed = parseJsonStdout(result);

  const requiredKeys = [
    "intentos",
    "mode",
    "trustVersion",
    "receiptPolicy",
    "distribution",
    "snapshot",
    "transparency",
    "proof"
  ];

  for (const key of requiredKeys) {
    assert.ok(Object.prototype.hasOwnProperty.call(parsed, key), `missing key: ${key}`);
  }
  assert.equal(parsed.health, "healthy");
  assert.equal(parsed.exitCode, 0);
}

function testCiMissingLogPathIsMisconfigured() {
  const result = runTool(["--ci"], {
    INTENTOS_TRANSPARENCY_LOG_PATH: "/tmp/aimtp-diag-missing-log.jsonl"
  });
  assert.equal(result.status, 2, `expected exit 2, got ${result.status}\n${result.stderr}`);
  const parsed = parseJsonStdout(result);
  assert.equal(parsed.health, "misconfigured");
  assert.equal(parsed.exitCode, 2);
  assert.ok(Array.isArray(parsed.issues), "expected issues array");
  assert.ok(parsed.issues.some((issue) => issue.code === "missing_path"), "expected missing_path issue");
}

function testCiInvalidSnapshotStateIsInvariantFailed() {
  const tempDir = mkdtempSync(path.join(tmpdir(), "aimtp-trust-diag-test-"));
  const snapshotPath = path.join(tempDir, "snapshot-state.json");

  try {
    writeFileSync(snapshotPath, "{invalid-json", "utf8");
    const result = runTool(["--ci"], {
      INTENTOS_TRUST_SNAPSHOT_STATE_PATH: snapshotPath
    });
    assert.equal(result.status, 3, `expected exit 3, got ${result.status}\n${result.stderr}`);
    const parsed = parseJsonStdout(result);
    assert.equal(parsed.health, "invariant_failed");
    assert.equal(parsed.exitCode, 3);
    assert.ok(
      parsed.issues.some((issue) => issue.code === "snapshot_state_invalid_json"),
      "expected snapshot_state_invalid_json issue"
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function main() {
  testCiEmptyEnvHealthy();
  testCiMissingLogPathIsMisconfigured();
  testCiInvalidSnapshotStateIsInvariantFailed();
  console.log("OK: trust diag tests");
}

main();
