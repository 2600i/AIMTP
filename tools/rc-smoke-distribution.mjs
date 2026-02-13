#!/usr/bin/env node

import http from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ISSUER = "relay://dist-smoke";

function dirnameFromImportMeta() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function repoRoot() {
  return path.resolve(dirnameFromImportMeta(), "..");
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

function parseArgs(argv) {
  const options = {
    dir: `/tmp/aimtp-rc-smoke-dist-${process.pid}`
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

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function makeSignedReceipt(signReceipt, privateKeyPem, suffix) {
  return signReceipt(
    {
      receiptId: `dist-smoke-receipt-${suffix}`,
      envelopeId: `dist-smoke-envelope-${suffix}`,
      intentId: `dist-smoke-intent-${suffix}`,
      type: "receipt.completed",
      timestamp: "2026-02-13T12:00:00.000Z",
      metadata: { outputHash: `dist-smoke-output-${suffix}` }
    },
    privateKeyPem,
    ISSUER,
    { trustVersion: "v2" }
  );
}

function summarize(results, demoDir) {
  console.log("\nDistribution smoke summary");
  for (const result of results) {
    const prefix = result.ok ? "PASS" : "FAIL";
    const detail = result.detail ? `: ${result.detail}` : "";
    console.log(`${prefix} ${result.step}${detail}`);
  }
  console.log(`demoDir: ${demoDir}`);
}

function startLocalServer(routes) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const route = routes.get(url.pathname);
      if (!route) {
        res.statusCode = 404;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("not found");
        return;
      }
      res.statusCode = route.status ?? 200;
      res.setHeader("content-type", route.contentType);
      res.end(route.body);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function runReceiptPolicySubprocess({ receipt, mode, trustVersion, env }) {
  const script = `
const path = require("node:path");
const payload = JSON.parse(process.env.AIMTP_DIST_SMOKE_PAYLOAD || "{}");
const receiptPolicy = require(path.resolve(process.cwd(), "dist/runtime/intentos/receipt-policy.js"));
const events = [];
const result = receiptPolicy.processReceiptEnvelope(
  { receipt: payload.receipt },
  {
    mode: payload.mode,
    trustVersion: payload.trustVersion,
    env: payload.env,
    logger: {
      warn(event) {
        events.push(event);
      }
    }
  }
);
process.stdout.write(JSON.stringify({ result, events }));
`;
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ receipt, mode, trustVersion, env });
    const child = spawn(process.execPath, ["-e", script], {
      cwd: repoRoot(),
      env: {
        ...process.env,
        AIMTP_DIST_SMOKE_PAYLOAD: payload
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        const detail = (stderr || stdout || `exit=${code}`).trim();
        reject(new Error(`receipt policy subprocess failed: ${detail}`));
        return;
      }
      const text = stdout.trim();
      if (!text) {
        reject(new Error("receipt policy subprocess produced no output"));
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reject(new Error(`invalid subprocess output: ${message}`));
      }
    });
  });
}

