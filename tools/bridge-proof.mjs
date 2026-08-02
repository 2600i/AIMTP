#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const HELP = `IntentOS Bridge Proof CLI

Usage:
  node tools/bridge-proof.mjs mint --issuer <id> --subject <id> --subject-key <pem-or-path> --ttl <sec> --out <path> [--issuer-key <path>]
  node tools/bridge-proof.mjs verify --proof <path> --trusted-keys <json|@path|path>

Notes:
  - mint signing key is read from --issuer-key, or env INTENTOS_BRIDGE_ISSUER_PRIVATE_KEY_PATH,
    or env INTENTOS_BRIDGE_ISSUER_PRIVATE_KEY.
`;

function normalizeNonEmptyString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(code, message) {
  process.stdout.write(`ERROR ${code} ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const [subcommand, ...rest] = argv;
  const options = { subcommand: normalizeNonEmptyString(subcommand) };

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--help") {
      options.help = true;
      continue;
    }
    if (!token.startsWith("--")) {
      throw new Error(`unknown argument: ${token}`);
    }
    const key = token.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }
    options[key] = value;
    index += 1;
  }

  return options;
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

function parsePositiveInt(value, label) {
  const normalized = normalizeNonEmptyString(value);
  const numeric = Number(normalized);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new Error(`TRUST_BUNDLE_INVALID:${label}_invalid`);
  }
  return numeric;
}

function readMaybeFile(value) {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) {
    return "";
  }
  const absolute = path.resolve(normalized);
  if (fs.existsSync(absolute)) {
    return fs.readFileSync(absolute, "utf8");
  }
  return normalized;
}

function readPrivateKey(options) {
  const fromArg = normalizeNonEmptyString(options["issuer-key"]);
  if (fromArg) {
    return fs.readFileSync(path.resolve(fromArg), "utf8");
  }
  const fromPath = normalizeNonEmptyString(process.env.INTENTOS_BRIDGE_ISSUER_PRIVATE_KEY_PATH);
  if (fromPath) {
    return fs.readFileSync(path.resolve(fromPath), "utf8");
  }
  const inline = normalizeNonEmptyString(process.env.INTENTOS_BRIDGE_ISSUER_PRIVATE_KEY);
  if (inline) {
    return inline;
  }
  throw new Error("TRUST_BUNDLE_INVALID:issuer_private_key_missing");
}

function writeJson(filePath, value) {
  const absolute = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return absolute;
}

function parseTrustedKeys(raw) {
  const normalized = normalizeNonEmptyString(raw);
  if (!normalized) {
    throw new Error("TRUST_BUNDLE_INVALID:trusted_keys_missing");
  }

  let payload;
  if (normalized.startsWith("@")) {
    payload = fs.readFileSync(path.resolve(normalized.slice(1)), "utf8");
  } else {
    const absolute = path.resolve(normalized);
    payload = fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : normalized;
  }

  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("TRUST_BUNDLE_INVALID:trusted_keys_invalid_json");
  }
  if (!isPlainObject(parsed)) {
    throw new Error("TRUST_BUNDLE_INVALID:trusted_keys_invalid_shape");
  }

  const trusted = {};
  for (const [issuer, value] of Object.entries(parsed)) {
    const normalizedIssuer = normalizeNonEmptyString(issuer);
    const normalizedKey = normalizeNonEmptyString(value);
    if (!normalizedIssuer || !normalizedKey) {
      continue;
    }
    trusted[normalizedIssuer] = normalizedKey;
  }
  return trusted;
}

function resolveErrorCode(message, fallback = "TRUST_BUNDLE_INVALID") {
  const normalized = normalizeNonEmptyString(message);
  const trustCode = normalized.match(/\b(TRUST_[A-Z_]+)\b/);
  if (trustCode) {
    return trustCode[1];
  }
  if (normalized.toLowerCase().includes("signature")) {
    return "TRUST_SIGNATURE_INVALID";
  }
  return fallback;
}

function runMint(options, runtimeApi) {
  const issuer = normalizeNonEmptyString(options.issuer);
  const subject = normalizeNonEmptyString(options.subject);
  const outPath = normalizeNonEmptyString(options.out);
  const subjectPublicKeyPem = readMaybeFile(options["subject-key"]);
  const ttlSec = parsePositiveInt(options.ttl, "ttl");
  if (!issuer || !subject || !outPath || !subjectPublicKeyPem.trim()) {
    throw new Error("TRUST_BUNDLE_INVALID:mint_required_args_missing");
  }

  const issuerPrivateKeyPem = readPrivateKey(options);
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + ttlSec;
  const proof = runtimeApi.createBridgeProof(
    {
      issuer,
      subject,
      subjectPublicKeyPem,
      issuedAt,
      expiresAt
    },
    issuerPrivateKeyPem
  );

  const written = writeJson(outPath, proof);
  process.stdout.write(`OK BRIDGE_PROOF_MINTED out=${written}\n`);
}

function runVerify(options, runtimeApi) {
  const proofPath = normalizeNonEmptyString(options.proof);
  const trustedKeysInput = normalizeNonEmptyString(options["trusted-keys"]);
  if (!proofPath || !trustedKeysInput) {
    throw new Error("TRUST_BUNDLE_INVALID:verify_required_args_missing");
  }

  const proof = JSON.parse(fs.readFileSync(path.resolve(proofPath), "utf8"));
  const trustedKeys = parseTrustedKeys(trustedKeysInput);
  const result = runtimeApi.verifyBridgeProof(proof, trustedKeys, Date.now() / 1000);
  if (!result.valid) {
    const code = normalizeNonEmptyString(result.code) || resolveErrorCode(result.reason);
    throw new Error(`${code}:${result.reason}`);
  }

  process.stdout.write(
    `OK BRIDGE_PROOF_VALID issuer=${result.issuer ?? "unknown"} subject=${result.subject ?? "unknown"}\n`
  );
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail("TRUST_BUNDLE_INVALID", `${message}; ${HELP.replace(/\n/g, " ")}`);
  }

  if (options.help || !options.subcommand) {
    process.stdout.write(HELP);
    return;
  }

  let runtimeApi;
  try {
    runtimeApi = resolveRuntimeApi();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(resolveErrorCode(message), message);
  }

  try {
    if (typeof runtimeApi.createBridgeProof !== "function" || typeof runtimeApi.verifyBridgeProof !== "function") {
      throw new Error("TRUST_BUNDLE_INVALID:bridge_proof_api_unavailable");
    }

    if (options.subcommand === "mint") {
      runMint(options, runtimeApi);
      return;
    }
    if (options.subcommand === "verify") {
      runVerify(options, runtimeApi);
      return;
    }
    throw new Error(`TRUST_BUNDLE_INVALID:unknown_subcommand:${options.subcommand}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(resolveErrorCode(message), message);
  }
}

main();
