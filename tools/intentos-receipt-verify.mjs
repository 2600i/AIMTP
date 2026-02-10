#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const HELP = `IntentOS Receipt Verify CLI

Usage:
  node tools/intentos-receipt-verify.mjs --receipt <path>
  node tools/intentos-receipt-verify.mjs --jsonl <path> --envelopeId <id>

Environment:
  INTENTOS_TRUSTED_RECEIPT_KEYS_JSON='{"issuer":"-----BEGIN PUBLIC KEY-----..."}'

Options:
  --receipt <path>      Receipt JSON file
  --jsonl <path>        Receipt JSONL file
  --envelopeId <id>     Envelope id lookup for JSONL mode
  --help                Show this help
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
    index += 1;
    options[key] = value;
  }
  return options;
}

function dirnameFromImportMeta() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function loadReceiptsModule() {
  const distPath = path.resolve(dirnameFromImportMeta(), "../dist/protocol/intentos-receipts.js");
  try {
    return require(distPath);
  } catch {
    throw new Error("Missing dist/protocol/intentos-receipts.js. Run: npm run build");
  }
}

async function readJson(filePath) {
  const absolute = path.resolve(filePath);
  const raw = await fs.readFile(absolute, "utf8");
  return JSON.parse(raw);
}

async function readJsonl(filePath) {
  const absolute = path.resolve(filePath);
  const raw = await fs.readFile(absolute, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, lineIndex) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid JSONL at line ${lineIndex + 1}: ${message}`);
      }
    });
}

async function resolveReceipt(options) {
  if (options.receipt) {
    if (options.jsonl || options.envelopeId) {
      throw new Error("Use either --receipt or --jsonl/--envelopeId mode");
    }
    return readJson(options.receipt);
  }

  if (options.jsonl) {
    if (!options.envelopeId) {
      throw new Error("--envelopeId is required with --jsonl");
    }
    const entries = await readJsonl(options.jsonl);
    const receipt = entries.find(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        entry.envelopeId === options.envelopeId
    );
    if (!receipt) {
      throw new Error(`No receipt found for envelopeId=${options.envelopeId}`);
    }
    return receipt;
  }

  throw new Error("Missing mode. Use --receipt or --jsonl/--envelopeId");
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

  const { parseTrustedReceiptKeysJson, verifyReceipt } = loadReceiptsModule();
  const trustedKeys = parseTrustedReceiptKeysJson(process.env.INTENTOS_TRUSTED_RECEIPT_KEYS_JSON);
  const receipt = await resolveReceipt(options);
  const result = verifyReceipt(receipt, trustedKeys);
  if (result.verified) {
    console.log(`VERIFIED: ${result.reason}`);
    return;
  }
  console.log(`UNVERIFIED: ${result.reason}`);
  process.exit(1);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  fail(message);
});