async function main() {
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

  const stepAsync = async (name, fn) => {
    try {
      const detail = await fn();
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
  const fsLogPath = path.join(demoDir, "fs-log.jsonl");
  const fsStatePath = path.join(demoDir, "fs-state.json");
  const httpStatePath = path.join(demoDir, "http-state.json");
  const httpLogPath = path.join(demoDir, "http-log.jsonl");
  const checkpointPrivPath = path.join(demoDir, "checkpoint-priv.pem");
  const checkpointPubPath = path.join(demoDir, "checkpoint-pub.pem");
  const issuerPrivPath = path.join(demoDir, "issuer-priv.pem");
  const issuerPubPath = path.join(demoDir, "issuer-pub.pem");

  let checkpointPublicKeyPem = "";
  let checkpoint = null;
  let logEntries = [];
  let issuerPrivateKeyPem = "";
  let server = null;
  let baseUrl = "";

  step("setup demo dir", () => {
    fs.rmSync(demoDir, { recursive: true, force: true });
    fs.mkdirSync(demoDir, { recursive: true });
    return demoDir;
  });

  step("generate keys", () => {
    const checkpointKeys = generateKeyPairSync("ed25519");
    const issuerKeys = generateKeyPairSync("ed25519");
    fs.writeFileSync(
      checkpointPrivPath,
      checkpointKeys.privateKey.export({ type: "pkcs8", format: "pem" })
    );
    fs.writeFileSync(
      checkpointPubPath,
      checkpointKeys.publicKey.export({ type: "spki", format: "pem" })
    );
    fs.writeFileSync(
      issuerPrivPath,
      issuerKeys.privateKey.export({ type: "pkcs8", format: "pem" })
    );
    fs.writeFileSync(
      issuerPubPath,
      issuerKeys.publicKey.export({ type: "spki", format: "pem" })
    );
    checkpointPublicKeyPem = fs.readFileSync(checkpointPubPath, "utf8");
    issuerPrivateKeyPem = fs.readFileSync(issuerPrivPath, "utf8");
    return "ok";
  });

  step("write trust bundle + revocations", () => {
    const issuerPublicKeyPem = fs.readFileSync(issuerPubPath, "utf8");
    writeJson(bundlePath, {
      bundleVersion: "v3",
      bundleId: "aimtp-dist-smoke-v3",
      issuedAtSec: 1767225600,
      issuers: {
        [ISSUER]: {
          keys: [{ kid: "relay-dist", alg: "ed25519", publicKeyPem: issuerPublicKeyPem }]
        }
      }
    });
    writeJson(revocationsPath, {
      signers: [],
      issuerKeys: {}
    });
    return "ok";
  });

  step("prepare transparency log + checkpoint", () => {
    trustTransparency.appendTransparencyEntry(
      {
        timestamp: "2026-02-13T12:00:00.000Z",
        type: "bundle_loaded",
        reason: "dist-smoke-entry-1"
      },
      { path: fsLogPath }
    );
    trustTransparency.appendTransparencyEntry(
      {
        timestamp: "2026-02-13T12:00:01.000Z",
        type: "revocation_applied",
        reason: "dist-smoke-entry-2"
      },
      { path: fsLogPath }
    );
    logEntries = trustTransparency.loadTransparencyLog(fsLogPath);
    assert(logEntries.length === 2, "expected two transparency entries");
    checkpoint = trustTransparency.createCheckpoint({
      logEntries: [logEntries[0]],
      chainHash: logEntries[0].chainHash,
      signer: "signer://dist-smoke",
      signingKeyPem: fs.readFileSync(checkpointPrivPath, "utf8"),
      createdAt: "2026-02-13T12:00:10.000Z"
    });
    const ordered = `${JSON.stringify(logEntries[0])}\n${JSON.stringify(checkpoint)}\n${JSON.stringify(logEntries[1])}\n`;
    fs.writeFileSync(fsLogPath, ordered, "utf8");
    const verify = trustTransparency.verifyTransparencyLogIncremental(fsLogPath, {
      checkpointPublicKeyPem
    });
    assert(verify.valid, `incremental transparency verify failed: ${verify.reason ?? "unknown"}`);
    return "ok";
  });

  step("fs adapter applies snapshot + verifies", () => {
    const events = [];
    const result = receiptPolicy.processReceiptEnvelope(
      { receipt: makeSignedReceipt(receipts.signReceipt, issuerPrivateKeyPem, "fs") },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: {
          INTENTOS_TRUST_DISTRIBUTION: "fs",
          INTENTOS_TRUST_BUNDLE_PATH: bundlePath,
          INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH: revocationsPath,
          INTENTOS_TRUST_SNAPSHOT_POLICY: "warn",
          INTENTOS_TRUST_SNAPSHOT_STATE_PATH: fsStatePath,
          INTENTOS_TRANSPARENCY_LOG_PATH: fsLogPath,
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
    assert(result.accepted && result.trusted, `fs distribution failed: ${result.reason ?? "unknown"}`);
    assert(events.some((event) => event?.event === "intentos_trust_snapshot_applied"), "missing fs snapshot applied event");
    console.log("FS distribution OK");
    return "accepted";
  });

  await stepAsync("start local http server", async () => {
    const headPayload = {
      size: 2,
      chainHash: logEntries[1].chainHash
    };
    const routes = new Map([
      [
        "/bundle.json",
        {
          contentType: "application/json; charset=utf-8",
          body: fs.readFileSync(bundlePath, "utf8")
        }
      ],
      [
        "/bundle-invalid.json",
        {
          contentType: "application/json; charset=utf-8",
          body: "{not-json"
        }
      ],
      [
        "/revocations.json",
        {
          contentType: "application/json; charset=utf-8",
          body: fs.readFileSync(revocationsPath, "utf8")
        }
      ],
      [
        "/head.json",
        {
          contentType: "application/json; charset=utf-8",
          body: `${JSON.stringify(headPayload)}\n`
        }
      ],
      [
        "/checkpoint.json",
        {
          contentType: "application/json; charset=utf-8",
          body: `${JSON.stringify(checkpoint)}\n`
        }
      ],
      [
        "/logtail.jsonl",
        {
          contentType: "application/x-ndjson; charset=utf-8",
          body: `${JSON.stringify(logEntries[1])}\n`
        }
      ]
    ]);
    server = await startLocalServer(routes);
    const address = server.address();
    if (!address || typeof address !== "object" || !address.port) {
      throw new Error("failed to bind local http server");
    }
    fs.writeFileSync(httpLogPath, "", "utf8");
    baseUrl = `http://127.0.0.1:${address.port}`;
    return baseUrl;
  });

  await stepAsync("http adapter applies snapshot + verifies proof", async () => {
    const { result, events } = await runReceiptPolicySubprocess({
      receipt: makeSignedReceipt(receipts.signReceipt, issuerPrivateKeyPem, "http"),
      mode: "enforce",
      trustVersion: "v2",
      env: {
        INTENTOS_TRUST_DISTRIBUTION: "http",
        INTENTOS_TRUST_HTTP_BUNDLE_URL: `${baseUrl}/bundle.json`,
        INTENTOS_TRUST_HTTP_REVOCATIONS_URL: `${baseUrl}/revocations.json`,
        INTENTOS_TRUST_HTTP_HEAD_URL: `${baseUrl}/head.json`,
        INTENTOS_TRUST_HTTP_CHECKPOINT_URL: `${baseUrl}/checkpoint.json`,
        INTENTOS_TRUST_HTTP_LOGTAIL_URL: `${baseUrl}/logtail.jsonl`,
        INTENTOS_TRUST_SNAPSHOT_POLICY: "warn",
        INTENTOS_TRUST_SNAPSHOT_STATE_PATH: httpStatePath,
        INTENTOS_TRANSPARENCY_LOG_PATH: httpLogPath,
        INTENTOS_TRANSPARENCY_LOG_MODE: "verify",
        INTENTOS_TRANSPARENCY_CHECKPOINT_MODE: "verify",
        INTENTOS_TRANSPARENCY_CHECKPOINT_PUBLIC_KEY: checkpointPublicKeyPem
      }
    });
    assert(result.accepted && result.trusted, `http distribution failed: ${result.reason ?? "unknown"}`);
    assert(events.some((event) => event?.event === "intentos_trust_snapshot_applied"), "missing http snapshot applied event");
    console.log("HTTP distribution OK");
    return "accepted";
  });

  await stepAsync("negative invalid JSON rejects in enforce mode", async () => {
    const { result } = await runReceiptPolicySubprocess({
      receipt: makeSignedReceipt(receipts.signReceipt, issuerPrivateKeyPem, "http-negative"),
      mode: "enforce",
      trustVersion: "v2",
      env: {
        INTENTOS_TRUST_DISTRIBUTION: "http",
        INTENTOS_TRUST_HTTP_BUNDLE_URL: `${baseUrl}/bundle-invalid.json`
      }
    });
    assert(!result.accepted, "invalid json should reject in enforce mode");
    assert(
      typeof result.reason === "string" &&
      result.reason.includes("trust_distribution_invalid_json:INTENTOS_TRUST_HTTP_BUNDLE_URL"),
      `unexpected negative reason: ${result.reason ?? "unknown"}`
    );
    return "reject=invalid_json";
  });

  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  summarize(results, demoDir);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`FAIL unexpected: ${message}`);
  process.exit(1);
});
