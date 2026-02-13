#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

const repoRoot = path.resolve(process.cwd());
const toolPath = path.resolve(repoRoot, "tools", "identity-anchor-fetch.mjs");

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

function makeAnchorSet() {
  return {
    type: "identity-anchors",
    protocolVersion: "0.4",
    anchors: [
      {
        type: "IdentityAnchor",
        protocolVersion: "0.4",
        anchorId: "anchor-local-1",
        peerId: "peer-alpha",
        publicKeyPem: "-----BEGIN PUBLIC KEY-----\\nanchor1\\n-----END PUBLIC KEY-----\\n",
        timestamp: "2026-02-13T00:00:00.000Z"
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
    INTENTOS_IDENTITY: "",
    INTENTOS_TRUST_DISTRIBUTION: ""
  });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stderr}`);
  assert.match(result.stdout, /FETCH SKIPPED/);
}

function testFilesystemDistributionFetchesAnchors() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "aimtp-anchor-fetch-fs-"));
  const anchorPath = path.join(tempDir, "identity-anchors.json");
  writeJson(anchorPath, makeAnchorSet());

  const result = runFetchTool({
    INTENTOS_PROTOCOL_VERSION: "0.4",
    INTENTOS_IDENTITY: "on",
    INTENTOS_TRUST_DISTRIBUTION: "fs",
    INTENTOS_TRUST_IDENTITY_ANCHORS_PATH: anchorPath,
    INTENTOS_TRUST_HTTP_IDENTITY_ANCHORS_URL: "",
    INTENTOS_RECEIPT_POLICY: "off"
  });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stderr}`);
  assert.match(result.stdout, /FETCH OK count=1/);
}

function startServer(payload) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if ((req.url ?? "/") !== "/anchors.json") {
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

async function testHttpDistributionFetchesAnchors() {
  const server = await startServer(makeAnchorSet());
  try {
    const address = server.address();
    assert(address && typeof address === "object", "expected bound HTTP server address");
    const url = `http://127.0.0.1:${address.port}/anchors.json`;

    const result = await runFetchToolAsync({
      INTENTOS_PROTOCOL_VERSION: "0.4",
      INTENTOS_IDENTITY: "on",
      INTENTOS_TRUST_DISTRIBUTION: "http",
      INTENTOS_TRUST_HTTP_IDENTITY_ANCHORS_URL: url,
      INTENTOS_TRUST_IDENTITY_ANCHORS_PATH: "",
      INTENTOS_RECEIPT_POLICY: "off"
    });
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stderr}`);
    assert.match(result.stdout, /FETCH OK count=1/);
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

function testInvalidJsonRejectsInEnforceMode() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "aimtp-anchor-fetch-invalid-"));
  const badPath = path.join(tempDir, "identity-anchors-bad.json");
  fs.writeFileSync(badPath, "{ invalid-json\n", "utf8");

  const result = runFetchTool({
    INTENTOS_PROTOCOL_VERSION: "0.4",
    INTENTOS_IDENTITY: "on",
    INTENTOS_TRUST_DISTRIBUTION: "fs",
    INTENTOS_TRUST_IDENTITY_ANCHORS_PATH: badPath,
    INTENTOS_RECEIPT_POLICY: "enforce"
  });

  assert.notEqual(result.status, 0, "invalid JSON should fail in enforce mode");
  assert.match(result.stderr, /identity_anchor_fetch_invalid_json/);
}

async function main() {
  testDefaultEnvironmentSkipsFetch();
  testFilesystemDistributionFetchesAnchors();
  await testHttpDistributionFetchesAnchors();
  testInvalidJsonRejectsInEnforceMode();
  console.log("OK: identity anchor fetch tests");
}

main();
