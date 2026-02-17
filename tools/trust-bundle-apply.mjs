#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import Ajv from "ajv";

const EXIT_CODES = {
  healthy: 0,
  misconfigured: 2,
  invariant_failed: 3,
  unexpected: 1
};

const HELP = `IntentOS Trust Bundle Apply CLI

Usage:
  node tools/trust-bundle-apply.mjs --in <bundle.json> [--store <path>] [--policy off|warn|enforce] [--ci] [--json]

Options:
  --in <path>         trust bundle JSON input (required)
  --store <path>      snapshot store file or directory (optional; defaults to INTENTOS_TRUST_SNAPSHOT_STATE_PATH)
  --policy <mode>     off|warn|enforce (default warn)
  --ci                emit single-line JSON health output with deterministic exit code
  --json              emit pretty JSON output
  --help              show usage
`;

function normalizeNonEmptyString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOnOff(value) {
  const normalized = normalizeNonEmptyString(value).toLowerCase();
  if (normalized === "on" || normalized === "off") {
    return normalized;
  }
  return "off";
}

function normalizePolicy(value) {
  const normalized = normalizeNonEmptyString(value).toLowerCase();
  if (normalized === "off" || normalized === "warn" || normalized === "enforce") {
    return normalized;
  }
  return "warn";
}

function parseArgs(argv) {
  const options = {
    input: "",
    store: "",
    policy: "warn",
    ci: false,
    json: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--ci") {
      options.ci = true;
      continue;
    }
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--help") {
      options.help = true;
      continue;
    }
    if (token === "--in" || token === "--store" || token === "--policy") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        throw new Error(`Missing value for ${token}`);
      }
      index += 1;
      if (token === "--in") {
        options.input = next;
      } else if (token === "--store") {
        options.store = next;
      } else {
        options.policy = next;
      }
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  if (options.ci) {
    options.json = false;
  }

  return options;
}

function addIssue(state, severity, code, message, issuePath) {
  state.issues.push({
    severity,
    code,
    message,
    ...(issuePath ? { path: issuePath } : {})
  });
}

function classifyHealth(issues) {
  if (issues.some((issue) => issue.severity === "invariant_failed")) {
    return "invariant_failed";
  }
  if (issues.some((issue) => issue.severity === "misconfigured")) {
    return "misconfigured";
  }
  return "healthy";
}

function redactIssue(issue) {
  const redacted = {
    code: issue.code,
    message: issue.message
  };
  if (issue.path) {
    redacted.path = issue.path;
  }
  return redacted;
}

function printOutput(report, options) {
  if (options.ci) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(`health: ${report.health}\n`);
  process.stdout.write(`exitCode: ${report.exitCode}\n`);
  process.stdout.write(`applied: ${report.applied ? "yes" : "no"}\n`);
  if (Array.isArray(report.pathsWritten) && report.pathsWritten.length > 0) {
    process.stdout.write(`pathsWritten:\n`);
    for (const item of report.pathsWritten) {
      process.stdout.write(`- ${item}\n`);
    }
  }
  if (Array.isArray(report.issues) && report.issues.length > 0) {
    process.stdout.write(`issues:\n`);
    for (const issue of report.issues) {
      process.stdout.write(`- ${issue.code}: ${issue.message}${issue.path ? ` path=${issue.path}` : ""}\n`);
    }
  }
}

