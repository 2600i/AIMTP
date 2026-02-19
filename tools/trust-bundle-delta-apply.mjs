#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const HELP = `IntentOS Trust Bundle Delta Apply CLI

Usage:
  node tools/trust-bundle-delta-apply.mjs --state <path> --delta <path> [--out <path>] [--trust-version v1|v2]

Options:
  --state <path>         current trust bundle state file path (required)
  --delta <path>         delta JSON file path (required)
  --out <path>           output file path (optional; defaults to --state)
  --trust-version <ver>  v1|v2 (optional; default v2)
  --help                 show usage
`;

function normalizeNonEmptyString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTrustVersion(value) {
  return normalizeNonEmptyString(value).toLowerCase() === "v1" ? "v1" : "v2";
}

function parseArgs(argv) {
  const options = {
    state: "",
    delta: "",
    out: "",
    trustVersion: "v2",
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help") {
      options.help = true;
      continue;
    }
    if (token === "--state" || token === "--delta" || token === "--out" || token === "--trust-version") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        throw new Error(`missing value for ${token}`);
      }
      index += 1;
      if (token === "--state") {
        options.state = next;
      } else if (token === "--delta") {
        options.delta = next;
      } else if (token === "--out") {
        options.out = next;
      } else {
        options.trustVersion = next;
      }
      continue;
    }
    throw new Error(`unknown argument: ${token}`);
  }

  return options;
}

function isTrustErrorCode(code) {
  return /^TRUST_[A-Z_]+$/.test(code);
}

function atomicWriteJson(filePath, payload) {
  const parentDir = path.dirname(filePath);
  fs.mkdirSync(parentDir, { recursive: true });

  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  let tempFd = -1;
  let dirFd = -1;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });

    tempFd = fs.openSync(tempPath, "r");
    fs.fsyncSync(tempFd);
    fs.closeSync(tempFd);
    tempFd = -1;

    fs.renameSync(tempPath, filePath);
    try {
      dirFd = fs.openSync(parentDir, "r");
      fs.fsyncSync(dirFd);
      fs.closeSync(dirFd);
      dirFd = -1;
    } catch {
      // Best-effort directory fsync.
    }
  } catch (error) {
    if (tempFd !== -1) {
      try {
        fs.closeSync(tempFd);
      } catch {
        // Best-effort cleanup.
      }
    }
    if (dirFd !== -1) {
      try {
        fs.closeSync(dirFd);
      } catch {
        // Best-effort cleanup.
      }
    }
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best-effort cleanup.
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`TRUST_BUNDLE_INVALID:delta_write_failed:${message}`);
  }
}

function loadJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`TRUST_BUNDLE_INVALID:${label}:${message}`);
  }
}

function resolveRuntimeApi() {
  const require = createRequire(import.meta.url);
  try {
    return require(path.resolve(process.cwd(), "dist", "index.js"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`TRUST_BUNDLE_INVALID:dist_load_failed:${message}`);
  }
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(HELP);
      return;
    }

    const statePath = normalizeNonEmptyString(options.state);
    const deltaPath = normalizeNonEmptyString(options.delta);
    const outPath = normalizeNonEmptyString(options.out);
    if (!statePath || !deltaPath) {
      throw new Error("TRUST_BUNDLE_INVALID:state_and_delta_required");
    }

    const trustVersion = normalizeTrustVersion(options.trustVersion);
    const resolvedStatePath = path.resolve(statePath);
    const resolvedDeltaPath = path.resolve(deltaPath);
    const resolvedOutPath = outPath ? path.resolve(outPath) : resolvedStatePath;
    const runtimeApi = resolveRuntimeApi();
    const { applyTrustBundleDelta, applyTrustBundleDeltaToPath } = runtimeApi;

    if (typeof applyTrustBundleDelta !== "function" || typeof applyTrustBundleDeltaToPath !== "function") {
      throw new Error("TRUST_BUNDLE_INVALID:delta_api_unavailable");
    }

    const delta = loadJson(resolvedDeltaPath, "delta_json_invalid");
    const env = {
      ...process.env,
      INTENTOS_TRUST_VERSION: trustVersion
    };

    if (resolvedOutPath === resolvedStatePath) {
      applyTrustBundleDeltaToPath(resolvedStatePath, delta, { env });
    } else {
      const currentState = loadJson(resolvedStatePath, "state_json_invalid");
      const nextState = applyTrustBundleDelta(currentState, delta, { env });
      atomicWriteJson(resolvedOutPath, nextState);
    }

    process.stdout.write("OK\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const prefix = normalizeNonEmptyString(message.split(":", 1)[0]);
    const code = isTrustErrorCode(prefix) ? prefix : "TRUST_BUNDLE_INVALID";
    process.stdout.write(`ERROR ${code} ${message}\n`);
    process.exit(1);
  }
}

main();
