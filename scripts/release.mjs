#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawnSync } from "node:child_process";

const CONFIG_PATH = path.resolve(process.cwd(), ".aimtp", "release.yml");
const REQUIRED_PREFLIGHT_RULES = [
  "noDetachedHead",
  "onMainOnly",
  "cleanWorkingTree",
  "localMainMatchesRemote"
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  const printable = `${command} ${args.join(" ")}`.trim();
  console.log(`$ ${printable}`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options
  });
  if (result.error) {
    fail(`Failed to run "${printable}": ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function read(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8" }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`Failed to run "${command} ${args.join(" ")}": ${message}`);
  }
}

function parseArgs(argv) {
  const [subcommand, ...rest] = argv;
  if (!subcommand) {
    fail(
      "Usage: node scripts/release.mjs <preflight|release|github-release> [options]\n" +
      "Examples:\n" +
      "  node scripts/release.mjs preflight\n" +
      "  node scripts/release.mjs release --version 0.3.0\n" +
      "  node scripts/release.mjs release --use-current-version\n" +
      "  node scripts/release.mjs github-release --use-current-tag"
    );
  }

  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) {
      fail(`Unknown argument: ${token}`);
    }
    if (token === "--use-current-version" || token === "--use-current-tag") {
      options[token.slice(2)] = true;
      continue;
    }

    const value = rest[i + 1];
    if (!value || value.startsWith("--")) {
      fail(`Missing value for ${token}`);
    }
    options[token.slice(2)] = value;
    i += 1;
  }

  return { subcommand, options };
}

function parseReleaseConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fail(`Missing release config: ${CONFIG_PATH}`);
  }

  let parsed;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(
      `Failed to parse ${CONFIG_PATH}: ${message}\n` +
      "Use JSON-compatible YAML in .aimtp/release.yml."
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`Invalid release config: ${CONFIG_PATH} must be an object`);
  }

  const config = parsed;
  const branch = String(config.branch ?? "").trim();
  const remote = String(config.remote ?? "").trim();
  const tagPrefix = String(config.tagPrefix ?? "").trim();
  const checks = Array.isArray(config.checks) ? config.checks.map((entry) => String(entry).trim()).filter(Boolean) : [];
  const preflightRulesRaw =
    Array.isArray(config["preflight rules"]) ? config["preflight rules"] :
      Array.isArray(config.preflight?.rules) ? config.preflight.rules : [];
  const preflightRules = preflightRulesRaw.map((entry) => String(entry).trim()).filter(Boolean);
  const allowPrereleaseRelease = Boolean(config.preflight?.allowPrereleaseRelease);
  const githubReleaseEnabled = Boolean(config.githubRelease?.enabled);
  const githubGenerateNotes =
    config.githubRelease?.generateNotes === undefined ? true : Boolean(config.githubRelease.generateNotes);

  if (!branch) {
    fail(`Invalid ${CONFIG_PATH}: missing "branch"`);
  }
  if (!remote) {
    fail(`Invalid ${CONFIG_PATH}: missing "remote"`);
  }
  if (!tagPrefix) {
    fail(`Invalid ${CONFIG_PATH}: missing "tagPrefix"`);
  }
  if (checks.length === 0) {
    fail(`Invalid ${CONFIG_PATH}: missing "checks"`);
  }
  if (preflightRules.length === 0) {
    fail(`Invalid ${CONFIG_PATH}: missing "preflight rules"`);
  }
  const missingRequiredRules = REQUIRED_PREFLIGHT_RULES.filter((rule) => !preflightRules.includes(rule));
  if (missingRequiredRules.length > 0) {
    fail(`Invalid ${CONFIG_PATH}: missing required preflight rules: ${missingRequiredRules.join(", ")}`);
  }

  return {
    branch,
    remote,
    tagPrefix,
    checks,
    preflightRules,
    allowPrereleaseRelease,
    githubReleaseEnabled,
    githubGenerateNotes
  };
}

function gitCurrentBranch() {
  return read("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
}

function ensureNoDetachedHead() {
  if (gitCurrentBranch() === "HEAD") {
    fail("Preflight failed: detached HEAD is not allowed.");
  }
}

function ensureOnConfiguredBranch(config) {
  const branch = gitCurrentBranch();
  if (branch !== config.branch) {
    fail(`Preflight failed: current branch is "${branch}", expected "${config.branch}".`);
  }
}

function ensureCleanWorkingTree() {
  const dirty = read("git", ["status", "--porcelain"]);
  if (dirty.length > 0) {
    fail("Preflight failed: working tree is dirty. Commit/stash changes before release.");
  }
}

function fetchRemoteState(config) {
  run("git", ["fetch", config.remote, "--tags"]);
}

function ensureLocalMainMatchesRemote(config) {
  const localRef = read("git", ["rev-parse", config.branch]);
  const remoteRef = read("git", ["rev-parse", `${config.remote}/${config.branch}`]);
  if (localRef !== remoteRef) {
    fail(
      `Preflight failed: ${config.branch} (${localRef}) does not match ${config.remote}/${config.branch} (${remoteRef}).`
    );
  }
}

function runPreflight(config) {
  const ruleHandlers = {
    noDetachedHead: () => ensureNoDetachedHead(),
    onMainOnly: () => ensureOnConfiguredBranch(config),
    cleanWorkingTree: () => ensureCleanWorkingTree(),
    localMainMatchesRemote: () => {
      fetchRemoteState(config);
      ensureLocalMainMatchesRemote(config);
    }
  };

  for (const rule of config.preflightRules) {
    const handler = ruleHandlers[rule];
    if (!handler) {
      fail(`Invalid preflight rule in ${CONFIG_PATH}: ${rule}`);
    }
    handler();
  }
}

function readPackageVersion() {
  const packagePath = path.resolve(process.cwd(), "package.json");
  if (!fs.existsSync(packagePath)) {
    fail(`Missing package.json at ${packagePath}`);
  }
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const version = String(pkg.version ?? "").trim();
  if (!version) {
    fail("package.json version is missing.");
  }
  return version;
}

function isPrerelease(version) {
  return version.includes("-");
}

function assertSemver(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`Invalid version: "${version}". Expected semver format, e.g. 1.2.3`);
  }
}

function ensureTagDoesNotExist(tagName) {
  const existing = read("git", ["tag", "-l", tagName]);
  if (existing === tagName) {
    fail(`Tag already exists: ${tagName}`);
  }
}

function setPackageVersion(version) {
  run("npm", ["version", version, "--no-git-tag-version"]);

  const changed = read("git", ["status", "--porcelain", "--", "package.json", "package-lock.json"]);
  if (!changed) {
    fail(`Version change did not modify package files (requested version: ${version}).`);
  }

  run("git", ["add", "package.json", "package-lock.json"]);
  run("git", ["commit", "-m", `chore(release): v${version}`]);
}

function runReleaseChecks(config) {
  const commandSet = new Set(config.checks);
  commandSet.add("npm test");
  commandSet.add("npm run build");
  for (const command of commandSet) {
    run(command, [], { shell: true });
  }
}

function createAnnotatedTag(tagName) {
  run("git", ["tag", "-a", tagName, "-m", tagName]);
}

function pushRelease(config, tagName) {
  run("git", ["push", config.remote, config.branch]);
  run("git", ["push", config.remote, tagName]);
}

function printReleaseSuccess(version, tagName) {
  const sha = read("git", ["rev-parse", "HEAD"]);
  console.log("Release complete:");
  console.log(`  version: ${version}`);
  console.log(`  tag: ${tagName}`);
  console.log(`  commit: ${sha}`);
}

function resolveSingleTagAtHead(prefix = "") {
  const tags = read("git", ["tag", "--points-at", "HEAD"])
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const filtered = prefix ? tags.filter((entry) => entry.startsWith(prefix)) : tags;
  if (filtered.length === 0) {
    fail("No matching tag found at HEAD.");
  }
  if (filtered.length > 1) {
    fail(`Multiple matching tags found at HEAD: ${filtered.join(", ")}. Use --tag to specify one.`);
  }
  return filtered[0];
}

function ensureGhInstalled() {
  const result = spawnSync("gh", ["--version"], { stdio: "pipe", encoding: "utf8" });
  if (result.error || result.status !== 0) {
    fail("GitHub release failed: `gh` CLI is not installed or not available in PATH.");
  }
}

function ensureGhAuthenticated() {
  const result = spawnSync("gh", ["auth", "status"], { stdio: "pipe", encoding: "utf8" });
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    fail(`GitHub release failed: gh is not authenticated.\n${details}`);
  }
}

function runGithubRelease(config, options) {
  if (!config.githubReleaseEnabled) {
    fail("GitHub release is disabled in .aimtp/release.yml (githubRelease.enabled=false).");
  }

  const hasTag = typeof options.tag === "string";
  const useCurrentTag = Boolean(options["use-current-tag"]);
  if ((hasTag && useCurrentTag) || (!hasTag && !useCurrentTag)) {
    fail("Use exactly one of --tag <tag> or --use-current-tag.");
  }

  const tagName = hasTag ? options.tag : resolveSingleTagAtHead(config.tagPrefix);
  ensureGhInstalled();
  ensureGhAuthenticated();

  const args = ["release", "create", tagName, "--verify-tag"];
  if (config.githubGenerateNotes) {
    args.push("--generate-notes");
  }
  run("gh", args);
  console.log(`GitHub release created for tag ${tagName}`);
}

function runRelease(config, options) {
  const explicitVersion = typeof options.version === "string" ? options.version.trim() : "";
  const useCurrentVersion = Boolean(options["use-current-version"]);

  if ((explicitVersion && useCurrentVersion) || (!explicitVersion && !useCurrentVersion)) {
    fail("Use exactly one of --version <X.Y.Z> or --use-current-version.");
  }

  runPreflight(config);

  let version = "";
  if (explicitVersion) {
    assertSemver(explicitVersion);
    version = explicitVersion;
    setPackageVersion(version);
  } else {
    version = readPackageVersion();
    if (isPrerelease(version) && !config.allowPrereleaseRelease) {
      fail(
        `Refusing prerelease version "${version}" with --use-current-version. ` +
        "Set preflight.allowPrereleaseRelease=true to override."
      );
    }
  }

  const packageVersion = readPackageVersion();
  if (packageVersion !== version) {
    fail(`Version mismatch: package.json=${packageVersion}, expected=${version}`);
  }

  runReleaseChecks(config);
  fetchRemoteState(config);

  const tagName = `${config.tagPrefix}${version}`;
  ensureTagDoesNotExist(tagName);
  createAnnotatedTag(tagName);
  pushRelease(config, tagName);
  printReleaseSuccess(version, tagName);
}

function main() {
  const { subcommand, options } = parseArgs(process.argv.slice(2));
  const config = parseReleaseConfig();

  if (subcommand === "preflight") {
    runPreflight(config);
    console.log("Preflight checks passed.");
    return;
  }

  if (subcommand === "release") {
    runRelease(config, options);
    return;
  }

  if (subcommand === "github-release") {
    runGithubRelease(config, options);
    return;
  }

  fail(`Unknown subcommand: ${subcommand}`);
}

main();
