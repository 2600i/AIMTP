#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import Ajv from "ajv";

const HELP = `IntentOS Trust Bundle Pack CLI

Usage:
  node tools/trust-bundle-pack.mjs --out bundle.json --issuer relay://issuer [options]

Options:
  --identity-anchors-set <path>
  --identity-anchors-proof <path>
  --revocations-set <path>
  --revocations-proof <path>
  --transparency-head <path>
  --transparency-checkpoint <path>
  --created-at <unix-seconds>
`;

function normalizeNonEmptyString(value) {
  return typeof value === "string" ? value.trim() : "";
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
  const absolute = path.resolve(filePath);
  return JSON.parse(fs.readFileSync(absolute, "utf8"));
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

function readOptionalJson(optionValue) {
  const normalized = normalizeNonEmptyString(optionValue);
  if (!normalized) {
    return undefined;
  }
  return readJson(normalized);
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function formatErrors(validate) {
  return (validate.errors || [])
    .map((error) => `${error.instancePath || "/"} ${error.message || "invalid"}`)
    .join("; ");
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

function main() {
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

  const outPath = normalizeNonEmptyString(options.out);
  const issuer = normalizeNonEmptyString(options.issuer);
  if (!outPath || !issuer) {
    fail(`Missing required options.\n\n${HELP}`);
  }

  let createdAt;
  try {
    createdAt = parseCreatedAt(options["created-at"]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`TRUST BUNDLE PACK FAIL code=${message}`);
  }

  const bundle = {
    type: "trust_bundle",
    version: "0.4",
    createdAt,
    issuer
  };

  const anchorsSet = readOptionalJson(options["identity-anchors-set"]);
  const anchorsProof = readOptionalJson(options["identity-anchors-proof"]);
  if (anchorsSet !== undefined) {
    bundle.identityAnchors = {
      set: anchorsSet,
      ...(anchorsProof !== undefined ? { proof: anchorsProof } : {})
    };
  }

  const revocationSet = readOptionalJson(options["revocations-set"]);
  const revocationProof = readOptionalJson(options["revocations-proof"]);
  if (revocationSet !== undefined) {
    bundle.revocations = {
      set: revocationSet,
      ...(revocationProof !== undefined ? { proof: revocationProof } : {})
    };
  }

  const transparencyHead = readOptionalJson(options["transparency-head"]);
  const transparencyCheckpoint = readOptionalJson(options["transparency-checkpoint"]);
  if (transparencyHead !== undefined || transparencyCheckpoint !== undefined) {
    bundle.transparency = {
      ...(transparencyHead !== undefined ? { head: transparencyHead } : {}),
      ...(transparencyCheckpoint !== undefined ? { latestCheckpoint: transparencyCheckpoint } : {})
    };
  }

  const validate = buildValidator();
  if (!validate(bundle)) {
    fail(`TRUST BUNDLE PACK FAIL code=trust_bundle_invalid detail=${formatErrors(validate)}`);
  }

  const outputPath = path.resolve(outPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  console.log("TRUST BUNDLE PACK OK");
}

main();
