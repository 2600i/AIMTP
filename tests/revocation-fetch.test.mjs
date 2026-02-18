#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

const repoRoot = path.resolve(process.cwd());
const toolPath = path.resolve(repoRoot, "tools", "revocation-fetch.mjs");

function runFetchTool(envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  return spawnSync(process.execPath, [toolPath], {
    cwd: repoRoot,
    env,
    encoding: "utf8"
  });
}

function runFetchToolAsync(envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [toolPath], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function parseSummary(stdout) {
  const lines = String(stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines[lines.length - 1] || "{}";
  return JSON.parse(last);
}

function parseWarnEvents(stderr) {
  return String(stderr || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry && entry.event === "intentos_revocation_distribution");
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
        reason: "policy_violation",
        evidence: "ticket-42"
      }
    ]
  };
}

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function testDefaultEnvironmentSkipsFetch() {
  const result = runFetchTool({
    INTENTOS_PROTOCOL_VERSION: "",
    INTENTOS_REVOCATIONS: "",
    INTENTOS_TRUST_DISTRIBUTION: "",
    INTENTOS_REVOCATION_POLICY: ""
  });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stderr}`);
  const summary = parseSummary(result.stdout);
  assert.equal(summary.skipped, true);
  assert.equal(summary.accepted, true);
  assert.equal(summary.revocationCount, 0);
}

function testValidSchemaSuccessAcrossPolicyModes() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "aimtp-revocation-fetch-valid-"));
  const revocationPath = path.join(tempDir, "revocations.json");
  writeJson(revocationPath, makeRevocationSet());

  for (const policyMode of ["off", "warn", "enforce"]) {
    const result = runFetchTool({
      INTENTOS_PROTOCOL_VERSION: "0.4",
      INTENTOS_REVOCATIONS: "on",
      INTENTOS_TRUST_DISTRIBUTION: "fs",
      INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH: revocationPath,
      INTENTOS_TRUST_HTTP_REVOCATIONS_URL: "",
      INTENTOS_REVOCATION_POLICY: policyMode
    });
    assert.equal(result.status, 0, `expected ${policyMode} mode success, got ${result.status}\n${result.stderr}`);
    const summary = parseSummary(result.stdout);
    assert.equal(summary.skipped, false);
    assert.equal(summary.accepted, true);
    if (policyMode === "off") {
      assert.equal(summary.revocationCount, 0);
    } else {
      assert.equal(summary.revocationCount, 1);
    }
  }
}

function testInvalidSchemaWarnAndEnforceBehavior() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "aimtp-revocation-fetch-invalid-schema-"));
  const badPath = path.join(tempDir, "revocations-invalid-schema.json");
  const badSet = {
    ...makeRevocationSet(),
    revocations: [
      {
        kind: "peer",
        revokedAt: 1760400001
      }
    ]
  };
  writeJson(badPath, badSet);

  const warnResult = runFetchTool({
    INTENTOS_PROTOCOL_VERSION: "0.4",
    INTENTOS_REVOCATIONS: "on",
    INTENTOS_TRUST_DISTRIBUTION: "fs",
    INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH: badPath,
    INTENTOS_REVOCATION_POLICY: "warn"
  });
  assert.equal(warnResult.status, 0, `expected warn mode success, got ${warnResult.status}\n${warnResult.stderr}`);
  const warnSummary = parseSummary(warnResult.stdout);
  assert.equal(warnSummary.accepted, false);
  assert.equal(warnSummary.revocationCount, 0);
  assert.match(String(warnSummary.warnings?.[0] || ""), /revocation_fetch_schema_invalid/);
  const warnEvents = parseWarnEvents(warnResult.stderr);
  assert.equal(warnEvents.length, 1, `expected one warning event, got ${warnEvents.length}`);

  const enforceResult = runFetchTool({
    INTENTOS_PROTOCOL_VERSION: "0.4",
    INTENTOS_REVOCATIONS: "on",
    INTENTOS_TRUST_DISTRIBUTION: "fs",
    INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH: badPath,
    INTENTOS_REVOCATION_POLICY: "enforce"
  });
  assert.notEqual(enforceResult.status, 0, "invalid schema should fail in enforce mode");
  const enforceSummary = parseSummary(enforceResult.stdout);
  assert.equal(enforceSummary.accepted, false);
  assert.match(String(enforceSummary.errors?.[0] || ""), /revocation_fetch_schema_invalid/);

  const offResult = runFetchTool({
    INTENTOS_PROTOCOL_VERSION: "0.4",
    INTENTOS_REVOCATIONS: "on",
    INTENTOS_TRUST_DISTRIBUTION: "fs",
    INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH: badPath,
    INTENTOS_REVOCATION_POLICY: "off"
  });
  assert.equal(offResult.status, 0, `expected off mode success, got ${offResult.status}\n${offResult.stderr}`);
  const offSummary = parseSummary(offResult.stdout);
  assert.equal(offSummary.accepted, true);
  assert.equal(offSummary.revocationCount, 0);
  assert.equal(parseWarnEvents(offResult.stderr).length, 0);
}

function testInvalidJsonWarnAndEnforceBehavior() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "aimtp-revocation-fetch-invalid-json-"));
  const badPath = path.join(tempDir, "revocations-invalid-json.json");
  fs.writeFileSync(badPath, "{ invalid-json\n", "utf8");

  const warnResult = runFetchTool({
    INTENTOS_PROTOCOL_VERSION: "0.4",
    INTENTOS_REVOCATIONS: "on",
    INTENTOS_TRUST_DISTRIBUTION: "fs",
    INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH: badPath,
    INTENTOS_REVOCATION_POLICY: "warn"
  });
  assert.equal(warnResult.status, 0, `expected warn mode success, got ${warnResult.status}\n${warnResult.stderr}`);
  const warnSummary = parseSummary(warnResult.stdout);
  assert.equal(warnSummary.accepted, false);
  assert.match(String(warnSummary.warnings?.[0] || ""), /revocation_fetch_invalid_json/);
  const warnEvents = parseWarnEvents(warnResult.stderr);
  assert.equal(warnEvents.length, 1, `expected one warning event, got ${warnEvents.length}`);

  const enforceResult = runFetchTool({
    INTENTOS_PROTOCOL_VERSION: "0.4",
    INTENTOS_REVOCATIONS: "on",
    INTENTOS_TRUST_DISTRIBUTION: "fs",
    INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH: badPath,
    INTENTOS_REVOCATION_POLICY: "enforce"
  });
  assert.notEqual(enforceResult.status, 0, "invalid JSON should fail in enforce mode");
  const enforceSummary = parseSummary(enforceResult.stdout);
  assert.equal(enforceSummary.accepted, false);
  assert.match(String(enforceSummary.errors?.[0] || ""), /revocation_fetch_invalid_json/);
}

function startServer(payload) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if ((req.url ?? "/") !== "/revocations.json") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function testHttpDistributionFetchesRevocations() {
  const server = await startServer(makeRevocationSet());
  try {
    const address = server.address();
    assert(address && typeof address === "object", "expected bound HTTP server address");
    const url = `http://127.0.0.1:${address.port}/revocations.json`;
    const result = await runFetchToolAsync({
      INTENTOS_PROTOCOL_VERSION: "0.4",
      INTENTOS_REVOCATIONS: "on",
      INTENTOS_TRUST_DISTRIBUTION: "http",
      INTENTOS_TRUST_HTTP_REVOCATIONS_URL: url,
      INTENTOS_REVOCATION_POLICY: "enforce"
    });
    assert.equal(result.status, 0, `expected http fetch success, got ${result.status}\n${result.stderr}`);
    const summary = parseSummary(result.stdout);
    assert.equal(summary.accepted, true);
    assert.equal(summary.revocationCount, 1);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

async function main() {
  testDefaultEnvironmentSkipsFetch();
  testValidSchemaSuccessAcrossPolicyModes();
  testInvalidSchemaWarnAndEnforceBehavior();
  testInvalidJsonWarnAndEnforceBehavior();
  await testHttpDistributionFetchesRevocations();
  console.log("OK: revocation fetch tests");
}

main();
