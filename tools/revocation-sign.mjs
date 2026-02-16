#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createHash, createPrivateKey, sign } from "node:crypto";

const REVOCATION_SET_TYPE = "revocations";
const REVOCATION_PROTOCOL_VERSION = "0.4";
const REVOCATION_PROOF_TYPE = "RevocationProof";
const REVOCATION_SIGNATURE_ALG = "ed25519";

const HELP = `IntentOS Revocation Proof Sign CLI

Usage:
  node tools/revocation-sign.mjs --in revocations.json --key private.pem --key-id signer://relay-A --out revocation-proof.json

Options:
  --in <path>        Revocation set JSON (v0.4)
  --key <path>       Ed25519 private key PEM
  --key-id <id>      Stable key identifier for verification lookup
  --out <path>       Output proof JSON path
  --created-at <sec> Optional unix-seconds override (defaults to now)
`;

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function normalizeNonEmptyString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${stableStringifyJson(value[key])}`);
    return `{${parts.join(",")}}`;
  }
  throw new Error(`unsupported_value_type:${typeof value}`);
}

function canonicalizeRevocationSetForSigning(set) {
  return Buffer.from(
    stableStringifyJson({
      type: set.type,
      specVersion: set.specVersion,
      issuer: set.issuer,
      issuedAt: set.issuedAt,
      revocations: set.revocations
    }),
    "utf8"
  );
}

function computeRevocationSetId(set) {
  return `sha256:${createHash("sha256").update(canonicalizeRevocationSetForSigning(set)).digest("hex")}`;
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

function validateRevocationSet(set) {
  if (!isPlainObject(set)) {
    throw new Error("revocation_set_invalid");
  }
  if (set.type !== REVOCATION_SET_TYPE) {
    throw new Error("revocation_set_type_invalid");
  }
  if (set.specVersion !== REVOCATION_PROTOCOL_VERSION) {
    throw new Error("revocation_set_version_invalid");
  }
  if (!normalizeNonEmptyString(set.issuer)) {
    throw new Error("revocation_set_issuer_missing");
  }
  if (!Number.isInteger(set.issuedAt) || set.issuedAt < 0) {
    throw new Error("revocation_set_issued_at_invalid");
  }
  if (!Array.isArray(set.revocations)) {
    throw new Error("revocation_set_revocations_invalid");
  }
}

async function readJson(filePath) {
  const absolute = path.resolve(filePath);
  const raw = await fs.readFile(absolute, "utf8");
  return JSON.parse(raw);
}

async function writeJson(filePath, payload) {
  const absolute = path.resolve(filePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function parseCreatedAt(value) {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) {
    return Math.floor(Date.now() / 1000);
  }
  const numeric = Number(normalized);
  if (!Number.isInteger(numeric) || numeric < 0) {
    throw new Error("created_at_invalid");
  }
  return numeric;
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

  const inPath = normalizeNonEmptyString(options.in);
  const keyPath = normalizeNonEmptyString(options.key);
  const keyId = normalizeNonEmptyString(options["key-id"]);
  const outPath = normalizeNonEmptyString(options.out);
  if (!inPath || !keyPath || !keyId || !outPath) {
    fail(`Missing required options.\n\n${HELP}`);
  }

  try {
    const [setPayload, privateKeyPem] = await Promise.all([
      readJson(inPath),
      fs.readFile(path.resolve(keyPath), "utf8")
    ]);
    validateRevocationSet(setPayload);

    const canonicalPayload = canonicalizeRevocationSetForSigning(setPayload);
    const signature = sign(null, canonicalPayload, createPrivateKey(privateKeyPem)).toString("base64");
    const proof = {
      type: REVOCATION_PROOF_TYPE,
      version: REVOCATION_PROTOCOL_VERSION,
      keyId,
      alg: REVOCATION_SIGNATURE_ALG,
      createdAt: parseCreatedAt(options["created-at"]),
      signature,
      revocationSetId: computeRevocationSetId(setPayload)
    };

    await writeJson(outPath, proof);
    console.log(`REVOCATION SIGN OK keyId=${keyId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`REVOCATION SIGN FAIL code=${message}`);
  }
}

main();
