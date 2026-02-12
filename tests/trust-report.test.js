const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const repoRoot = path.resolve(__dirname, "..");
const toolPath = path.resolve(repoRoot, "tools", "trust-report.mjs");
const packageJson = JSON.parse(fs.readFileSync(path.resolve(repoRoot, "package.json"), "utf8"));

const CONTROLLED_ENV_KEYS = [
  "INTENTOS_TRUST_VERSION",
  "INTENTOS_RECEIPT_POLICY",
  "INTENTOS_TRANSPARENCY_LOG_MODE",
  "INTENTOS_TRANSPARENCY_CHECKPOINT_MODE",
  "INTENTOS_TRUST_DISTRIBUTION",
  "INTENTOS_TRUST_SNAPSHOT_POLICY"
];

function runTool(args = [], envOverrides = {}) {
  const env = {
    ...process.env
  };
  CONTROLLED_ENV_KEYS.forEach((key) => {
    delete env[key];
  });
  Object.assign(env, envOverrides);
  return execFileSync(process.execPath, [toolPath, ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8"
  });
}

function testDeterministicOutput() {
  const envOverrides = {
    INTENTOS_TRUST_VERSION: "v2",
    INTENTOS_RECEIPT_POLICY: "warn"
  };
  const first = runTool([], envOverrides);
  const second = runTool([], envOverrides);
  assert.equal(first, second, "trust report output must be deterministic");

  const parsed = JSON.parse(first);
  assert.equal(parsed.version, packageJson.version);
  assert.equal(parsed.modes.trustVersion, "v2");
  assert.equal(parsed.modes.receiptPolicy, "warn");
  assert.equal(parsed.modes.transparencyLogMode, "off");
  assert.equal(parsed.modes.transparencyCheckpointMode, "off");
  assert.equal(parsed.modes.trustDistribution, "off");
  assert.equal(parsed.modes.trustSnapshotPolicy, "off");
  assert.deepEqual(Object.keys(parsed), ["modes", "version"]);
}

function testIncludeVolatileFlag() {
  const output = runTool(["--include-volatile"], {
    INTENTOS_TRUST_VERSION: "v2"
  });
  const parsed = JSON.parse(output);
  assert.equal(typeof parsed.generatedAt, "string");
  assert.ok(parsed.generatedAt.length > 0);
}

function testPrettyOutputDeterministic() {
  const envOverrides = {
    INTENTOS_TRUST_VERSION: "v2",
    INTENTOS_RECEIPT_POLICY: "warn"
  };
  const first = runTool(["--pretty"], envOverrides);
  const second = runTool(["--pretty"], envOverrides);
  assert.equal(first, second, "pretty trust report output must be deterministic");
  assert.ok(first.includes("\n  \"modes\":"));
}

function main() {
  testDeterministicOutput();
  testIncludeVolatileFlag();
  testPrettyOutputDeterministic();
  console.log("OK: trust report tests");
}

main();
