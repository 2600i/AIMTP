#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(process.cwd());
const toolPath = path.resolve(repoRoot, "tools", "identity-anchor-demo.mjs");

function runAnchorTool(envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  return spawnSync(process.execPath, [toolPath], {
    cwd: repoRoot,
    env,
    encoding: "utf8"
  });
}

function testDefaultEnvironmentSkipsAnchor() {
  const result = runAnchorTool({
    INTENTOS_PROTOCOL_VERSION: "",
    INTENTOS_IDENTITY: ""
  });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stderr}`);
  assert.match(result.stdout, /ANCHOR SKIPPED/);
}

function testEnabledEnvironmentRunsAnchor() {
  const result = runAnchorTool({
    INTENTOS_PROTOCOL_VERSION: "0.4",
    INTENTOS_IDENTITY: "on"
  });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stderr}`);
  assert.match(result.stdout, /ANCHOR OK/);
}

function main() {
  testDefaultEnvironmentSkipsAnchor();
  testEnabledEnvironmentRunsAnchor();
  console.log("OK: identity anchor demo tests");
}

main();
