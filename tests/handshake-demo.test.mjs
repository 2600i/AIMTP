#!/usr/bin/env node

import assert from "node:assert/strict";
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

function main() {
  testDefaultEnvironmentSkipsHandshake();
  testEnabledEnvironmentRunsHandshake();
  console.log("OK: handshake demo tests");
}

main();
