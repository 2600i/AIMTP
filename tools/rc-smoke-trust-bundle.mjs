#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function dirnameFromImportMeta() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function repoRoot() {
  return path.resolve(dirnameFromImportMeta(), "..");
}

function parseArgs(argv) {
  const options = {
    dir: path.join(os.tmpdir(), `aimtp-rc-smoke-bundle-${process.pid}`)
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --dir");
      }
      options.dir = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return options;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runNodeTool(relativeToolPath, args, env = {}) {
  const absoluteToolPath = path.resolve(repoRoot(), relativeToolPath);
  return spawnSync(process.execPath, [absoluteToolPath, ...args], {
    cwd: repoRoot(),
    env: {
      ...process.env,
      ...env
    },
    encoding: "utf8"
  });
}

function parseLastJsonLine(stdoutText) {
  const line = String(stdoutText || "")
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .pop();
  if (!line) {
    throw new Error("missing_json_output");
  }
  return JSON.parse(line);
}

function ensureExitZero(result, stepName) {
  if (result.status === 0) {
    return;
  }
  const detail = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  throw new Error(`${stepName} failed (exit ${result.status}): ${detail}`);
}

function summarize(results, demoDir) {
  console.log("\nTrust bundle smoke summary");
  for (const result of results) {
    const prefix = result.ok ? "PASS" : "FAIL";
    const detail = result.detail ? `: ${result.detail}` : "";
    console.log(`${prefix} ${result.step}${detail}`);
  }
  console.log(`demoDir: ${demoDir}`);
}

async function startLocalServer(validBundleText) {
  const invalidBundleText = "{ invalid_json: true";
  const server = http.createServer((req, res) => {
    const requestPath = new URL(req.url || "/", "http://127.0.0.1").pathname;
    if (requestPath === "/bundle.json") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(validBundleText);
      return;
    }
    if (requestPath === "/bundle-invalid.json") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(invalidBundleText);
      return;
    }
    res.statusCode = 404;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("not found");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  assert(address && typeof address === "object", "expected local server address");
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

async function closeServer(server) {
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

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`http_status_${response.status}`);
  }
  return response.text();
}

function makeIdentityAnchorSet() {
  const { publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString("utf8");
  return {
    type: "identity-anchors",
    protocolVersion: "0.4",
    setId: "smoke-anchor-set",
    anchors: [
      {
        type: "IdentityAnchor",
        protocolVersion: "0.4",
        anchorId: "smoke-anchor-1",
        peerId: "peer-smoke",
        publicKeyPem,
        timestamp: new Date().toISOString()
      }
    ]
  };
}

function makeRevocationSet() {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    type: "revocations",
    specVersion: "0.4",
    issuer: "relay://smoke",
    issuedAt: nowSec,
    revocations: [
      {
        subject: "peer-smoke-revoked",
        kind: "peer",
        revokedAt: nowSec
      }
    ]
  };
}

