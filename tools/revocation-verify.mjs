#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createHash, createPublicKey, verify } from "node:crypto";

const REVOCATION_SET_TYPE = "revocations";
const REVOCATION_PROTOCOL_VERSION = "0.4";
const REVOCATION_PROOF_TYPE = "RevocationProof";
const REVOCATION_SIGNATURE_ALG = "ed25519";

const HELP = `IntentOS Revocation Proof Verify CLI

Usage:
  node tools/revocation-verify.mjs --set revocations.json --proof revocation-proof.json --trusted-keys-json '{"signer://relay-A":"-----BEGIN PUBLIC KEY-----..."}'
  node tools/revocation-verify.mjs --set revocations.json --proof revocation-proof.json --trusted-keys-json @trusted-keys.json

Notes:
  trusted-keys-json is a JSON object map of keyId -> publicKeyPem.
`;

function fail(code, detail = "") {
  const suffix = detail ? ` detail=${detail}` : "";
  console.error(`REVOCATION VERIFY FAIL code=${code}${suffix}`);
  process.exit(1);
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

function validateProof(proof) {
  if (!isPlainObject(proof)) {
    throw new Error("revocation_proof_invalid");
  }
  if (proof.type !== REVOCATION_PROOF_TYPE) {
    throw new Error("revocation_proof_invalid");
  }
  if (proof.version !== REVOCATION_PROTOCOL_VERSION) {
    throw new Error("revocation_proof_invalid");
  }
  if (normalizeNonEmptyString(proof.alg).toLowerCase() !== REVOCATION_SIGNATURE_ALG) {
    throw new Error("revocation_proof_invalid");
  }
  if (!Number.isInteger(proof.createdAt) || proof.createdAt < 0) {
    throw new Error("revocation_proof_invalid");
  }
  if (!normalizeNonEmptyString(proof.keyId) || !normalizeNonEmptyString(proof.signature)) {
    throw new Error("revocation_proof_missing");
  }
}

async function readJson(filePath) {
  const absolute = path.resolve(filePath);
  const raw = await fs.readFile(absolute, "utf8");
  return JSON.parse(raw);
}

async function parseTrustedKeys(raw) {
  const normalized = normalizeNonEmptyString(raw);
  if (!normalized) {
    throw new Error("trusted_keys_json_missing");
  }

  let payload;
  if (normalized.startsWith("@")) {
    payload = await fs.readFile(path.resolve(normalized.slice(1)), "utf8");
  } else {
    try {
      await fs.access(path.resolve(normalized));
      payload = await fs.readFile(path.resolve(normalized), "utf8");
    } catch {
      payload = normalized;
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("trusted_keys_json_invalid");
  }

  if (!isPlainObject(parsed)) {
    throw new Error("trusted_keys_json_invalid");
  }

  const trustedKeys = {};
  for (const [keyId, value] of Object.entries(parsed)) {
    const normalizedKeyId = normalizeNonEmptyString(keyId);
    const normalizedPem = normalizeNonEmptyString(value);
    if (!normalizedKeyId || !normalizedPem) {
      continue;
    }
    trustedKeys[normalizedKeyId] = normalizedPem;
  }
  return trustedKeys;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail("usage_error", `${message}; ${HELP.replace(/\n/g, " ")}`);
  }

  if (options.help) {
    console.log(HELP);
    return;
  }

  const setPath = normalizeNonEmptyString(options.set);
  const proofPath = normalizeNonEmptyString(options.proof);
  const trustedKeysInput = options["trusted-keys-json"];
  if (!setPath || !proofPath || !trustedKeysInput) {
    fail("usage_error", "set, proof and trusted-keys-json are required");
  }

  let setPayload;
  let proofPayload;
  let trustedKeys;
  try {
    [setPayload, proofPayload, trustedKeys] = await Promise.all([
      readJson(setPath),
      readJson(proofPath),
      parseTrustedKeys(trustedKeysInput)
    ]);
    validateRevocationSet(setPayload);
    validateProof(proofPayload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(message);
  }

  const keyId = normalizeNonEmptyString(proofPayload.keyId);
  const publicKeyPem = normalizeNonEmptyString(trustedKeys[keyId]);
  if (!publicKeyPem) {
    fail("revocation_proof_key_unknown");
  }

  const expectedSetId = computeRevocationSetId(setPayload);
  const claimedSetId = normalizeNonEmptyString(proofPayload.revocationSetId);
  if (claimedSetId && claimedSetId !== expectedSetId) {
    fail("revocation_proof_invalid", "revocationSetId mismatch");
  }

  try {
    const ok = verify(
      null,
      canonicalizeRevocationSetForSigning(setPayload),
      createPublicKey(publicKeyPem),
      Buffer.from(proofPayload.signature, "base64")
    );
    if (!ok) {
      fail("revocation_proof_invalid");
    }
  } catch {
    fail("revocation_proof_invalid");
  }

  console.log(`REVOCATION VERIFY OK code=revocation_proof_verified keyId=${keyId}`);
}

main();
