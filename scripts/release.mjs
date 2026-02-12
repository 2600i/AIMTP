#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawnSync } from "node:child_process";
import {
  evaluateOfflineTagLookupFallback,
  evaluateStablePrMergeRequirement,
  isStableMergeStrategy,
  isStableVersion,
  parseParentCountFromRevList
} from "./release-guardrails.mjs";

const CONFIG_PATH = path.resolve(process.cwd(), ".aimtp", "release.yml");
const REQUIRED_PREFLIGHT_RULES = [
  "noDetachedHead",
  "cleanWorkingTree",
  "fetchTags",
  "onMainOnly",
  "localMainMatchesRemote",
  "prMergeForStable"
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

function runCaptured(command, args) {
  const printable = `${command} ${args.join(" ")}`.trim();
  console.log(`$ ${printable}`);
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) {
    fail(`Failed to run "${printable}": ${result.error.message}`);
  }
  return result;
}

function printCaptured(result) {
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
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
      "  node scripts/release.mjs preflight --version 0.3.0-rc.1\n" +
      "  node scripts/release.mjs release --version 0.3.0-rc.1\n" +
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
  const requirePrMergeForStable =
    config.requirePrMergeForStable === undefined
      ? config.preflight?.requirePrMergeForStable === undefined
        ? true
        : Boolean(config.preflight.requirePrMergeForStable)
      : Boolean(config.requirePrMergeForStable);
  const githubReleaseEnabled = Boolean(config.githubRelease?.enabled);
  const githubGenerateNotes =
    config.githubRelease?.generateNotes === undefined ? true : Boolean(config.githubRelease.generateNotes);
  const stableMergeStrategy = String(
    config.stableMergeStrategy ?? config.preflight?.stableMergeStrategy ?? "merge_commit"
  )
    .trim()
    .toLowerCase();
  const squashMarkersRaw = Array.isArray(config.squashMarkers)
    ? config.squashMarkers
    : Array.isArray(config.preflight?.squashMarkers)
      ? config.preflight.squashMarkers
      : [];
  const squashMarkers = squashMarkersRaw
    .map((entry) => String(entry ?? "").trim())
    .filter((entry) => entry.length > 0);

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
  if (!isStableMergeStrategy(stableMergeStrategy)) {
    fail(
      `Invalid ${CONFIG_PATH}: "stableMergeStrategy" must be one of ` +
      `"merge_commit", "merge_or_squash".`
    );
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
    requirePrMergeForStable,
    stableMergeStrategy,
    squashMarkers,
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
    fail(`Preflight failed: stable release requires branch \"${config.branch}\" (found \"${branch}\").`);
  }
}

function ensureCleanWorkingTree() {
  const dirty = read("git", ["status", "--porcelain"]);
  if (dirty.length > 0) {
    fail("Preflight failed: working tree is dirty. Commit/stash changes before release.");
  }
}

function isFetchHeadPermissionError(message) {
  const text = String(message ?? "");
  return /FETCH_HEAD/i.test(text) && /(permission denied|operation not permitted|eacces|eperm)/i.test(text);
}

function parseRemoteTagSet(lsRemoteOutput) {
  const tags = new Set();
  for (const line of String(lsRemoteOutput ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const [sha, ref] = trimmed.split(/\s+/);
    if (!sha || !ref || !ref.startsWith("refs/tags/")) {
      continue;
    }
    const rawTag = ref.slice("refs/tags/".length);
    const tag = rawTag.endsWith("^{}") ? rawTag.slice(0, -3) : rawTag;
    if (tag) {
      tags.add(tag);
    }
  }
  return tags;
}

function readTrackedMainRefs(config) {
  const localRef = read("git", ["rev-parse", config.branch]);
  const trackedRemoteRef = read("git", ["rev-parse", `${config.remote}/${config.branch}`]);
  return {
    localRef,
    trackedRemoteRef,
    matches: localRef === trackedRemoteRef
  };
}

function readRemoteBranchRefViaLsRemote(config) {
  const branchRef = `refs/heads/${config.branch}`;
  const result = runCaptured("git", ["ls-remote", config.remote, branchRef]);
  if (result.status !== 0) {
    printCaptured(result);
    fail(`Preflight failed: unable to read ${config.remote}/${config.branch} via ls-remote.`);
  }
  const firstLine = String(result.stdout ?? "").trim().split("\n").find((line) => line.trim().length > 0) ?? "";
  const [sha] = firstLine.split(/\s+/);
  if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) {
    fail(`Preflight failed: unable to parse ${config.remote}/${config.branch} SHA from ls-remote output.`);
  }
  return sha;
}

