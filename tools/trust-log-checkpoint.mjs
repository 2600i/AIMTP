#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HELP = `IntentOS Trust Log Checkpoint CLI

Usage:
  node tools/trust-log-checkpoint.mjs --log path/to/log.jsonl --signer signer://ops --key /path/private.pem

Options:
  --log <path>         Transparency log JSONL path
  --signer <id>        Checkpoint signer identifier
  --key <path>         Ed25519 private key PEM file (optional if env key is set)
  --help               Show this help

Environment:
  INTENTOS_TRANSPARENCY_LOG_MODE=append
  INTENTOS_TRANSPARENCY_CHECKPOINT_MODE=append
  INTENTOS_TRANSPARENCY_CHECKPOINT_SIGNING_KEY=<PEM>  (used when --key is omitted)
`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unknown argument: ${token}`);
    }
    const key = token.slice(2);
    if (key === "help") {
      options.help = true;
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

function dirnameFromImportMeta() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function loadTrustTransparencyModule() {
  const require = createRequire(import.meta.url);
  const distPath = path.resolve(dirnameFromImportMeta(), "../dist/runtime/intentos/trust-transparency.js");
  try {
    return require(distPath);
  } catch {
    throw new Error("Missing dist/runtime/intentos/trust-transparency.js. Run: npm run build");
  }
}

function readEnvMode(name) {
  return (process.env[name] ?? "").trim().toLowerCase();
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`${message}\n\n${HELP}`);
  }

  if (options.help) {
    console.log(HELP);
    return;
  }

  if (!options.log) {
    fail(`Missing --log\n\n${HELP}`);
  }
  if (!options.signer) {
    fail(`Missing --signer\n\n${HELP}`);
  }

  if (readEnvMode("INTENTOS_TRANSPARENCY_LOG_MODE") !== "append") {
    fail("Checkpoint append requires INTENTOS_TRANSPARENCY_LOG_MODE=append");
  }
  if (readEnvMode("INTENTOS_TRANSPARENCY_CHECKPOINT_MODE") !== "append") {
    fail("Checkpoint append requires INTENTOS_TRANSPARENCY_CHECKPOINT_MODE=append");
  }

  const keyFromEnv = (process.env.INTENTOS_TRANSPARENCY_CHECKPOINT_SIGNING_KEY ?? "").trim();
  const signingKeyPem = options.key
    ? await fs.readFile(path.resolve(options.key), "utf8")
    : keyFromEnv;
  if (!signingKeyPem) {
    fail("Missing signing key. Provide --key or INTENTOS_TRANSPARENCY_CHECKPOINT_SIGNING_KEY.");
  }

  const { createCheckpoint, loadTransparencyLog } = loadTrustTransparencyModule();
  const logPath = path.resolve(options.log);
  const logEntries = loadTransparencyLog(logPath);
  if (logEntries.length === 0) {
    fail("Cannot create checkpoint for an empty transparency log.");
  }

  const chainHash = logEntries[logEntries.length - 1].chainHash;
  const checkpoint = createCheckpoint({
    logEntries,
    chainHash,
    signer: options.signer,
    signingKeyPem
  });

  await fs.appendFile(logPath, `${JSON.stringify(checkpoint)}\n`, "utf8");
  console.log(`Checkpoint appended: size=${checkpoint.size} signer=${checkpoint.signer}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  fail(message);
});