function makeTransparencyHead() {
  return {
    size: 0,
    chainHash: "sha256:smoke"
  };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`FAIL args: ${message}`);
    process.exit(1);
    return;
  }

  const demoDir = options.dir;
  const results = [];
  let serverRef = null;

  const step = async (name, fn) => {
    try {
      const detail = await fn();
      results.push({
        step: name,
        ok: true,
        detail: detail || ""
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        step: name,
        ok: false,
        detail: message
      });
      throw error;
    }
  };

  try {
    const anchorSetPath = path.join(demoDir, "identity-anchors.json");
    const revocationSetPath = path.join(demoDir, "revocations.json");
    const transparencyHeadPath = path.join(demoDir, "transparency-head.json");
    const bundlePath = path.join(demoDir, "trust-bundle.json");
    const httpBundlePath = path.join(demoDir, "trust-bundle-http.json");
    const invalidBundlePath = path.join(demoDir, "trust-bundle-invalid.json");
    const fsStoreDir = path.join(demoDir, "store-fs");
    const httpStoreDir = path.join(demoDir, "store-http");
    const invalidStoreDir = path.join(demoDir, "store-invalid");

    await step("setup demo dir", async () => {
      fs.rmSync(demoDir, { recursive: true, force: true });
      fs.mkdirSync(demoDir, { recursive: true });
      writeJson(anchorSetPath, makeIdentityAnchorSet());
      writeJson(revocationSetPath, makeRevocationSet());
      writeJson(transparencyHeadPath, makeTransparencyHead());
      return demoDir;
    });

    await step("pack minimal trust bundle", async () => {
      const result = runNodeTool("tools/trust-bundle-pack.mjs", [
        "--out",
        bundlePath,
        "--issuer",
        "relay://smoke-bundle",
        "--identity-anchors-set",
        anchorSetPath,
        "--revocations-set",
        revocationSetPath,
        "--transparency-head",
        transparencyHeadPath
      ]);
      ensureExitZero(result, "trust-bundle-pack");
      return "bundle created";
    });

    await step("FS distribution apply + verify", async () => {
      const verifyResult = runNodeTool(
        "tools/trust-bundle-verify.mjs",
        ["--in", bundlePath],
        {
          INTENTOS_PROTOCOL_VERSION: "0.4",
          INTENTOS_TRUST_BUNDLE: "on",
          INTENTOS_TRUST_BUNDLE_POLICY: "enforce"
        }
      );
      ensureExitZero(verifyResult, "trust-bundle-verify(fs)");
      const verifySummary = parseLastJsonLine(verifyResult.stdout);
      assert.equal(verifySummary.accepted, true, "expected fs verify accepted=true");

      const applyResult = runNodeTool("tools/trust-bundle-apply.mjs", [
        "--in",
        bundlePath,
        "--store",
        fsStoreDir,
        "--policy",
        "enforce",
        "--ci"
      ]);
      ensureExitZero(applyResult, "trust-bundle-apply(fs)");
      const applySummary = parseLastJsonLine(applyResult.stdout);
      assert.equal(applySummary.applied, true, "expected fs apply applied=true");

      const statePath = path.join(fsStoreDir, "snapshot-state.json");
      assert.equal(fs.existsSync(statePath), true, "expected fs snapshot-state.json");
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      assert.equal(typeof state.bundleId, "string", "expected fs state bundleId");
      assert.equal(typeof state.appliedSnapshotId, "string", "expected fs state appliedSnapshotId");
      return "bundle applied from fs";
    });

    await step("start local HTTP distribution server", async () => {
      const bundleText = fs.readFileSync(bundlePath, "utf8");
      serverRef = await startLocalServer(bundleText);
      return serverRef.baseUrl;
    });

    await step("HTTP distribution apply + verify", async () => {
      assert(serverRef, "server not started");
      const fetched = await fetchText(`${serverRef.baseUrl}/bundle.json`);
      fs.writeFileSync(httpBundlePath, fetched, "utf8");

      const verifyResult = runNodeTool(
        "tools/trust-bundle-verify.mjs",
        ["--in", httpBundlePath],
        {
          INTENTOS_PROTOCOL_VERSION: "0.4",
          INTENTOS_TRUST_BUNDLE: "on",
          INTENTOS_TRUST_BUNDLE_POLICY: "enforce"
        }
      );
      ensureExitZero(verifyResult, "trust-bundle-verify(http)");
      const verifySummary = parseLastJsonLine(verifyResult.stdout);
      assert.equal(verifySummary.accepted, true, "expected http verify accepted=true");

      const applyResult = runNodeTool("tools/trust-bundle-apply.mjs", [
        "--in",
        httpBundlePath,
        "--store",
        httpStoreDir,
        "--policy",
        "enforce",
        "--ci"
      ]);
      ensureExitZero(applyResult, "trust-bundle-apply(http)");
      const applySummary = parseLastJsonLine(applyResult.stdout);
      assert.equal(applySummary.applied, true, "expected http apply applied=true");

      const statePath = path.join(httpStoreDir, "snapshot-state.json");
      assert.equal(fs.existsSync(statePath), true, "expected http snapshot-state.json");
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      assert.equal(typeof state.bundleId, "string", "expected http state bundleId");
      assert.equal(typeof state.appliedSnapshotId, "string", "expected http state appliedSnapshotId");
      return "bundle applied from http";
    });

    await step("HTTP invalid JSON rejected (enforce)", async () => {
      assert(serverRef, "server not started");
      const invalidBody = await fetchText(`${serverRef.baseUrl}/bundle-invalid.json`);
      fs.writeFileSync(invalidBundlePath, invalidBody, "utf8");

      const applyResult = runNodeTool("tools/trust-bundle-apply.mjs", [
        "--in",
        invalidBundlePath,
        "--store",
        invalidStoreDir,
        "--policy",
        "enforce",
        "--ci"
      ]);
      assert.equal(applyResult.status, 3, "expected enforce invalid json exit code 3");
      const applySummary = parseLastJsonLine(applyResult.stdout);
      assert.equal(applySummary.health, "invariant_failed");

      const code = applySummary.issues?.[0]?.code || "unknown";
      assert.equal(code, "trust_bundle_invalid", "expected stable invalid json code");
      return `code=${code}`;
    });
  } catch {
    summarize(results, demoDir);
    process.exit(1);
    return;
  } finally {
    if (serverRef?.server) {
      try {
        await closeServer(serverRef.server);
      } catch {
        // Best-effort shutdown for smoke cleanup.
      }
    }
  }

  summarize(results, demoDir);
}

main();