function fetchRemoteState(config) {
  const fetchResult = runCaptured("git", ["fetch", config.remote, "--tags"]);
  if (fetchResult.status === 0) {
    printCaptured(fetchResult);
    return {
      fallbackUsed: false,
      remoteTagSet: null,
      offlineLocalTagCheckOnly: false
    };
  }

  const details = `${fetchResult.stdout ?? ""}\n${fetchResult.stderr ?? ""}`;
  if (!isFetchHeadPermissionError(details)) {
    printCaptured(fetchResult);
    fail(`Preflight failed: git fetch ${config.remote} --tags failed.`);
  }

  console.warn(
    `Preflight warning: unable to write FETCH_HEAD during git fetch; ` +
    `falling back to \"git ls-remote --tags ${config.remote}\" for tag existence checks.`
  );

  const lsRemoteResult = runCaptured("git", ["ls-remote", "--tags", config.remote]);
  if (lsRemoteResult.status !== 0) {
    const currentBranch = gitCurrentBranch();
    let mainMatchesRemote = false;
    if (currentBranch === config.branch) {
      const refs = readTrackedMainRefs(config);
      mainMatchesRemote = refs.matches;
    }

    const decision = evaluateOfflineTagLookupFallback({
      fetchHeadPermissionError: true,
      lsRemoteFailed: true,
      onMain: currentBranch === config.branch,
      mainMatchesRemote,
      localTagExists: false
    });

    if (!decision.proceed) {
      printCaptured(lsRemoteResult);
      fail(`Preflight failed: fallback tag lookup via ls-remote failed for remote \"${config.remote}\".`);
    }

    console.warn(decision.warning);
    return {
      fallbackUsed: false,
      remoteTagSet: null,
      offlineLocalTagCheckOnly: true
    };
  }

  const remoteTagSet = parseRemoteTagSet(lsRemoteResult.stdout ?? "");
  return {
    fallbackUsed: true,
    remoteTagSet,
    offlineLocalTagCheckOnly: false
  };
}

function ensureLocalMainMatchesRemote(config, fetchState) {
  const localRef = read("git", ["rev-parse", config.branch]);
  const remoteRef = fetchState.offlineLocalTagCheckOnly
    ? read("git", ["rev-parse", `${config.remote}/${config.branch}`])
    : fetchState.fallbackUsed
      ? readRemoteBranchRefViaLsRemote(config)
      : read("git", ["rev-parse", `${config.remote}/${config.branch}`]);

  if (localRef !== remoteRef) {
    fail(
      `Preflight failed: stable release requires ${config.branch} to match ${config.remote}/${config.branch} ` +
      `(local=${localRef}, remote=${remoteRef}).`
    );
  }
}

function ensureStablePrMergeRequirement(version, config) {
  const parentLine = read("git", ["rev-list", "--parents", "-n", "1", "HEAD"]);
  const parentCount = parseParentCountFromRevList(parentLine);
  const subject = read("git", ["show", "-s", "--format=%s", "HEAD"]);
  const message = read("git", ["log", "-1", "--pretty=%B"]);

  const decision = evaluateStablePrMergeRequirement({
    version,
    requirePrMergeForStable: config.requirePrMergeForStable,
    stableMergeStrategy: config.stableMergeStrategy,
    squashMarkers: config.squashMarkers,
    parentCount,
    subject,
    message
  });

  if (!decision.allowed) {
    fail(`Preflight failed: ${decision.message}`);
  }
}

