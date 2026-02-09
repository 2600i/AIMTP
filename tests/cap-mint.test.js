"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "tools", "aimtp-cap.mjs");

function runCli(args, env) {
  return spawnSync("node", [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8"
  });
}

function assertOk(result, context) {
  if (result.status !== 0) {
    throw new Error(
      `${context} failed (status=${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }
}

function assertFailed(result, context) {
  if (result.status === 0) {
    throw new Error(`${context} was expected to fail but exited 0`);
  }
}

function main() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const env = {
    AIMTP_CAP_PRIVATE_KEY: privatePem,
    AIMTP_CAP_PUBLIC_KEY: publicPem
  };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimtp-cap-test-"));
  const capPath = path.join(tempDir, "cap.json");

  const mintResult = runCli(
    [
      "mint",
      "--issuer",
      "orchestrator.local",
      "--subject",
      "agent.demo",
      "--aud",
      "http://localhost:8787/aimtp",
      "--ttl",
      "1800",
      "--actions",
      "intentos.read",
      "--resources",
      "intentos:intents",
      "--out",
      capPath
    ],
    env
  );
  assertOk(mintResult, "mint");

  const minted = JSON.parse(fs.readFileSync(capPath, "utf8"));
  assert.ok(Array.isArray(minted.chain));
  assert.strictEqual(minted.chain.length, 1);
  assert.strictEqual(minted.chain[0].aud, "http://localhost:8787/aimtp");
  assert.deepStrictEqual(minted.chain[0].scopes, [
    { action: "intentos.read", resource: "intentos:intents" }
  ]);

  const verifyOk = runCli(
    [
      "verify",
      "--file",
      capPath,
      "--aud",
      "http://localhost:8787/aimtp"
    ],
    env
  );
  assertOk(verifyOk, "verify valid");

  const verifyWrongAud = runCli(
    [
      "verify",
      "--file",
      capPath,
      "--aud",
      "http://localhost:8787"
    ],
    env
  );
  assertFailed(verifyWrongAud, "verify wrong aud");

  const verifyExpired = runCli(
    [
      "verify",
      "--file",
      capPath,
      "--aud",
      "http://localhost:8787/aimtp",
      "--now",
      String(minted.chain[0].exp + 1)
    ],
    env
  );
  assertFailed(verifyExpired, "verify expired");

  console.log("OK: cap mint tests");
}

main();
