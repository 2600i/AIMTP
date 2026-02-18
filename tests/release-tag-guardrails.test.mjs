#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const scriptPath = path.join(rootDir, "scripts", "release-tag-guardrails.mjs");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "release-tag-guardrails-"));
const binDir = path.join(tmpDir, "bin");
const logPath = path.join(tmpDir, "git.log");
const tagName = "v0.4.0-beta.0";

fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(path.join(tmpDir, ".aimtp"), { recursive: true });
fs.writeFileSync(
  path.join(tmpDir, ".aimtp", "release.yml"),
  JSON.stringify(
    {
      branch: "main",
      remote: "origin",
      tagPrefix: "v",
      requirePrMergeForStable: true,
      stableMergeStrategy: "merge_commit"
    },
    null,
    2
  ),
  "utf8"
);

const gitShim = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const command = args.join(" ");
if (process.env.GIT_LOG_PATH) {
  fs.appendFileSync(process.env.GIT_LOG_PATH, command + "\\n");
}

if (args[0] === "fetch") process.exit(0);
if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "refs/tags/${tagName}") {
  process.stdout.write("refs/tags/${tagName}\\n");
  process.exit(0);
}
if (args[0] === "cat-file" && args[1] === "-t" && args[2] === "refs/tags/${tagName}") {
  process.stdout.write("tag\\n");
  process.exit(0);
}
if (args[0] === "rev-list" && args[1] === "-n" && args[2] === "1" && args[3] === "${tagName}") {
  process.stdout.write("0123456789abcdef0123456789abcdef01234567\\n");
  process.exit(0);
}
if (
  args[0] === "rev-list" &&
  args[1] === "--parents" &&
  args[2] === "-n" &&
  args[3] === "1" &&
  args[4] === "0123456789abcdef0123456789abcdef01234567"
) {
  process.stdout.write(
    "0123456789abcdef0123456789abcdef01234567 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n"
  );
  process.exit(0);
}
if (
  args[0] === "show" &&
  args[1] === "-s" &&
  args[2] === "--format=%s" &&
  args[3] === "0123456789abcdef0123456789abcdef01234567"
) {
  process.stdout.write("merge: release\\n");
  process.exit(0);
}
if (
  args[0] === "log" &&
  args[1] === "-1" &&
  args[2] === "--pretty=%B" &&
  args[3] === "0123456789abcdef0123456789abcdef01234567"
) {
  process.stdout.write("merge: release\\n");
  process.exit(0);
}
if (
  args[0] === "merge-base" &&
  args[1] === "--is-ancestor" &&
  args[2] === "0123456789abcdef0123456789abcdef01234567" &&
  args[3] === "origin/main"
) {
  process.exit(0);
}

process.stderr.write("unexpected git args: " + command + "\\n");
process.exit(2);
`;

const gitShimPath = path.join(binDir, "git");
fs.writeFileSync(gitShimPath, gitShim, "utf8");
fs.chmodSync(gitShimPath, 0o755);

const result = spawnSync(process.execPath, [scriptPath, "--tag", tagName], {
  cwd: tmpDir,
  env: {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    GIT_LOG_PATH: logPath
  },
  encoding: "utf8"
});

if (result.status !== 0) {
  throw new Error(
    `release-tag-guardrails script failed (status ${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
}

const commandLog = fs
  .readFileSync(logPath, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean);
const fetchTagRef = `fetch origin +refs/tags/${tagName}:refs/tags/${tagName}`;
const fetchTagIndex = commandLog.indexOf(fetchTagRef);
const revParseIndex = commandLog.indexOf(`rev-parse --verify refs/tags/${tagName}`);

assert.ok(fetchTagIndex >= 0, "expected explicit single-tag fetch command");
assert.ok(revParseIndex >= 0, "expected tag rev-parse check");
assert.ok(fetchTagIndex < revParseIndex, "expected tag fetch before tag validation");

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log("OK: release tag guardrails tests");
