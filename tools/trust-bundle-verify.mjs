#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import Ajv from "ajv";

const HELP = `IntentOS Trust Bundle Verify CLI

Usage:
  node tools/trust-bundle-verify.mjs --in bundle.json [--trusted-keys-json <json-or-@file>]

Policy env:
  INTENTOS_PROTOCOL_VERSION=0.4
  INTENTOS_TRUST_BUNDLE=on
  INTENTOS_TRUST_BUNDLE_POLICY=off|warn|enforce (default off)
  INTENTOS_REVOCATION_PROOF=off|on (default off)
`;

function normalizeNonEmptyString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOnOff(value) {
  const normalized = normalizeNonEmptyString(value).toLowerCase();
  if (normalized === "on" || normalized === "off") {
    return normalized;
  }
  return "off";
}

function normalizePolicyMode(value) {
  const normalized = normalizeNonEmptyString(value).toLowerCase();
  if (normalized === "warn" || normalized === "enforce" || normalized === "off") {
    return normalized;
  }
  return "off";
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function loadSchema(name) {
  return readJson(path.resolve(process.cwd(), "spec", name));
}

function buildValidator() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const anchorSchema = loadSchema("identity-anchor-v0.4.schema.json");
  const anchorSetSchema = loadSchema("identity-anchor-set-v0.4.schema.json");
  const revocationSetSchema = loadSchema("revocation-set-v0.4.schema.json");
  const revocationProofSchema = loadSchema("revocation-proof-v0.4.schema.json");
  const trustBundleSchema = loadSchema("trust-bundle-v0.4.schema.json");

  ajv.addSchema(anchorSchema, anchorSchema.$id);
  ajv.addSchema(anchorSetSchema, anchorSetSchema.$id);
  ajv.addSchema(revocationSetSchema, revocationSetSchema.$id);
  ajv.addSchema(revocationProofSchema, revocationProofSchema.$id);
  return ajv.compile(trustBundleSchema);
}

function formatErrors(validate) {
  return (validate.errors || [])
    .map((error) => `${error.instancePath || "/"} ${error.message || "invalid"}`)
    .join("; ");
}

function printWarn(code) {
  console.warn(
    JSON.stringify({
      event: "intentos_trust_bundle_distribution",
      mode: "warn",
      code
    })
  );
}

function printSummary(summary) {
  console.log(JSON.stringify(summary));
}

function resolveTrustedKeysArg(options) {
  const provided = normalizeNonEmptyString(options["trusted-keys-json"]);
  if (provided) {
    return provided;
  }
  const fromEnv = normalizeNonEmptyString(process.env.INTENTOS_TRUSTED_REVOCATION_KEYS_JSON);
  if (fromEnv) {
    return fromEnv;
  }
  return "{}";
}

function verifyRevocationProofFromBundle(bundle, trustedKeysArg) {
  if (!bundle.revocations) {
    return { ok: true, code: null };
  }
  if (!bundle.revocations.proof) {
    return { ok: false, code: "revocation_proof_missing" };
  }

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "aimtp-trust-bundle-verify-"));
  try {
    const setPath = path.join(tempDir, "revocations.json");
    const proofPath = path.join(tempDir, "revocation-proof.json");
    fs.writeFileSync(setPath, `${JSON.stringify(bundle.revocations.set, null, 2)}\n`, "utf8");
    fs.writeFileSync(proofPath, `${JSON.stringify(bundle.revocations.proof, null, 2)}\n`, "utf8");

    const verifyToolPath = path.resolve(process.cwd(), "tools", "revocation-verify.mjs");
    const result = spawnSync(
      process.execPath,
      [
        verifyToolPath,
        "--set",
        setPath,
        "--proof",
        proofPath,
        "--trusted-keys-json",
        trustedKeysArg
      ],
      { encoding: "utf8" }
    );

    if (result.status === 0) {
      return { ok: true, code: null };
    }

    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (output.includes("revocation_proof_key_unknown")) {
      return { ok: false, code: "revocation_proof_key_unknown" };
    }
    if (output.includes("revocation_proof_missing")) {
      return { ok: false, code: "revocation_proof_missing" };
    }
    return { ok: false, code: "revocation_proof_invalid" };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${message}\n\n${HELP}`);
    process.exit(1);
    return;
  }

  if (options.help) {
    console.log(HELP);
    return;
  }

  const inputPath = normalizeNonEmptyString(options.in);
  if (!inputPath) {
    console.error(`Missing required options.\n\n${HELP}`);
    process.exit(1);
    return;
  }

  const bundleMode = normalizeOnOff(process.env.INTENTOS_TRUST_BUNDLE);
  const policyMode = normalizePolicyMode(process.env.INTENTOS_TRUST_BUNDLE_POLICY);
  const protocolVersion = normalizeNonEmptyString(process.env.INTENTOS_PROTOCOL_VERSION);
  const revocationProofMode = normalizeOnOff(process.env.INTENTOS_REVOCATION_PROOF);

  if (!(protocolVersion === "0.4" && bundleMode === "on")) {
    printSummary({
      skipped: true,
      accepted: true,
      policyMode,
      errors: [],
      warnings: []
    });
    return;
  }

  if (policyMode === "off") {
    printSummary({
      skipped: false,
      accepted: true,
      policyMode,
      errors: [],
      warnings: []
    });
    return;
  }

  let bundle;
  try {
    bundle = readJson(inputPath);
  } catch {
    const code = "trust_bundle_invalid";
    if (policyMode === "warn") {
      printWarn(code);
      printSummary({ skipped: false, accepted: false, policyMode, errors: [], warnings: [code] });
      return;
    }
    printSummary({ skipped: false, accepted: false, policyMode, errors: [code], warnings: [] });
    process.exit(1);
    return;
  }

  const validate = buildValidator();
  if (!validate(bundle)) {
    const code = "trust_bundle_invalid";
    const detail = formatErrors(validate);
    if (policyMode === "warn") {
      printWarn(code);
      printSummary({ skipped: false, accepted: false, policyMode, errors: [], warnings: [`${code}:${detail}`] });
      return;
    }
    printSummary({ skipped: false, accepted: false, policyMode, errors: [`${code}:${detail}`], warnings: [] });
    process.exit(1);
    return;
  }

  if (revocationProofMode === "on") {
    const verifyResult = verifyRevocationProofFromBundle(bundle, resolveTrustedKeysArg(options));
    if (!verifyResult.ok) {
      if (policyMode === "warn") {
        printWarn(verifyResult.code);
        printSummary({
          skipped: false,
          accepted: false,
          policyMode,
          errors: [],
          warnings: [verifyResult.code]
        });
        return;
      }
      printSummary({
        skipped: false,
        accepted: false,
        policyMode,
        errors: [verifyResult.code],
        warnings: []
      });
      process.exit(1);
      return;
    }
  }

  printSummary({
    skipped: false,
    accepted: true,
    policyMode,
    errors: [],
    warnings: []
  });
}

main();
