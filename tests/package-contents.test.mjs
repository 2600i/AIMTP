#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));

assert.equal(
  packageLock.version,
  packageJson.version,
  "package-lock.json version must match package.json"
);
assert.equal(
  packageLock.packages?.[""]?.version,
  packageJson.version,
  "package-lock.json root package version must match package.json"
);
assert.ok(
  !packageJson.files.includes("runtime/**"),
  "package files must not broadly include generated runtime state"
);

const runtimeDir = path.join(root, "runtime");
const sentinels = [
  path.join(runtimeDir, "package-contents-test.sqlite"),
  path.join(runtimeDir, "package-contents-test.db"),
  path.join(runtimeDir, "package-contents-test-private-key.json")
];
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimtp-package-contents-"));

for (const sentinel of sentinels) {
  assert.ok(!fs.existsSync(sentinel), `refusing to overwrite existing test sentinel: ${sentinel}`);
}

try {
  fs.writeFileSync(sentinels[0], "not-a-database\n", "utf8");
  fs.writeFileSync(sentinels[1], "not-a-database\n", "utf8");
  fs.writeFileSync(
    sentinels[2],
    JSON.stringify({ privateKeyPem: "-----BEGIN PRIVATE KEY-----\ntest-only\n" }),
    "utf8"
  );

  const result = spawnSync(
    "npm",
    ["pack", "--dry-run", "--json", "--cache", path.join(tmpDir, "npm-cache")],
    { cwd: root, encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error(
      `npm pack dry run failed (status ${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }

  const report = JSON.parse(result.stdout);
  const paths = new Set(report[0].files.map((entry) => entry.path));
  const forbiddenPaths = [
    "runtime/package-contents-test.sqlite",
    "runtime/package-contents-test.db",
    "runtime/package-contents-test-private-key.json",
    "runtime/aimtp-dev.sqlite",
    "runtime/aimtp-intentos.sqlite",
    "runtime/aimtp-mailbox.sqlite",
    "runtime/federation-keys.json"
  ];
  for (const forbiddenPath of forbiddenPaths) {
    assert.ok(!paths.has(forbiddenPath), `package contains generated or sensitive file: ${forbiddenPath}`);
  }

  for (const requiredPath of [
    "LICENSE",
    "LICENSES/CC-BY-4.0.txt",
    "LICENSES/ELASTIC-LICENSE-2.0.txt",
    "LICENSING.md",
    "NOTICE",
    "TRADEMARKS.md",
    "runtime/schemas/mailbox-ack.schema.json",
    "runtime/schemas/mailbox-dead-letter-item.schema.json",
    "runtime/schemas/mailbox-fail.schema.json",
    "runtime/schemas/mailbox-poll-item.schema.json"
  ]) {
    assert.ok(paths.has(requiredPath), `package is missing required file: ${requiredPath}`);
  }
} finally {
  for (const sentinel of sentinels) {
    fs.rmSync(sentinel, { force: true });
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("OK: package contents and version consistency");