function runPreflight(config, options = {}) {
  const packageVersion = readPackageVersion();
  const releaseVersion = typeof options.releaseVersion === "string" && options.releaseVersion.trim().length > 0
    ? options.releaseVersion.trim()
    : packageVersion;
  const stable = isStableVersion(releaseVersion);
  let fetchState = null;

  const ruleHandlers = {
    noDetachedHead: () => ensureNoDetachedHead(),
    cleanWorkingTree: () => ensureCleanWorkingTree(),
    fetchTags: () => {
      fetchState = fetchRemoteState(config);
    },
    onMainOnly: () => {
      if (stable) {
        ensureOnConfiguredBranch(config);
      }
    },
    localMainMatchesRemote: () => {
      if (stable) {
        if (!fetchState) {
          fetchState = fetchRemoteState(config);
        }
        ensureLocalMainMatchesRemote(config, fetchState);
      }
    },
    prMergeForStable: () => {
      if (stable && config.requirePrMergeForStable) {
        ensureStablePrMergeRequirement(releaseVersion, config);
      }
    }
  };

  for (const rule of config.preflightRules) {
    const handler = ruleHandlers[rule];
    if (!handler) {
      fail(`Invalid preflight rule in ${CONFIG_PATH}: ${rule}`);
    }
    handler();
  }

  return {
    packageVersion,
    releaseVersion,
    stable,
    fetchState
  };
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

function localTagExists(tagName) {
  const ref = `refs/tags/${tagName}`;
  const result = spawnSync("git", ["show-ref", "--tags", "--verify", "--quiet", ref], { stdio: "pipe" });
  if (result.error) {
    fail(`Failed to run "git show-ref --tags --verify --quiet ${ref}": ${result.error.message}`);
  }
  if (result.status === 0) {
    return true;
  }
  if (result.status === 1) {
    return false;
  }
  fail(`Failed to run "git show-ref --tags --verify --quiet ${ref}": exit code ${result.status ?? "unknown"}`);
}

function ensureTagDoesNotExist(tagName, fetchState) {
  if (localTagExists(tagName)) {
    fail(`Tag already exists locally: ${tagName}`);
  }

  if (fetchState?.offlineLocalTagCheckOnly) {
    return;
  }

  if (fetchState?.fallbackUsed && fetchState.remoteTagSet?.has(tagName)) {
    fail(`Tag already exists on remote: ${tagName}`);
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

  let version = "";
  if (explicitVersion) {
    assertSemver(explicitVersion);
    version = explicitVersion;
  } else {
    version = readPackageVersion();
  }

  if (explicitVersion && isStableVersion(version)) {
    fail(
      "Stable releases must use --use-current-version after version bump is merged into main. " +
      "Use prerelease --version only for alpha/beta/rc cuts."
    );
  }

  runPreflight(config, { releaseVersion: version });

  if (explicitVersion) {
    setPackageVersion(version);
  } else if (isPrerelease(version) && !config.allowPrereleaseRelease) {
    fail(
      `Refusing prerelease version "${version}" with --use-current-version. ` +
      "Set preflight.allowPrereleaseRelease=true to override."
    );
  }

  const packageVersion = readPackageVersion();
  if (packageVersion !== version) {
    fail(`Version mismatch: package.json=${packageVersion}, expected=${version}`);
  }

  runReleaseChecks(config);
  const fetchState = fetchRemoteState(config);

  const tagName = `${config.tagPrefix}${version}`;
  ensureTagDoesNotExist(tagName, fetchState);
  createAnnotatedTag(tagName);
  pushRelease(config, tagName);
  printReleaseSuccess(version, tagName);
}

function main() {
  const { subcommand, options } = parseArgs(process.argv.slice(2));
  const config = parseReleaseConfig();

  if (subcommand === "preflight") {
    const overrideVersion = typeof options.version === "string" ? options.version.trim() : "";
    if (overrideVersion) {
      assertSemver(overrideVersion);
    }
    runPreflight(config, {
      releaseVersion: overrideVersion || undefined
    });
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
