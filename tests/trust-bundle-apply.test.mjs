#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(process.cwd());
const toolPath = path.resolve(repoRoot, "tools", "trust-bundle-apply.mjs");

function runTool(args, envOverrides = {}) {
  return spawnSync(process.execPath, [toolPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...envOverrides },
    encoding: "utf8"
  });
}

function parseJsonLine(stdout) {
  const text = String(stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .pop();
  assert.ok(text, "expected JSON output line");
  return JSON.parse(text);
}

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function makeMinimalBundle() {
  return {
    type: "trust_bundle",
    version: "0.4",
    createdAt: 1760600000,
    issuer: "relay://alpha"
  };
}

function testApplyMinimalBundleWritesFiles() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "aimtp-trust-bundle-apply-"));
  const bundlePath = path.join(tempDir, "bundle.json");
  const storeDir = path.join(tempDir, "snapshot-store");
  writeJson(bundlePath, makeMinimalBundle());

  const result = runTool([
    "--in",
    bundlePath,
    "--store",
    storeDir,
    "--policy",
    "enforce",
    "--ci"
  ]);
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stderr}`);

  const report = parseJsonLine(result.stdout);
  assert.equal(report.health, "healthy");
  assert.equal(report.exitCode, 0);
  assert.equal(report.applied, true);
  assert.ok(Array.isArray(report.pathsWritten));
  assert.ok(report.pathsWritten.length >= 2, "expected bundle + snapshot state files");

  const statePath = path.join(storeDir, "snapshot-state.json");
  const artifactPath = path.join(storeDir, "bundle-artifacts", "trust-bundle-v0.4.json");
  assert.ok(fs.existsSync(statePath), "expected snapshot state file");
  assert.ok(fs.existsSync(artifactPath), "expected bundled artifact file");
}

function testInvalidBundleInEnforceFailsInvariant() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "aimtp-trust-bundle-apply-invalid-"));
  const bundlePath = path.join(tempDir, "bundle-invalid.json");
  writeJson(bundlePath, {
    ...makeMinimalBundle(),
    revocations: {
      set: "bad-type"
    }
  });

  const result = runTool([
    "--in",
    bundlePath,
    "--store",
    path.join(tempDir, "store"),
    "--policy",
    "enforce",
    "--ci"
  ]);
  assert.equal(result.status, 3, `expected exit 3, got ${result.status}\n${result.stderr}`);

  const report = parseJsonLine(result.stdout);
  assert.equal(report.health, "invariant_failed");
  assert.equal(report.exitCode, 3);
  assert.equal(report.applied, false);
  assert.ok(report.issues.some((issue) => issue.code === "trust_bundle_invalid"));
}

function testMissingInputFileIsMisconfigured() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "aimtp-trust-bundle-apply-missing-"));
  const missingPath = path.join(tempDir, "does-not-exist.json");

  const result = runTool([
    "--in",
    missingPath,
    "--store",
    path.join(tempDir, "store"),
    "--ci"
  ]);
  assert.equal(result.status, 2, `expected exit 2, got ${result.status}\n${result.stderr}`);

  const report = parseJsonLine(result.stdout);
  assert.equal(report.health, "misconfigured");
  assert.equal(report.exitCode, 2);
  assert.equal(report.applied, false);
  assert.ok(report.issues.some((issue) => issue.code === "input_unreadable"));
}

function testCiOutputShapeStable() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "aimtp-trust-bundle-apply-ci-"));
  const bundlePath = path.join(tempDir, "bundle.json");
  writeJson(bundlePath, makeMinimalBundle());

  const result = runTool([
    "--in",
    bundlePath,
    "--store",
    path.join(tempDir, "store"),
    "--policy",
    "off",
    "--ci"
  ]);
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stderr}`);

  const report = parseJsonLine(result.stdout);
  for (const key of ["health", "exitCode", "issues", "applied"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(report, key), `missing ci key: ${key}`);
  }
}

function main() {
  testApplyMinimalBundleWritesFiles();
  testInvalidBundleInEnforceFailsInvariant();
  testMissingInputFileIsMisconfigured();
  testCiOutputShapeStable();
  console.log("OK: trust bundle apply tests");
}

main();
