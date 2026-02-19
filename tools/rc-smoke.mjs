#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const TRUST_ENV_KEYS = [
  "INTENTOS_TRUST_VERSION",
  "INTENTOS_RECEIPT_POLICY",
  "INTENTOS_TRUST_DISTRIBUTION",
  "INTENTOS_TRUST_BUNDLE_PATH",
  "INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH",
  "INTENTOS_TRUST_SNAPSHOT_POLICY",
  "INTENTOS_TRUST_SNAPSHOT_STATE_PATH",
  "INTENTOS_TRANSPARENCY_LOG_PATH",
  "INTENTOS_TRANSPARENCY_LOG_MODE",
  "INTENTOS_TRANSPARENCY_CHECKPOINT_MODE",
  "INTENTOS_TRANSPARENCY_CHECKPOINT_PUBLIC_KEY"
];

const ISSUER = "relay://demo";

function dirnameFromImportMeta() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function repoRoot() {
  return path.resolve(dirnameFromImportMeta(), "..");
}

function parseArgs(argv) {
  const options = {
    dir: `/tmp/aimtp-rc-smoke-${process.pid}`
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --dir");
      }
      options.dir = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return options;
}

function createCleanChildEnv() {
  const env = { ...process.env };
  for (const key of TRUST_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

function loadDistModule(relativePath) {
  const root = repoRoot();
  const require = createRequire(import.meta.url);
  const absolute = path.resolve(root, relativePath);
  try {
    return require(absolute);
  } catch {
    throw new Error(`Missing ${relativePath}. Run: npm run build`);
  }
}

function runTrustReport(args = []) {
  const root = repoRoot();
  const output = execFileSync(
    process.execPath,
    [path.join(root, "tools", "trust-report.mjs"), ...args],
    {
      cwd: root,
      encoding: "utf8",
      env: createCleanChildEnv()
    }
  );
  return JSON.parse(output);
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function appendJsonl(filePath, value) {
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function makeSignedReceipt(signReceipt, privateKeyPem, suffix, trustVersion = "v2") {
  return signReceipt(
    {
      receiptId: `rc-smoke-receipt-${suffix}`,
      envelopeId: `rc-smoke-envelope-${suffix}`,
      intentId: `rc-smoke-intent-${suffix}`,
      type: "receipt.completed",
      timestamp: "2026-02-12T12:00:00.000Z",
      metadata: { outputHash: `rc-smoke-output-${suffix}` }
    },
    privateKeyPem,
    ISSUER,
    { trustVersion }
  );
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function summarize(results, demoDir) {
  console.log("\nRC smoke summary");
  results.forEach((result) => {
    const prefix = result.ok ? "PASS" : "FAIL";
    const detail = result.detail ? `: ${result.detail}` : "";
    console.log(`${prefix} ${result.step}${detail}`);
  });
  console.log(`demoDir: ${demoDir}`);
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`FAIL args: ${message}`);
    process.exit(1);
  }

  const results = [];
  const step = (name, fn) => {
    try {
      const detail = fn();
      results.push({ step: name, ok: true, detail: detail ?? "" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ step: name, ok: false, detail: message });
      summarize(results, options.dir);
      process.exit(1);
    }
  };

  const trustTransparency = loadDistModule("dist/runtime/intentos/trust-transparency.js");
  const receiptPolicy = loadDistModule("dist/runtime/intentos/receipt-policy.js");
  const receipts = loadDistModule("dist/protocol/intentos-receipts.js");

  const demoDir = options.dir;
  const bundlePath = path.join(demoDir, "bundle.json");
  const revocationsPath = path.join(demoDir, "revocations.json");
  const logPath = path.join(demoDir, "log.jsonl");
  const statePath = path.join(demoDir, "state.json");
  const v2StatePath = path.join(demoDir, "state-v2.json");
  const envFilePath = path.join(demoDir, ".env.smoke");
  const checkpointPrivPath = path.join(demoDir, "checkpoint-priv.pem");
  const checkpointPubPath = path.join(demoDir, "checkpoint-pub.pem");
  const issuerPrivPath = path.join(demoDir, "issuer-priv.pem");
  const issuerPubPath = path.join(demoDir, "issuer-pub.pem");

  let checkpointPublicKeyPem = "";
  let issuerPrivateKeyPem = "";

  step("setup demo dir", () => {
    fs.rmSync(demoDir, { recursive: true, force: true });
    fs.mkdirSync(demoDir, { recursive: true });
    return demoDir;
  });

  step("generate demo keys", () => {
    const checkpoint = generateKeyPairSync("ed25519");
    const issuer = generateKeyPairSync("ed25519");
    fs.writeFileSync(
      checkpointPrivPath,
      checkpoint.privateKey.export({ type: "pkcs8", format: "pem" })
    );
    fs.writeFileSync(
      checkpointPubPath,
      checkpoint.publicKey.export({ type: "spki", format: "pem" })
    );
    fs.writeFileSync(
      issuerPrivPath,
      issuer.privateKey.export({ type: "pkcs8", format: "pem" })
    );
    fs.writeFileSync(
      issuerPubPath,
      issuer.publicKey.export({ type: "spki", format: "pem" })
    );
    checkpointPublicKeyPem = fs.readFileSync(checkpointPubPath, "utf8");
    issuerPrivateKeyPem = fs.readFileSync(issuerPrivPath, "utf8");
    return "ok";
  });

  step("write bundle and revocations", () => {
    const issuerPublicKeyPem = fs.readFileSync(issuerPubPath, "utf8");
    writeJson(bundlePath, {
      bundleVersion: "v3",
      bundleId: "aimtp-rc-smoke-bundle-v3",
      issuedAtSec: 1767225600,
      issuers: {
        [ISSUER]: {
          keys: [{ kid: "relay-a", alg: "ed25519", publicKeyPem: issuerPublicKeyPem }]
        }
      }
    });
    writeJson(revocationsPath, {
      signers: [],
      issuerKeys: {}
    });
    fs.writeFileSync(logPath, "", "utf8");
    return "ok";
  });

  step("append entry and checkpoint, verify log", () => {
    trustTransparency.appendTransparencyEntry(
      {
        timestamp: "2026-02-12T12:00:00.000Z",
        type: "bundle_loaded",
        reason: "rc-smoke-init"
      },
      { path: logPath }
    );
    const entries = trustTransparency.loadTransparencyLog(logPath);
    assert(entries.length === 1, "expected one transparency entry before checkpoint");
    const checkpoint = trustTransparency.createCheckpoint({
      logEntries: entries,
      chainHash: entries[entries.length - 1].chainHash,
      signer: "demo-operator",
      signingKeyPem: fs.readFileSync(checkpointPrivPath, "utf8"),
      createdAt: "2026-02-12T12:00:10.000Z"
    });
    appendJsonl(logPath, checkpoint);
    const verifyResult = trustTransparency.verifyTransparencyLogIncremental(logPath, {
      checkpointPublicKeyPem
    });
    assert(verifyResult.valid, `initial log verify failed: ${verifyResult.reason ?? "unknown"}`);
    return "size=1";
  });

  step("append newer head entry", () => {
    trustTransparency.appendTransparencyEntry(
      {
        timestamp: "2026-02-12T12:01:00.000Z",
        type: "revocation_applied",
        reason: "rc-smoke-head2"
      },
      { path: logPath }
    );
    const entries = trustTransparency.loadTransparencyLog(logPath);
    assert(entries.length === 2, "expected two transparency entries for head2");
    return "size=2";
  });

  step("trust report baseline", () => {
    const report = runTrustReport(["--pretty"]);
    assert(report?.version, "baseline trust report missing version");
    return `version=${report.version}`;
  });

  step("trust report with demo env-file", () => {
    fs.writeFileSync(statePath, "{}\n", "utf8");
    const envFile = [
      "INTENTOS_TRUST_DISTRIBUTION=fs",
      "INTENTOS_TRUST_SNAPSHOT_POLICY=warn",
      `INTENTOS_TRUST_SNAPSHOT_STATE_PATH=${statePath}`,
      `INTENTOS_TRUST_BUNDLE_PATH=${bundlePath}`,
      `INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH=${revocationsPath}`,
      `INTENTOS_TRANSPARENCY_LOG_PATH=${logPath}`,
      "INTENTOS_TRANSPARENCY_LOG_MODE=verify",
      "INTENTOS_TRANSPARENCY_CHECKPOINT_MODE=verify"
    ].join("\n");
    fs.writeFileSync(envFilePath, `${envFile}\n`, "utf8");
    const report = runTrustReport(["--env-file", envFilePath, "--pretty"]);
    assert(report?.modes?.trustDistribution === "fs", "env-file report trustDistribution mismatch");
    assert(
      report?.modes?.trustSnapshotPolicy === "warn",
      "env-file report trustSnapshotPolicy mismatch"
    );
    assert(
      report?.modes?.transparencyLogMode === "verify",
      "env-file report transparencyLogMode mismatch"
    );
    assert(
      report?.modes?.transparencyCheckpointMode === "verify",
      "env-file report transparencyCheckpointMode mismatch"
    );
    return "modes=ok";
  });

  step("warn apply writes state", () => {
    const events = [];
    const result = receiptPolicy.processReceiptEnvelope(
      { receipt: makeSignedReceipt(receipts.signReceipt, issuerPrivateKeyPem, "warn", "v1") },
      {
        mode: "enforce",
        trustVersion: "v1",
        env: {
          INTENTOS_TRUST_DISTRIBUTION: "fs",
          INTENTOS_TRUST_BUNDLE_PATH: bundlePath,
          INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH: revocationsPath,
          INTENTOS_TRUST_SNAPSHOT_POLICY: "warn",
          INTENTOS_TRUST_SNAPSHOT_STATE_PATH: statePath,
          INTENTOS_TRANSPARENCY_LOG_PATH: logPath,
          INTENTOS_TRANSPARENCY_LOG_MODE: "verify",
          INTENTOS_TRANSPARENCY_CHECKPOINT_MODE: "verify",
          INTENTOS_TRANSPARENCY_CHECKPOINT_PUBLIC_KEY: checkpointPublicKeyPem
        },
        logger: {
          warn(event) {
            events.push(event);
          }
        }
      }
    );
    assert(result.accepted, "warn apply did not accept");
    assert(fs.existsSync(statePath), "state.json was not written");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert(typeof state.appliedSnapshotId === "string" && state.appliedSnapshotId.length > 0, "state missing appliedSnapshotId");
    const appliedEvent = events.find((event) => event?.event === "intentos_trust_snapshot_applied");
    assert(appliedEvent, "missing intentos_trust_snapshot_applied event");
    return "state+event=ok";
  });

  step("v2 warn apply rejects (fail-closed)", () => {
    fs.rmSync(v2StatePath, { force: true });
    const events = [];
    const result = receiptPolicy.processReceiptEnvelope(
      { receipt: makeSignedReceipt(receipts.signReceipt, issuerPrivateKeyPem, "warn-v2", "v2") },
      {
        mode: "warn",
        trustVersion: "v2",
        env: {
          INTENTOS_TRUST_DISTRIBUTION: "fs",
          INTENTOS_TRUST_BUNDLE_PATH: bundlePath,
          INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH: revocationsPath,
          INTENTOS_TRUST_SNAPSHOT_POLICY: "warn",
          INTENTOS_TRUST_SNAPSHOT_STATE_PATH: v2StatePath,
          INTENTOS_TRANSPARENCY_LOG_PATH: logPath,
          INTENTOS_TRANSPARENCY_LOG_MODE: "verify",
          INTENTOS_TRANSPARENCY_CHECKPOINT_MODE: "verify",
          INTENTOS_TRANSPARENCY_CHECKPOINT_PUBLIC_KEY: checkpointPublicKeyPem
        },
        logger: {
          warn(event) {
            events.push(event);
          }
        }
      }
    );
    assert(!result.accepted, "v2 warn apply unexpectedly accepted");
    assert(
      typeof result.reason === "string" && result.reason.includes("TRUST_SIGNATURE_INVALID"),
      `v2 warn apply reason mismatch: ${result.reason ?? "unknown"}`
    );
    assert(!fs.existsSync(v2StatePath), "v2 warn apply unexpectedly wrote state");
    return "reject+no-state=ok";
  });

  step("rollback enforce rejects snapshot_behind", () => {
    const head2Path = path.join(demoDir, "log-head2.jsonl");
    const head1Path = path.join(demoDir, "log-head1.jsonl");
    fs.copyFileSync(logPath, head2Path);
    const head2Lines = fs
      .readFileSync(head2Path, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    assert(head2Lines.length >= 3, "expected head2 log to contain entry, checkpoint, and tail entry");
    fs.writeFileSync(head1Path, `${head2Lines.slice(0, -1).join("\n")}\n`, "utf8");
    fs.copyFileSync(head1Path, logPath);
    const verifyResult = trustTransparency.verifyTransparencyLogIncremental(logPath, {
      checkpointPublicKeyPem
    });
    assert(verifyResult.valid, `head1 verify failed: ${verifyResult.reason ?? "unknown"}`);

    const result = receiptPolicy.processReceiptEnvelope(
      { receipt: makeSignedReceipt(receipts.signReceipt, issuerPrivateKeyPem, "enforce") },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: {
          INTENTOS_TRUST_DISTRIBUTION: "fs",
          INTENTOS_TRUST_BUNDLE_PATH: bundlePath,
          INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH: revocationsPath,
          INTENTOS_TRUST_SNAPSHOT_POLICY: "enforce",
          INTENTOS_TRUST_SNAPSHOT_STATE_PATH: statePath,
          INTENTOS_TRANSPARENCY_LOG_PATH: logPath,
          INTENTOS_TRANSPARENCY_LOG_MODE: "verify",
          INTENTOS_TRANSPARENCY_CHECKPOINT_MODE: "verify",
          INTENTOS_TRANSPARENCY_CHECKPOINT_PUBLIC_KEY: checkpointPublicKeyPem
        },
        logger: {
          warn() {
            // Keep smoke output compact.
          }
        }
      }
    );
    assert(!result.accepted, "enforce rollback unexpectedly accepted");
    assert(
      typeof result.reason === "string" && result.reason.includes("snapshot_behind"),
      `enforce rollback reason missing snapshot_behind: ${result.reason ?? "unknown"}`
    );
    return "reject=snapshot_behind";
  });

  summarize(results, demoDir);
}

main();
