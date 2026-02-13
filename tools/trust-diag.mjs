#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HELP = `IntentOS Trust Diagnostics

Usage:
  node tools/trust-diag.mjs [options]

Options:
  --json    Emit a single-line JSON object
  --strict  Missing/invalid referenced inputs fail with non-zero exit
  --ci      CI mode (implies --json and returns health-based exit code)
  --help    Show this help
`;

const EXIT_CODES = {
  healthy: 0,
  misconfigured: 2,
  invariant_failed: 3,
  unexpected: 1
};

const DISTRIBUTION_ENV_KEYS = [
  "INTENTOS_TRUST_BUNDLE_PATH",
  "INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH",
  "INTENTOS_TRUST_HTTP_BUNDLE_URL",
  "INTENTOS_TRUST_HTTP_REVOCATIONS_URL",
  "INTENTOS_TRUST_HTTP_HEAD_URL",
  "INTENTOS_TRUST_HTTP_CHECKPOINT_URL",
  "INTENTOS_TRUST_HTTP_LOGTAIL_URL"
];

function dirnameFromImportMeta() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function normalizeNonEmptyString(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeMode(value, allowed, fallback) {
  const normalized = normalizeNonEmptyString(value)?.toLowerCase();
  if (normalized && allowed.has(normalized)) {
    return normalized;
  }
  return fallback;
}

function onOff(value) {
  return normalizeNonEmptyString(value)?.toLowerCase() === "on" ? "on" : "off";
}

function safeValue(value) {
  return value === undefined || value === null || value === "" ? "n/a" : value;
}

function parseArgs(argv) {
  const options = { json: false, strict: false, ci: false, help: false };
  for (const token of argv) {
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--strict") {
      options.strict = true;
      continue;
    }
    if (token === "--ci") {
      options.ci = true;
      continue;
    }
    if (token === "--help") {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (options.ci) {
    options.json = true;
  }
  return options;
}

function loadRuntimeModule(relativeDistPath) {
  const require = createRequire(import.meta.url);
  const absolutePath = path.resolve(dirnameFromImportMeta(), relativeDistPath);
  try {
    return { mod: require(absolutePath), error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { mod: null, error: message };
  }
}

function redactEnvValue(envKey, value) {
  if (value === "n/a") {
    return value;
  }
  if (/(private|secret|token)/i.test(envKey)) {
    return "***redacted***";
  }
  return value;
}

function checkReadableFile(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function parseJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function readLatestCheckpointFromJsonl(logPath) {
  const lines = fs
    .readFileSync(logPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let latest = null;
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      const kind = normalizeNonEmptyString(record?.kind)?.toLowerCase();
      if (kind === "checkpoint") {
        latest = record;
      }
    } catch {
      // parse errors are surfaced by strict runtime log parsing.
    }
  }

  return latest;
}

function addIssue(state, issue) {
  state.issues.push(issue);
  if (state.strict && !state.ci) {
    throw new Error(issue.message);
  }
}

function addDiagnostic(state, message) {
  state.diagnostics.push(message);
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

function toPublicIssue(issue) {
  const publicIssue = {
    code: issue.code,
    message: issue.message
  };
  if (issue.path) {
    publicIssue.path = issue.path;
  }
  return publicIssue;
}

function printHuman(report) {
  const lines = [
    ["INTENTOS", report.intentos.enabled],
    ["INTENTOS_MODE", report.mode.intentosMode],
    ["INTENTOS_TRUST_VERSION", report.trustVersion],
    ["INTENTOS_RECEIPT_POLICY", report.receiptPolicy],
    ["INTENTOS_TRUST_DISTRIBUTION", report.distribution.mode],
    ["distribution.target", report.distribution.target],
    ["INTENTOS_TRUST_SNAPSHOT_POLICY", report.snapshot.policyMode],
    ["snapshot.path", report.snapshot.path],
    ["snapshot.exists", report.snapshot.exists],
    ["snapshot.timestamp", report.snapshot.timestamp],
    ["snapshot.appliedSnapshotId", report.snapshot.appliedSnapshotId],
    ["snapshot.bundleId", report.snapshot.bundleId],
    ["snapshot.revocationsId", report.snapshot.revocationsId],
    ["transparency.path", report.transparency.path],
    ["transparency.exists", report.transparency.exists],
    ["transparency.entryCount", report.transparency.entryCount],
    ["transparency.head.chainHash", report.transparency.head.chainHash],
    ["transparency.head.size", report.transparency.head.size],
    ["transparency.checkpoint.size", report.transparency.checkpoint.size],
    ["transparency.checkpoint.chainHash", report.transparency.checkpoint.chainHash],
    ["transparency.checkpoint.createdAt", report.transparency.checkpoint.createdAt],
    ["transparency.checkpoint.signer", report.transparency.checkpoint.signer],
    ["proof.capability", report.proof.capability],
    ["proof.status", report.proof.status],
    ["proof.reason", report.proof.reason],
    ["contentIds.bundleId", report.contentIds.bundleId],
    ["contentIds.revocationsId", report.contentIds.revocationsId],
    ["contentIds.appliedSnapshotId", report.contentIds.appliedSnapshotId],
    ["health", report.health],
    ["exitCode", String(report.exitCode)]
  ];

  for (const [label, value] of lines) {
    process.stdout.write(`${label}: ${value}\n`);
  }

  for (const [key, value] of Object.entries(report.distribution.env)) {
    process.stdout.write(`distribution.env.${key}: ${value}\n`);
  }

  if (report.issues.length > 0) {
    for (const issue of report.issues) {
      const pathSuffix = issue.path ? ` path=${issue.path}` : "";
      process.stdout.write(`issue.${issue.code}: ${issue.message}${pathSuffix}\n`);
    }
  }

  if (report.diagnostics.length > 0) {
    process.stdout.write(`diagnostics: ${report.diagnostics.join(" | ")}\n`);
  }
}

function emitReport(report, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  printHuman(report);
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${message}\n\n${HELP}`);
    process.exit(EXIT_CODES.unexpected);
  }

  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const state = {
    strict: Boolean(options.strict),
    ci: Boolean(options.ci),
    diagnostics: [],
    issues: []
  };
  const env = process.env;

  try {
    const intentosEnabled = onOff(env.INTENTOS);
    const intentosMode = normalizeMode(env.INTENTOS_MODE, new Set(["log", "enforce"]), "log");
    const trustVersion = safeValue(normalizeNonEmptyString(env.INTENTOS_TRUST_VERSION));
    const receiptPolicy = normalizeMode(env.INTENTOS_RECEIPT_POLICY, new Set(["off", "warn", "enforce"]), "off");
    const distributionMode = normalizeMode(env.INTENTOS_TRUST_DISTRIBUTION, new Set(["off", "fs", "http"]), "off");
    const snapshotPolicy = normalizeMode(env.INTENTOS_TRUST_SNAPSHOT_POLICY, new Set(["off", "warn", "enforce"]), "off");

    if (trustVersion === "n/a") {
      addDiagnostic(state, "INTENTOS_TRUST_VERSION is not set");
    }

    const rawBundlePath = normalizeNonEmptyString(env.INTENTOS_TRUST_BUNDLE_PATH);
    const rawRevocationsPath = normalizeNonEmptyString(env.INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH);
    const rawSnapshotPath = normalizeNonEmptyString(env.INTENTOS_TRUST_SNAPSHOT_STATE_PATH);
    const rawLogPath = normalizeNonEmptyString(env.INTENTOS_TRANSPARENCY_LOG_PATH);
    const bundlePath = rawBundlePath ? path.resolve(rawBundlePath) : undefined;
    const revocationsPath = rawRevocationsPath ? path.resolve(rawRevocationsPath) : undefined;
    const snapshotPath = rawSnapshotPath ? path.resolve(rawSnapshotPath) : undefined;
    const logPath = rawLogPath ? path.resolve(rawLogPath) : undefined;

    const distributionEnv = {};
    for (const key of DISTRIBUTION_ENV_KEYS) {
      const raw = normalizeNonEmptyString(env[key]);
      const value = raw && key.endsWith("_PATH") ? path.resolve(raw) : raw;
      distributionEnv[key] = redactEnvValue(key, safeValue(value));
    }

    const referencedPaths = [
      { envKey: "INTENTOS_TRUST_BUNDLE_PATH", value: bundlePath },
      { envKey: "INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH", value: revocationsPath },
      { envKey: "INTENTOS_TRUST_SNAPSHOT_STATE_PATH", value: snapshotPath },
      { envKey: "INTENTOS_TRANSPARENCY_LOG_PATH", value: logPath }
    ];

    for (const ref of referencedPaths) {
      if (ref.value && !checkReadableFile(ref.value)) {
        addIssue(state, {
          severity: "misconfigured",
          code: "missing_path",
          message: `${ref.envKey} points to a missing/unreadable file`,
          path: ref.value
        });
      }
    }

    let snapshotExists = "n/a";
    let snapshotTimestamp = "n/a";
    let snapshotAppliedId = "n/a";
    let snapshotBundleId = "n/a";
    let snapshotRevocationsId = "n/a";

    if (snapshotPath) {
      snapshotExists = checkReadableFile(snapshotPath) ? "yes" : "no";
      if (snapshotExists === "yes") {
        try {
          const stateJson = parseJsonFile(snapshotPath);
          snapshotTimestamp =
            typeof stateJson?.fetchedAtMs === "number" && Number.isFinite(stateJson.fetchedAtMs)
              ? new Date(stateJson.fetchedAtMs).toISOString()
              : "n/a";
          snapshotAppliedId = safeValue(normalizeNonEmptyString(stateJson?.appliedSnapshotId));
          snapshotBundleId = safeValue(normalizeNonEmptyString(stateJson?.bundleId));
          snapshotRevocationsId = safeValue(normalizeNonEmptyString(stateJson?.revocationsId));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          addIssue(state, {
            severity: "invariant_failed",
            code: "snapshot_state_invalid_json",
            message: `Failed to parse snapshot state file: ${message}`,
            path: snapshotPath
          });
        }
      }
    }

    const trustTransparency = loadRuntimeModule("../dist/runtime/intentos/trust-transparency.js");
    const trustIds = loadRuntimeModule("../dist/runtime/intentos/trust-ids.js");

    let transparencyExists = "n/a";
    let transparencyEntryCount = "n/a";
    let transparencyHeadHash = "n/a";
    let transparencyHeadSize = "n/a";
    let transparencyHeadObj = null;
    const checkpoint = {
      size: "n/a",
      chainHash: "n/a",
      createdAt: "n/a",
      signer: "n/a"
    };

    if (logPath) {
      transparencyExists = checkReadableFile(logPath) ? "yes" : "no";
      if (transparencyExists === "yes") {
        if (!trustTransparency.mod) {
          addIssue(state, {
            severity: "invariant_failed",
            code: "transparency_module_unavailable",
            message: `Transparency runtime module unavailable: ${safeValue(trustTransparency.error)}`,
            path: logPath
          });
        } else {
          try {
            const entries = trustTransparency.mod.loadTransparencyLog(logPath);
            const head = trustTransparency.mod.computeTransparencyHead(entries);
            transparencyEntryCount = String(entries.length);
            transparencyHeadHash = safeValue(head?.chainHash);
            transparencyHeadSize =
              typeof head?.size === "number" && Number.isFinite(head.size) ? String(head.size) : "n/a";
            if (transparencyHeadHash !== "n/a" && transparencyHeadSize !== "n/a") {
              transparencyHeadObj = {
                chainHash: transparencyHeadHash,
                size: Number.parseInt(transparencyHeadSize, 10)
              };
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            addIssue(state, {
              severity: "invariant_failed",
              code: "transparency_log_invalid",
              message: `Failed to inspect transparency log: ${message}`,
              path: logPath
            });
          }

          try {
            const verification = trustTransparency.mod.verifyTransparencyLog(logPath);
            if (!verification?.valid) {
              addIssue(state, {
                severity: "invariant_failed",
                code: "transparency_verify_failed",
                message: `Transparency verification failed: ${safeValue(verification?.reason)}`,
                path: logPath
              });
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            addIssue(state, {
              severity: "invariant_failed",
              code: "transparency_verify_failed",
              message: `Transparency verification failed: ${message}`,
              path: logPath
            });
          }
        }

        try {
          const latest = readLatestCheckpointFromJsonl(logPath);
          if (latest && typeof latest === "object") {
            checkpoint.size = Number.isInteger(latest.size) && latest.size >= 0 ? String(latest.size) : "n/a";
            checkpoint.chainHash = safeValue(normalizeNonEmptyString(latest.chainHash));
            checkpoint.createdAt = safeValue(normalizeNonEmptyString(latest.createdAt));
            checkpoint.signer = safeValue(normalizeNonEmptyString(latest.signer));
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          addIssue(state, {
            severity: "invariant_failed",
            code: "checkpoint_scan_failed",
            message: `Failed to scan checkpoints from transparency log: ${message}`,
            path: logPath
          });
        }
      }
    }

    const proofCapability =
      trustTransparency.mod && typeof trustTransparency.mod.verifyTransparencyProof === "function"
        ? "supported"
        : "not supported";

    const proof = {
      capability: proofCapability,
      status: "skipped",
      reason:
        proofCapability === "supported"
          ? "diagnostics mode only (no proof material provided)"
          : `verify functions unavailable: ${safeValue(trustTransparency.error)}`
    };

    let bundleId = "n/a";
    let revocationsId = "n/a";
    let appliedSnapshotId = "n/a";

    const trustIdInputsConfigured = Boolean(bundlePath || revocationsPath || transparencyHeadObj);
    if (!trustIds.mod && trustIdInputsConfigured) {
      addIssue(state, {
        severity: "invariant_failed",
        code: "trust_ids_module_unavailable",
        message: `Trust IDs runtime module unavailable: ${safeValue(trustIds.error)}`
      });
    }

    if (trustIds.mod) {
      if (bundlePath && checkReadableFile(bundlePath)) {
        try {
          const bundle = parseJsonFile(bundlePath);
          if (bundle && typeof bundle === "object" && !Array.isArray(bundle)) {
            bundleId = trustIds.mod.computeBundleId(bundle);
          } else {
            addIssue(state, {
              severity: "invariant_failed",
              code: "bundle_invalid_shape",
              message: "Trust bundle JSON must be an object",
              path: bundlePath
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          addIssue(state, {
            severity: "invariant_failed",
            code: "bundle_id_compute_failed",
            message: `Failed to compute bundle ID: ${message}`,
            path: bundlePath
          });
        }
      }

      if (revocationsPath && checkReadableFile(revocationsPath)) {
        try {
          const revocations = parseJsonFile(revocationsPath);
          revocationsId = trustIds.mod.computeRevocationsId(revocations);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          addIssue(state, {
            severity: "invariant_failed",
            code: "revocations_id_compute_failed",
            message: `Failed to compute revocations ID: ${message}`,
            path: revocationsPath
          });
        }
      }

      if (bundleId !== "n/a" || revocationsId !== "n/a" || transparencyHeadObj) {
        try {
          appliedSnapshotId = trustIds.mod.computeAppliedSnapshotId({
            ...(bundleId !== "n/a" ? { bundleId } : {}),
            ...(revocationsId !== "n/a" ? { revocationsId } : {}),
            ...(transparencyHeadObj ? { transparencyHead: transparencyHeadObj } : {})
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          addIssue(state, {
            severity: "invariant_failed",
            code: "applied_snapshot_id_compute_failed",
            message: `Failed to compute applied snapshot ID: ${message}`
          });
        }
      }
    }

    if (appliedSnapshotId === "n/a" && snapshotAppliedId !== "n/a") {
      appliedSnapshotId = snapshotAppliedId;
    }

    const health = classifyHealth(state.issues);
    const healthExitCode = EXIT_CODES[health];
    const report = {
      intentos: {
        enabled: intentosEnabled
      },
      mode: {
        intentosMode
      },
      trustVersion,
      receiptPolicy,
      distribution: {
        mode: distributionMode,
        target:
          distributionMode === "fs"
            ? safeValue(bundlePath)
            : distributionMode === "http"
              ? safeValue(normalizeNonEmptyString(env.INTENTOS_TRUST_HTTP_BUNDLE_URL))
              : "n/a",
        env: distributionEnv
      },
      snapshot: {
        policyMode: snapshotPolicy,
        path: safeValue(snapshotPath),
        exists: snapshotExists,
        timestamp: snapshotTimestamp,
        appliedSnapshotId: snapshotAppliedId,
        bundleId: snapshotBundleId,
        revocationsId: snapshotRevocationsId
      },
      transparency: {
        path: safeValue(logPath),
        exists: transparencyExists,
        entryCount: transparencyEntryCount,
        head: {
          chainHash: transparencyHeadHash,
          size: transparencyHeadSize
        },
        checkpoint
      },
      proof,
      contentIds: {
        bundleId,
        revocationsId,
        appliedSnapshotId
      },
      diagnostics: state.diagnostics,
      health,
      exitCode: healthExitCode,
      issues: state.issues.map((issue) => toPublicIssue(issue))
    };

    emitReport(report, options.json);
    if (options.ci) {
      process.exit(healthExitCode);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.ci) {
      const report = {
        health: "invariant_failed",
        exitCode: EXIT_CODES.unexpected,
        issues: [
          {
            code: "unexpected_error",
            message
          }
        ]
      };
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } else {
      console.error(message);
    }
    process.exit(EXIT_CODES.unexpected);
  }
}

main();