function stableStringifyJson(value) {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("non_finite_number");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringifyJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${stableStringifyJson(value[key])}`);
    return `{${parts.join(",")}}`;
  }
  throw new Error(`unsupported_value_type:${typeof value}`);
}

function computeBundleId(bundle) {
  return `sha256:${createHash("sha256").update(stableStringifyJson(bundle), "utf8").digest("hex")}`;
}

function deriveTransparencyHead(bundle) {
  if (bundle?.transparency?.head) {
    return {
      size: bundle.transparency.head.size,
      chainHash: bundle.transparency.head.chainHash
    };
  }
  if (bundle?.transparency?.latestCheckpoint) {
    return {
      size: bundle.transparency.latestCheckpoint.size,
      chainHash: bundle.transparency.latestCheckpoint.chainHash
    };
  }
  return undefined;
}

function computeAppliedSnapshotId(bundleId, transparencyHead) {
  return `sha256:${createHash("sha256")
    .update(
      stableStringifyJson({
        bundleId,
        transparencyHeadChainHash: transparencyHead?.chainHash ?? null,
        transparencyHeadSize: transparencyHead?.size ?? null
      }),
      "utf8"
    )
    .digest("hex")}`;
}

function resolveStorePaths(storeInput) {
  const normalized = normalizeNonEmptyString(storeInput);
  if (!normalized) {
    throw new Error("trust_bundle_apply_store_missing");
  }

  const resolved = path.resolve(normalized);
  const statePath = path.extname(resolved).toLowerCase() === ".json"
    ? resolved
    : path.join(resolved, "snapshot-state.json");
  const rootDir = path.dirname(statePath);
  return {
    rootDir,
    statePath,
    artifactsDir: path.join(rootDir, "bundle-artifacts")
  };
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
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Best-effort hardening.
    }

    try {
      dirFd = fs.openSync(parentDir, "r");
      fs.fsyncSync(dirFd);
      fs.closeSync(dirFd);
      dirFd = -1;
    } catch {
      // Best-effort directory sync.
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
    throw new Error(`trust_bundle_apply_atomic_write_failed:${message}`);
  }
}

function buildValidator() {
  const readSchema = (name) =>
    JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "spec", name), "utf8"));

  const ajv = new Ajv({ allErrors: true, strict: false });
  const anchorSchema = readSchema("identity-anchor-v0.4.schema.json");
  const anchorSetSchema = readSchema("identity-anchor-set-v0.4.schema.json");
  const revocationSetSchema = readSchema("revocation-set-v0.4.schema.json");
  const revocationProofSchema = readSchema("revocation-proof-v0.4.schema.json");
  const trustBundleSchema = readSchema("trust-bundle-v0.4.schema.json");

  ajv.addSchema(anchorSchema, anchorSchema.$id);
  ajv.addSchema(anchorSetSchema, anchorSetSchema.$id);
  ajv.addSchema(revocationSetSchema, revocationSetSchema.$id);
  ajv.addSchema(revocationProofSchema, revocationProofSchema.$id);
  return ajv.compile(trustBundleSchema);
}

function formatSchemaErrors(validate) {
  return (validate.errors || [])
    .map((error) => `${error.instancePath || "/"} ${error.message || "invalid"}`)
    .join("; ");
}

function runRevocationProofCheck(bundle, trustedKeysJsonArg) {
  if (!bundle.revocations) {
    return { ok: true, code: null };
  }

  if (!bundle.revocations.proof) {
    return { ok: false, code: "revocation_proof_missing" };
  }

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "aimtp-trust-bundle-apply-proof-"));
  try {
    const setPath = path.join(tempDir, "revocations.json");
    const proofPath = path.join(tempDir, "revocation-proof.json");
    fs.writeFileSync(setPath, `${JSON.stringify(bundle.revocations.set, null, 2)}\n`, "utf8");
    fs.writeFileSync(proofPath, `${JSON.stringify(bundle.revocations.proof, null, 2)}\n`, "utf8");

    const verifyToolPath = path.resolve(process.cwd(), "tools", "revocation-verify.mjs");
    const result = spawnSync(
      process.execPath,
      [
        verifyToolPath,
        "--set",
        setPath,
        "--proof",
        proofPath,
        "--trusted-keys-json",
        trustedKeysJsonArg
      ],
      { encoding: "utf8" }
    );

    if (result.status === 0) {
      return { ok: true, code: null };
    }

    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (output.includes("revocation_proof_key_unknown")) {
      return { ok: false, code: "revocation_proof_key_unknown" };
    }
    if (output.includes("revocation_proof_missing")) {
      return { ok: false, code: "revocation_proof_missing" };
    }
    return { ok: false, code: "revocation_proof_invalid" };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function resolveTrustedKeysArg() {
  const fromEnv = normalizeNonEmptyString(process.env.INTENTOS_TRUSTED_REVOCATION_KEYS_JSON);
  return fromEnv || "{}";
}

function downgradeInvariantToWarning(state, code, message, issuePath) {
  if (state.policy === "warn") {
    addIssue(state, "warning", code, message, issuePath);
    return true;
  }
  return false;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${message}\n\n${HELP}`);
    process.exit(EXIT_CODES.unexpected);
    return;
  }

  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const state = {
    policy: normalizePolicy(options.policy),
    issues: [],
    applied: false,
    pathsWritten: []
  };

  try {
    const inputPath = normalizeNonEmptyString(options.input);
    if (!inputPath) {
      addIssue(state, "misconfigured", "input_missing", "Missing --in path");
    }

    const resolvedInputPath = inputPath ? path.resolve(inputPath) : "";
    let bundle = null;

    if (resolvedInputPath) {
      try {
        fs.accessSync(resolvedInputPath, fs.constants.R_OK);
      } catch {
        addIssue(
          state,
          "misconfigured",
          "input_unreadable",
          "Trust bundle input file is missing or unreadable",
          resolvedInputPath
        );
      }
    }

    if (state.issues.length === 0 && resolvedInputPath) {
      try {
        bundle = JSON.parse(fs.readFileSync(resolvedInputPath, "utf8"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!downgradeInvariantToWarning(state, "trust_bundle_invalid", `Invalid JSON: ${message}`, resolvedInputPath)) {
          addIssue(state, "invariant_failed", "trust_bundle_invalid", `Invalid JSON: ${message}`, resolvedInputPath);
        }
      }
    }

    if (bundle && state.policy !== "off") {
      const validate = buildValidator();
      if (!validate(bundle)) {
        const detail = formatSchemaErrors(validate);
        if (!downgradeInvariantToWarning(state, "trust_bundle_invalid", detail, resolvedInputPath)) {
          addIssue(state, "invariant_failed", "trust_bundle_invalid", detail, resolvedInputPath);
        }
      }
    }

    if (
      bundle &&
      state.policy !== "off" &&
      normalizeOnOff(process.env.INTENTOS_REVOCATION_PROOF) === "on" &&
      !state.issues.some((issue) => issue.severity === "misconfigured" || issue.severity === "invariant_failed")
    ) {
      const proofResult = runRevocationProofCheck(bundle, resolveTrustedKeysArg());
      if (!proofResult.ok) {
        if (!downgradeInvariantToWarning(state, proofResult.code, proofResult.code, resolvedInputPath)) {
          addIssue(state, "invariant_failed", proofResult.code, proofResult.code, resolvedInputPath);
        }
      }
    }

    if (
      bundle &&
      state.policy !== "off" &&
      !state.issues.some((issue) => issue.severity === "misconfigured" || issue.severity === "invariant_failed")
    ) {
      const storeInput = normalizeNonEmptyString(options.store) || normalizeNonEmptyString(process.env.INTENTOS_TRUST_SNAPSHOT_STATE_PATH);
      if (!storeInput) {
        addIssue(state, "misconfigured", "store_missing", "Missing store path (--store or INTENTOS_TRUST_SNAPSHOT_STATE_PATH)");
      } else {
        try {
          const paths = resolveStorePaths(storeInput);
          fs.mkdirSync(paths.artifactsDir, { recursive: true });

          const bundlePath = path.join(paths.artifactsDir, "trust-bundle-v0.4.json");
          atomicWriteJson(bundlePath, bundle);
          state.pathsWritten.push(bundlePath);

          if (bundle.identityAnchors) {
            const anchorsPath = path.join(paths.artifactsDir, "identity-anchors-v0.4.json");
            atomicWriteJson(anchorsPath, bundle.identityAnchors.set);
            state.pathsWritten.push(anchorsPath);

            if (bundle.identityAnchors.proof) {
              const anchorProofPath = path.join(paths.artifactsDir, "identity-anchors-proof-v0.4.json");
              atomicWriteJson(anchorProofPath, bundle.identityAnchors.proof);
              state.pathsWritten.push(anchorProofPath);
            }
          }

          if (bundle.revocations) {
            const revocationsPath = path.join(paths.artifactsDir, "revocations-v0.4.json");
            atomicWriteJson(revocationsPath, bundle.revocations.set);
            state.pathsWritten.push(revocationsPath);

            if (bundle.revocations.proof) {
              const revocationProofPath = path.join(paths.artifactsDir, "revocations-proof-v0.4.json");
              atomicWriteJson(revocationProofPath, bundle.revocations.proof);
              state.pathsWritten.push(revocationProofPath);
            }
          }

          if (bundle.transparency?.head) {
            const headPath = path.join(paths.artifactsDir, "transparency-head-v0.4.json");
            atomicWriteJson(headPath, bundle.transparency.head);
            state.pathsWritten.push(headPath);
          }

          if (bundle.transparency?.latestCheckpoint) {
            const checkpointPath = path.join(paths.artifactsDir, "transparency-checkpoint-v0.4.json");
            atomicWriteJson(checkpointPath, bundle.transparency.latestCheckpoint);
            state.pathsWritten.push(checkpointPath);
          }

          const transparencyHead = deriveTransparencyHead(bundle);
          const bundleId = computeBundleId(bundle);
          const appliedSnapshotId = computeAppliedSnapshotId(bundleId, transparencyHead);
          const snapshotState = {
            ...(transparencyHead ? { transparencyHead } : {}),
            bundleId,
            appliedSnapshotId,
            fetchedAtMs: Date.now(),
            source: "trust_bundle_apply"
          };
          atomicWriteJson(paths.statePath, snapshotState);
          state.pathsWritten.push(paths.statePath);
          state.applied = true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!downgradeInvariantToWarning(state, "trust_bundle_apply_failed", message)) {
            addIssue(state, "invariant_failed", "trust_bundle_apply_failed", message);
          }
        }
      }
    }

    const health = classifyHealth(state.issues);
    const exitCode = EXIT_CODES[health] ?? EXIT_CODES.unexpected;

    const report = {
      health,
      exitCode,
      issues: state.issues.map((issue) => redactIssue(issue)),
      applied: state.applied,
      pathsWritten: state.pathsWritten
    };

    printOutput(report, options);
    process.exit(exitCode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const report = {
      health: "unexpected",
      exitCode: EXIT_CODES.unexpected,
      issues: [{ code: "unexpected", message }],
      applied: false
    };
    printOutput(report, options);
    process.exit(EXIT_CODES.unexpected);
  }
}

main();
