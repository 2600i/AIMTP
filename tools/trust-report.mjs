#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HELP = `IntentOS Trust Report CLI

Usage:
  node tools/trust-report.mjs [options]

Options:
  --env-file <path>         Load KEY=VALUE pairs (no interpolation); process.env wins
  --bundle <path>           Trust bundle JSON path
  --revocations <path>      Trust revocations JSON path
  --log <path>              Transparency log JSONL path
  --checkpoint-key <path>   Checkpoint public key PEM path
  --state <path>            Trust snapshot state JSON path
  --include-volatile        Include generatedAt timestamp
  --pretty                  Pretty-print JSON output (2-space indent)
  --help                    Show this help
`;

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

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableStringify(value) {
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
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${parts.join(",")}}`;
  }
  throw new Error(`unsupported_value_type:${typeof value}`);
}

function toStableValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => toStableValue(entry));
  }
  if (isPlainObject(value)) {
    const result = {};
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .forEach((key) => {
        result[key] = toStableValue(value[key]);
      });
    return result;
  }
  return value;
}

function stableJsonStringify(value, pretty) {
  const stableValue = toStableValue(value);
  return JSON.stringify(stableValue, null, pretty ? 2 : 0);
}

function parseArgs(argv) {
  const options = {};
  const needsValue = new Set(["env-file", "bundle", "revocations", "log", "checkpoint-key", "state"]);
  const booleanFlags = new Set(["include-volatile", "pretty", "help"]);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unknown argument: ${token}`);
    }
    const key = token.slice(2);
    if (!needsValue.has(key) && !booleanFlags.has(key)) {
      throw new Error(`Unknown argument: --${key}`);
    }
    if (booleanFlags.has(key)) {
      options[key] = true;
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    options[key] = value;
    index += 1;
  }
  return options;
}

function parseEnvFile(content, sourcePath) {
  const parsed = {};
  const lines = content.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const raw = lines[lineIndex].trim();
    if (!raw || raw.startsWith("#")) {
      continue;
    }
    const equalsIndex = raw.indexOf("=");
    if (equalsIndex <= 0) {
      throw new Error(`Invalid env-file entry at ${sourcePath}:${lineIndex + 1}`);
    }
    const key = raw.slice(0, equalsIndex).trim();
    const value = raw.slice(equalsIndex + 1);
    if (!key) {
      throw new Error(`Invalid env-file entry at ${sourcePath}:${lineIndex + 1}`);
    }
    parsed[key] = value;
  }
  return parsed;
}

function loadEnv(options) {
  if (!options["env-file"]) {
    return { ...process.env };
  }
  const envPath = path.resolve(options["env-file"]);
  const fileContent = fs.readFileSync(envPath, "utf8");
  const fromFile = parseEnvFile(fileContent, envPath);
  return {
    ...fromFile,
    ...process.env
  };
}

function resolveMode({
  env,
  key,
  allowed,
  defaultIfAbsent,
  diagnostics
}) {
  const rawValue = env[key];
  const normalized = normalizeNonEmptyString(rawValue)?.toLowerCase();
  if (!normalized) {
    return defaultIfAbsent;
  }
  if (allowed.has(normalized)) {
    return normalized;
  }
  diagnostics.push({
    key,
    value: String(rawValue),
    reason: "invalid_mode"
  });
  return "unknown";
}

function readJsonFileStrict(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function resolvePathPreference(primary, fallback) {
  const selected = normalizeNonEmptyString(primary) ?? normalizeNonEmptyString(fallback);
  return selected ? path.resolve(selected) : undefined;
}

function loadRuntimeModule(relativeDistPath) {
  const require = createRequire(import.meta.url);
  const absolutePath = path.resolve(dirnameFromImportMeta(), relativeDistPath);
  try {
    return require(absolutePath);
  } catch {
    throw new Error(`Missing ${relativeDistPath.replace("../", "")}. Run: npm run build`);
  }
}

function parseTransparencyRecordsForCheckpoint(logPath) {
  const raw = fs.readFileSync(logPath, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid JSONL at ${logPath}:${index + 1}: ${message}`);
    }
  });
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${message}\n\n${HELP}`);
    process.exit(1);
  }

  if (options.help) {
    console.log(HELP);
    return;
  }

  try {
    const env = loadEnv(options);
    const packageJsonPath = path.resolve(dirnameFromImportMeta(), "../package.json");
    const pkg = readJsonFileStrict(packageJsonPath);
    const version = normalizeNonEmptyString(pkg.version) ?? "unknown";

    const bundlePath = resolvePathPreference(options.bundle, env.INTENTOS_TRUST_BUNDLE_PATH);
    const revocationsPath = resolvePathPreference(options.revocations, env.INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH);
    const logPath = resolvePathPreference(options.log, env.INTENTOS_TRANSPARENCY_LOG_PATH);
    const statePath = resolvePathPreference(options.state, env.INTENTOS_TRUST_SNAPSHOT_STATE_PATH);
    const checkpointKeyPath = resolvePathPreference(options["checkpoint-key"], undefined);
    if (checkpointKeyPath && !logPath) {
      throw new Error("--checkpoint-key requires a transparency log path (--log or INTENTOS_TRANSPARENCY_LOG_PATH)");
    }

    const invalidEnv = [];
    const modes = {
      trustVersion: resolveMode({
        env,
        key: "INTENTOS_TRUST_VERSION",
        allowed: new Set(["v1", "v2"]),
        defaultIfAbsent: "unknown",
        diagnostics: invalidEnv
      }),
      receiptPolicy: resolveMode({
        env,
        key: "INTENTOS_RECEIPT_POLICY",
        allowed: new Set(["off", "warn", "enforce"]),
        defaultIfAbsent: "unknown",
        diagnostics: invalidEnv
      }),
      transparencyLogMode: resolveMode({
        env,
        key: "INTENTOS_TRANSPARENCY_LOG_MODE",
        allowed: new Set(["off", "append", "verify"]),
        defaultIfAbsent: "off",
        diagnostics: invalidEnv
      }),
      transparencyCheckpointMode: resolveMode({
        env,
        key: "INTENTOS_TRANSPARENCY_CHECKPOINT_MODE",
        allowed: new Set(["off", "append", "verify"]),
        defaultIfAbsent: "off",
        diagnostics: invalidEnv
      }),
      trustDistribution: resolveMode({
        env,
        key: "INTENTOS_TRUST_DISTRIBUTION",
        allowed: new Set(["off", "fs", "http"]),
        defaultIfAbsent: "off",
        diagnostics: invalidEnv
      }),
      trustSnapshotPolicy: resolveMode({
        env,
        key: "INTENTOS_TRUST_SNAPSHOT_POLICY",
        allowed: new Set(["off", "warn", "enforce"]),
        defaultIfAbsent: "off",
        diagnostics: invalidEnv
      })
    };

    const report = {
      version,
      modes
    };
    if (invalidEnv.length > 0) {
      report.diagnostics = {
        invalidEnv
      };
    }

    const paths = {};
    if (bundlePath) {
      paths.bundle = bundlePath;
    }
    if (revocationsPath) {
      paths.revocations = revocationsPath;
    }
    if (logPath) {
      paths.log = logPath;
    }
    if (checkpointKeyPath) {
      paths["checkpointKey"] = checkpointKeyPath;
    }
    if (statePath) {
      paths.state = statePath;
    }
    if (Object.keys(paths).length > 0) {
      report.paths = paths;
    }

    const ids = {};
    let transparencyHead;

    if (bundlePath || revocationsPath || logPath) {
      var trustIds = loadRuntimeModule("../dist/runtime/intentos/trust-ids.js");
    }

    if (bundlePath) {
      if (!fs.existsSync(bundlePath)) {
        throw new Error(`Missing bundle file: ${bundlePath}`);
      }
      const bundle = readJsonFileStrict(bundlePath);
      if (!isPlainObject(bundle)) {
        throw new Error(`Bundle must be a JSON object: ${bundlePath}`);
      }
      ids.bundleId = trustIds.computeBundleId(bundle);
    }

    if (revocationsPath) {
      if (!fs.existsSync(revocationsPath)) {
        throw new Error(`Missing revocations file: ${revocationsPath}`);
      }
      const revocations = readJsonFileStrict(revocationsPath);
      ids.revocationsId = trustIds.computeRevocationsId(revocations);
    }

    if (logPath) {
      if (!fs.existsSync(logPath)) {
        throw new Error(`Missing transparency log file: ${logPath}`);
      }
      const trustTransparency = loadRuntimeModule("../dist/runtime/intentos/trust-transparency.js");
      const entries = trustTransparency.loadTransparencyLog(logPath);
      const head = trustTransparency.computeTransparencyHead(entries);
      transparencyHead = head;
      const transparency = {
        head,
        logChainIntact: trustTransparency.verifyTransparencyLog(logPath).valid
      };

      if (checkpointKeyPath) {
        if (!fs.existsSync(checkpointKeyPath)) {
          throw new Error(`Missing checkpoint key file: ${checkpointKeyPath}`);
        }
        const checkpointPublicKeyPem = fs.readFileSync(checkpointKeyPath, "utf8");
        const records = parseTransparencyRecordsForCheckpoint(logPath);
        const checkpointMatch = trustTransparency.findLatestValidCheckpoint(records, checkpointPublicKeyPem);
        if (checkpointMatch?.checkpoint) {
          transparency.checkpointUsed = {
            size: checkpointMatch.checkpoint.size,
            chainHash: checkpointMatch.checkpoint.chainHash,
            signer: checkpointMatch.checkpoint.signer
          };
        }
      }

      report.transparency = transparency;
    }

    if ((ids.bundleId || ids.revocationsId || transparencyHead) && !ids.appliedSnapshotId) {
      ids.appliedSnapshotId = trustIds.computeAppliedSnapshotId({
        ...(ids.bundleId ? { bundleId: ids.bundleId } : {}),
        ...(ids.revocationsId ? { revocationsId: ids.revocationsId } : {}),
        ...(transparencyHead ? { transparencyHead } : {})
      });
    }

    if (statePath) {
      if (!fs.existsSync(statePath)) {
        throw new Error(`Missing snapshot state file: ${statePath}`);
      }
      const trustSnapshotStore = loadRuntimeModule("../dist/runtime/intentos/trust-snapshot-store.js");
      const store = new trustSnapshotStore.FileTrustSnapshotStore(statePath);
      const snapshotState = store.load();
      if (snapshotState !== null) {
        report.snapshotState = snapshotState;
        if (!ids.appliedSnapshotId && normalizeNonEmptyString(snapshotState.appliedSnapshotId)) {
          ids.appliedSnapshotId = snapshotState.appliedSnapshotId;
        }
      }
    }

    if (Object.keys(ids).length > 0) {
      report.ids = ids;
    }

    if (options["include-volatile"]) {
      report.generatedAt = new Date().toISOString();
    }

    process.stdout.write(`${stableJsonStringify(report, Boolean(options.pretty))}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}

main();
