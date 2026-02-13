#!/usr/bin/env node

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const RELEASE_SCRIPT = path.resolve(process.cwd(), "scripts/release.mjs");
const REQUIRED_PREFLIGHT_RULES = [
  "noDetachedHead",
  "cleanWorkingTree",
  "fetchTags",
  "onMainOnly",
  "localMainMatchesRemote",
  "prMergeForStable"
];

function makeMockGitScript(filePath) {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

function appendLog(message) {
  const logPath = process.env.MOCK_GIT_LOG_PATH;
  if (!logPath) return;
  fs.appendFileSync(logPath, message + "\\n", "utf8");
}

function loadScenario() {
  const filePath = process.env.MOCK_GIT_SCENARIO_PATH;
  if (!filePath) {
    throw new Error("MOCK_GIT_SCENARIO_PATH is required");
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function printStdout(value) {
  if (typeof value === "string" && value.length > 0) {
    process.stdout.write(value);
  }
}

function printStderr(value) {
  if (typeof value === "string" && value.length > 0) {
    process.stderr.write(value);
  }
}

function exitWith(status, stdout = "", stderr = "") {
  printStdout(stdout);
  printStderr(stderr);
  process.exit(status);
}

const args = process.argv.slice(2);
const scenario = loadScenario();
appendLog(args.join(" "));

if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") {
  exitWith(0, String(scenario.branch || "main") + "\\n");
}

if (args[0] === "status" && args[1] === "--porcelain") {
  exitWith(0, scenario.statusPorcelain || "");
}

if (args[0] === "fetch") {
  if (typeof scenario.fetchStatus === "number") {
    exitWith(scenario.fetchStatus, "", String(scenario.fetchError || ""));
  }
  exitWith(0, "", "");
}

if (args[0] === "ls-remote" && args[1] === "--tags") {
  if (typeof scenario.lsRemoteTagsStatus === "number" && scenario.lsRemoteTagsStatus !== 0) {
    exitWith(scenario.lsRemoteTagsStatus, String(scenario.lsRemoteTagsOutput || ""), String(scenario.lsRemoteTagsError || ""));
  }
  exitWith(0, String(scenario.lsRemoteTagsOutput || ""), String(scenario.lsRemoteTagsError || ""));
}

if (args[0] === "ls-remote" && args[2] && args[2].startsWith("refs/heads/")) {
  const remoteSha = String(scenario.originMainSha || "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  const ref = args[2];
  exitWith(0, remoteSha + "\\t" + ref + "\\n");
}

if (args[0] === "rev-parse" && args[1] === "main") {
  exitWith(0, String(scenario.localMainSha || "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") + "\\n");
}

if (args[0] === "rev-parse" && args[1] === "origin/main") {
  exitWith(0, String(scenario.originMainSha || scenario.localMainSha || "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") + "\\n");
}

if (args[0] === "show-ref" && args[1] === "--tags" && args[2] === "--verify" && args[3] === "--quiet") {
  if (scenario.localTagExists) {
    exitWith(0);
  }
  exitWith(1);
}

if (args[0] === "rev-list" && args[1] === "--parents" && args[2] === "-n" && args[3] === "1" && args[4] === "HEAD") {
  const line = String(
    scenario.revListParents ||
      "dddddddddddddddddddddddddddddddddddddddd eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee ffffffffffffffffffffffffffffffffffffffff"
  );
  exitWith(0, line + "\\n");
}

if (args[0] === "show" && args[1] === "-s" && args[2] === "--format=%s" && args[3] === "HEAD") {
  exitWith(0, String(scenario.subject || "merge: release prep") + "\\n");
}

if (args[0] === "log" && args[1] === "-1" && args[2] === "--pretty=%B") {
  exitWith(0, String(scenario.message || "merge: release prep") + "\\n");
}

exitWith(99, "", "mock-git unsupported command: " + args.join(" ") + "\\n");
`;
  writeFileSync(filePath, script, "utf8");
  chmodSync(filePath, 0o755);
}

function writeReleaseConfig(repoPath) {
  const configPath = path.join(repoPath, ".aimtp", "release.yml");
  const config = {
    branch: "main",
    remote: "origin",
    tagPrefix: "v",
    checks: ["npm test", "npm run build"],
    "preflight rules": REQUIRED_PREFLIGHT_RULES,
    requirePrMergeForStable: true,
    stableMergeStrategy: "merge_or_squash",
    squashMarkers: ["(#", "merge:"],
    preflight: {
      allowPrereleaseRelease: false
    },
    githubRelease: {
      enabled: false,
      generateNotes: true
    }
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function writePackageJson(repoPath, version = "0.3.1") {
  writeFileSync(
    path.join(repoPath, "package.json"),
    `${JSON.stringify({ name: "aimtp-test-harness", version }, null, 2)}\n`,
    "utf8"
  );
}

function runPreflightScenario(name, scenario, options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "aimtp-release-preflight-"));
  const binDir = path.join(root, "bin");
  const aimtpDir = path.join(root, ".aimtp");
  const scenarioPath = path.join(root, "scenario.json");
  const logPath = path.join(root, "mock-git.log");
  const mockGitPath = path.join(binDir, "git");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(aimtpDir, { recursive: true });

  try {
    writeReleaseConfig(root);
    writePackageJson(root, options.packageVersion ?? "0.3.1");
    writeFileSync(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, "utf8");
    makeMockGitScript(mockGitPath);

    const args = [RELEASE_SCRIPT, "preflight"];
    if (options.useCliVersion !== false) {
      args.push("--version", options.version ?? "0.3.1");
    }

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH || ""}`,
      MOCK_GIT_SCENARIO_PATH: scenarioPath,
      MOCK_GIT_LOG_PATH: logPath
    };

    const result = spawnSync(process.execPath, args, {
      cwd: root,
      env,
      encoding: "utf8"
    });

    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const commandLog = readFileSync(logPath, "utf8");
    return {
      name,
      status: result.status ?? 1,
      output,
      commandLog
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function baseScenario(overrides = {}) {
  return {
    branch: "main",
    localMainSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    originMainSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    fetchStatus: 128,
    fetchError: "fatal: cannot open .git/FETCH_HEAD: Permission denied",
    lsRemoteTagsStatus: 0,
    lsRemoteTagsOutput: "",
    lsRemoteTagsError: "",
    localTagExists: false,
    subject: "merge: preflight integration test",
    message: "merge: preflight integration test",
    ...overrides
  };
}

// Scenario A: FETCH_HEAD permission failure must trigger ls-remote fallback attempt.
const scenarioAFallbackAttempt = runPreflightScenario(
  "fetch-head-permission-triggers-lsremote",
  baseScenario({})
);
assert.equal(scenarioAFallbackAttempt.status, 0);
assert.ok(
  scenarioAFallbackAttempt.output.includes(
    'Preflight warning: unable to write FETCH_HEAD during git fetch; falling back to "git ls-remote --tags origin" for tag existence checks.'
  ),
  "expected FETCH_HEAD warning prior to ls-remote fallback"
);
assert.ok(
  scenarioAFallbackAttempt.commandLog.includes("ls-remote --tags origin"),
  "expected ls-remote --tags fallback command to run"
);

// Scenario B: ls-remote nonzero should be treated as offline only on synced main.
const scenarioBSafeOfflineFallback = runPreflightScenario(
  "lsremote-fail-safe-main-synced",
  baseScenario({
    lsRemoteTagsStatus: 2,
    lsRemoteTagsError: "fatal: unable to access remote: Could not resolve host"
  }),
  { useCliVersion: false, packageVersion: "0.3.1" }
);
assert.equal(scenarioBSafeOfflineFallback.status, 0);
assert.ok(
  scenarioBSafeOfflineFallback.output.includes(
    "Preflight warning: remote tag lookup unavailable (ls-remote failed). Falling back to local tag check only."
  )
);

// Scenario C: off-main must deny offline fallback.
const scenarioCOffMainDenied = runPreflightScenario(
  "lsremote-fail-off-main-denied",
  baseScenario({
    branch: "feature/not-main",
    lsRemoteTagsStatus: 2,
    lsRemoteTagsError: "fatal: offline"
  })
);
assert.equal(scenarioCOffMainDenied.status, 1);
assert.ok(
  scenarioCOffMainDenied.output.includes('offline local tag fallback requires branch "main"'),
  "expected off-main fallback denial message"
);

// Scenario D: main diverged from origin/main must deny offline fallback.
const scenarioDDivergedMainDenied = runPreflightScenario(
  "lsremote-fail-diverged-main-denied",
  baseScenario({
    lsRemoteTagsStatus: 2,
    lsRemoteTagsError: "fatal: offline",
    localMainSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    originMainSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  })
);
assert.equal(scenarioDDivergedMainDenied.status, 1);
assert.ok(
  scenarioDDivergedMainDenied.output.includes("offline local tag fallback requires main to match origin/main."),
  "expected diverged-main fallback denial message"
);

// Scenario E: local tag collision must fail during offline fallback.
const scenarioELocalTagCollision = runPreflightScenario(
  "lsremote-fail-local-tag-exists",
  baseScenario({
    lsRemoteTagsStatus: 2,
    lsRemoteTagsError: "fatal: offline",
    localTagExists: true
  })
);
assert.equal(scenarioELocalTagCollision.status, 1);
assert.ok(
  scenarioELocalTagCollision.output.includes("Tag already exists locally: v0.3.1"),
  "expected local tag collision message"
);

console.log("OK: release preflight offline integration tests");
