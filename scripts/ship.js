#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { execFileSync, spawnSync } = require("node:child_process");

function output(message) {
  console.log(message);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args) {
  output(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    stdio: "inherit"
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function readCommand(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function hasWorkingTreeChanges() {
  return readCommand("git", ["status", "--porcelain"]).length > 0;
}

function bumpPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Invalid semver version for patch bump: "${version}"`);
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]) + 1;
  return `${major}.${minor}.${patch}`;
}

function writePackageVersion(packagePath, nextVersion) {
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  pkg.version = nextVersion;
  fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
}

function hasUpstream() {
  try {
    readCommand("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    return true;
  } catch {
    return false;
  }
}

function readUpstreamOrNull() {
  try {
    return readCommand("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  } catch {
    return null;
  }
}

function ensureSafeMainShipping() {
  const branch = readCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== "main") {
    return;
  }

  const upstream = readUpstreamOrNull();
  if (!upstream) {
    fail("Refusing to ship from main without upstream tracking. Sync main or ship from a release branch.");
  }

  const rawCounts = readCommand("git", ["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
  const parts = rawCounts.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    fail("Refusing to ship from main: unable to determine divergence against upstream.");
  }

  const ahead = Number(parts[0]);
  const behind = Number(parts[1]);
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) {
    fail("Refusing to ship from main: invalid divergence data from git.");
  }

  if (ahead !== 0 || behind !== 0) {
    fail(
      `Refusing to ship from diverged main (ahead ${ahead}, behind ${behind}). Create a release branch or sync main with origin.`
    );
  }
}

function shouldPushFromEnv(value) {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true"].includes(normalized)) return true;
  if (["0", "false"].includes(normalized)) return false;
  return null;
}

async function askToPush() {
  const envChoice = shouldPushFromEnv(process.env.SHIP_PUSH);
  if (envChoice !== null) return envChoice;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log("Non-interactive shell detected; skipping push. Set SHIP_PUSH=true to force.");
    return false;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const answer = await new Promise((resolve) => {
    rl.question("Push commits and release tag to origin? [y/N] ", (value) => resolve(value));
  });
  rl.close();

  return ["y", "yes"].includes(String(answer).trim().toLowerCase());
}

async function main() {
  ensureSafeMainShipping();

  const commitMessage =
    process.env.SHIP_MESSAGE && process.env.SHIP_MESSAGE.trim()
      ? process.env.SHIP_MESSAGE.trim()
      : "feat: ship changes";
  const packagePath = path.resolve(process.cwd(), "package.json");
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const currentVersion = String(pkg.version || "").trim();
  const nextVersion = bumpPatch(currentVersion);

  run("npm", ["test"]);
  run("npm", ["run", "build"]);

  if (hasWorkingTreeChanges()) {
    run("git", ["add", "-A"]);
    run("git", ["commit", "-m", commitMessage]);
  } else {
    output("No changes to commit before version bump.");
  }

  writePackageVersion(packagePath, nextVersion);
  run("git", ["add", "package.json"]);
  run("git", ["commit", "-m", `chore: bump version to ${nextVersion}`]);

  const tagName = `v${nextVersion}`;
  if (readCommand("git", ["tag", "-l", tagName]) === tagName) {
    throw new Error(`Tag already exists: ${tagName}`);
  }
  run("git", ["tag", "-a", tagName, "-m", tagName]);

  const shouldPush = await askToPush();
  if (!shouldPush) {
    output("Push skipped.");
    return;
  }

  const branch = readCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (hasUpstream()) {
    run("git", ["push"]);
  } else {
    run("git", ["push", "-u", "origin", branch]);
  }
  run("git", ["push", "origin", tagName]);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  fail(message);
  process.exit(1);
});
