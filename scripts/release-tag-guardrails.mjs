#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawnSync } from "node:child_process";
import {
  evaluateStableTagGuardrails,
  parseParentCountFromRevList
} from "./release-guardrails.mjs";

const CONFIG_PATH = path.resolve(process.cwd(), ".aimtp", "release.yml");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args) {
  const printable = `${command} ${args.join(" ")}`.trim();
  console.log(`$ ${printable}`);
  const result = spawnSync(command, args, { stdio: "inherit" });
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
  let tag = "";
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--tag") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        fail("Missing value for --tag");
      }
      tag = value.trim();
      index += 1;
      continue;
    }
    fail(`Unknown argument: ${token}`);
  }
  return { tag };
}

function resolveTagName(cliTag) {
  if (cliTag) {
    return cliTag;
  }
  const refName = String(process.env.GITHUB_REF_NAME ?? "").trim();
  if (refName) {
    return refName;
  }
  const ref = String(process.env.GITHUB_REF ?? "").trim();
  if (ref.startsWith("refs/tags/")) {
    return ref.slice("refs/tags/".length);
  }
  fail("Unable to resolve tag name. Pass --tag <name> or set GITHUB_REF_NAME.");
}

function parseReleaseConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fail(`Missing release config: ${CONFIG_PATH}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`Failed to parse ${CONFIG_PATH}: ${message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`Invalid release config: ${CONFIG_PATH} must be an object`);
  }

  return {
    branch: String(parsed.branch ?? "main").trim() || "main",
    remote: String(parsed.remote ?? "origin").trim() || "origin",
    tagPrefix: String(parsed.tagPrefix ?? "v").trim() || "v",
    requirePrMergeForStable: parsed.requirePrMergeForStable !== false,
    stableMergeStrategy: String(
      parsed.stableMergeStrategy ?? parsed.preflight?.stableMergeStrategy ?? "merge_commit"
    )
      .trim()
      .toLowerCase(),
    squashMarkers: Array.isArray(parsed.squashMarkers)
      ? parsed.squashMarkers
      : Array.isArray(parsed.preflight?.squashMarkers)
        ? parsed.preflight.squashMarkers
        : []
  };
}

function isCommitReachableFromRemoteMain(commitSha, remoteRef) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", commitSha, remoteRef], {
    stdio: "pipe"
  });
  if (result.error) {
    fail(`Failed to run "git merge-base --is-ancestor": ${result.error.message}`);
  }
  if (result.status === 0) {
    return true;
  }
  if (result.status === 1) {
    return false;
  }
  const stderr = String(result.stderr ?? "").trim();
  fail(`Failed to run "git merge-base --is-ancestor": ${stderr || "unknown error"}`);
}

function main() {
  const { tag: cliTag } = parseArgs(process.argv.slice(2));
  const tagName = resolveTagName(cliTag);
  const config = parseReleaseConfig();
  const remoteMainRef = `${config.remote}/${config.branch}`;

  read("git", ["rev-parse", "--verify", `refs/tags/${tagName}`]);
  const tagObjectType = read("git", ["cat-file", "-t", `refs/tags/${tagName}`]);
  const commitSha = read("git", ["rev-list", "-n", "1", tagName]);

  run("git", ["fetch", config.remote, config.branch, "--no-tags"]);

  const parentLine = read("git", ["rev-list", "--parents", "-n", "1", commitSha]);
  const subject = read("git", ["show", "-s", "--format=%s", commitSha]);
  const message = read("git", ["log", "-1", "--pretty=%B", commitSha]);
  const decision = evaluateStableTagGuardrails({
    tagName,
    tagPrefix: config.tagPrefix,
    isAnnotatedTag: tagObjectType === "tag",
    commitOnMain: isCommitReachableFromRemoteMain(commitSha, remoteMainRef),
    parentCount: parseParentCountFromRevList(parentLine),
    subject,
    message,
    requirePrMergeForStable: config.requirePrMergeForStable,
    stableMergeStrategy: config.stableMergeStrategy,
    squashMarkers: config.squashMarkers
  });

  if (!decision.allowed) {
    fail(`Tag guardrails failed for ${tagName}: ${decision.message}`);
  }

  console.log(`Tag guardrails passed for ${tagName}.`);
}

main();
