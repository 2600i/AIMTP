const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const repoRoot = path.resolve(__dirname, "..");
const toolPath = path.resolve(repoRoot, "tools", "trust-report.mjs");
const packageJson = JSON.parse(fs.readFileSync(path.resolve(repoRoot, "package.json"), "utf8"));

function runTool(args = []) {
  const env = {
    ...process.env,
    INTENTOS_TRUST_VERSION: "v2",
    INTENTOS_RECEIPT_POLICY: "warn",
    INTENTOS_TRANSPARENCY_LOG_MODE: "off",
    INTENTOS_TRANSPARENCY_CHECKPOINT_MODE: "off",
    INTENTOS_TRUST_DISTRIBUTION: "off",
    INTENTOS_TRUST_SNAPSHOT_POLICY: "warn"
  };
  return execFileSync(process.execPath, [toolPath, ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8"
  });
}

function testDeterministicOutput() {
  const first = runTool();
  const second = runTool();
  assert.equal(first, second, "trust report output must be deterministic");

  const parsed = JSON.parse(first);
  assert.equal(parsed.version, packageJson.version);
  assert.deepEqual(Object.keys(parsed), ["modes", "version"]);
}

function testIncludeVolatileFlag() {
  const output = runTool(["--include-volatile"]);
  const parsed = JSON.parse(output);
  assert.equal(typeof parsed.generatedAt, "string");
  assert.ok(parsed.generatedAt.length > 0);
}

function main() {
  testDeterministicOutput();
  testIncludeVolatileFlag();
  console.log("OK: trust report tests");
}

main();
