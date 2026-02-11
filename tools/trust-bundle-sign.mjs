#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createPrivateKey, sign } from "node:crypto";

const HELP = `IntentOS Trust Bundle Sign CLI

Usage:
  node tools/trust-bundle-sign.mjs --in bundle.json --out bundle.signed.json --signer signer://X --private-key-pem /path/key.pem

Notes:
  - The input bundle must be a JSON object.
  - bundleId and issuedAtSec must already be present in the input.
  - bundleVersion defaults to "v3" when omitted.
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

function canonicalizeTrustBundleForSigning(bundle) {
  return Buffer.from(
    stableStringifyJson({
      ...bundle,
      signature: undefined
    }),
    "utf8"
  );
}

async function readJson(filePath) {
  const absolute = path.resolve(filePath);
  const raw = await fs.readFile(absolute, "utf8");
  return JSON.parse(raw);
}

async function writeJson(filePath, value) {
  const absolute = path.resolve(filePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function validateBaseBundle(bundle) {
  if (!isPlainObject(bundle)) {
    throw new Error("bundle must be a JSON object");
  }
  const bundleVersion = normalizeNonEmptyString(bundle.bundleVersion);
  if (bundleVersion && bundleVersion !== "v3") {
    throw new Error(`bundleVersion must be v3, got: ${bundleVersion}`);
  }
  if (!normalizeNonEmptyString(bundle.bundleId)) {
    throw new Error("bundleId must be a non-empty string");
  }
  if (typeof bundle.issuedAtSec !== "number" || !Number.isFinite(bundle.issuedAtSec)) {
    throw new Error("issuedAtSec must be a finite number");
  }
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
  const outPath = normalizeNonEmptyString(options.out);
  const signer = normalizeNonEmptyString(options.signer);
  const keyPath = normalizeNonEmptyString(options["private-key-pem"]);
  if (!inPath || !outPath || !signer || !keyPath) {
    fail(`Missing required options.\n\n${HELP}`);
  }

  const [bundle, privateKeyPem] = await Promise.all([
    readJson(inPath),
    fs.readFile(path.resolve(keyPath), "utf8")
  ]);
  validateBaseBundle(bundle);

  const signableBundle = {
    ...bundle,
    bundleVersion: "v3",
    signer,
    sigAlg: "ed25519",
    signature: undefined
  };
  const signature = sign(
    null,
    canonicalizeTrustBundleForSigning(signableBundle),
    createPrivateKey(privateKeyPem)
  ).toString("base64");
  const signedBundle = {
    ...signableBundle,
    signature
  };
  await writeJson(outPath, signedBundle);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  fail(message);
});
