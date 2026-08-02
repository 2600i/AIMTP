#!/usr/bin/env node
//
// AIMTP conformance runner.
//
// Verifies that an AIMTP implementation agrees with the frozen aimtp/0.1 wire
// contract across four dimensions:
//
//   1. schema      -- envelope/message vectors validate (or fail) as specified
//   2. canonical   -- the canonical signing payload is byte-identical
//   3. signing     -- signature verification accepts/rejects as specified
//   4. integrity   -- schema $id namespace is coherent and refs resolve
//
// Usage:
//   node tests/conformance/run.mjs
//   node tests/conformance/run.mjs --json
//   node tests/conformance/run.mjs --schemas ./my-schemas --vectors ./my-vectors
//   node tests/conformance/run.mjs --only canonical,signing
//
// Exits 0 when every check passes, 1 otherwise.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import Ajv2020 from "ajv/dist/2020.js";
import Ajv07 from "ajv";
import addFormats from "ajv-formats";

const require = createRequire(import.meta.url);
const here = import.meta.dirname;
const repoRoot = path.resolve(here, "..", "..");

const CANONICAL_SCHEMA_ORIGIN = "https://aimtp.net";
const SPEC_VERSION = "aimtp/0.1";

// --------------------------------------------------------------------------
// args
// --------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { json: false, only: null, schemas: null, vectors: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      args.json = true;
    } else if (arg === "--only") {
      args.only = new Set(String(argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean));
    } else if (arg === "--schemas") {
      args.schemas = path.resolve(argv[++i]);
    } else if (arg === "--vectors") {
      args.vectors = path.resolve(argv[++i]);
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "AIMTP conformance runner",
          "",
          "  --json                 machine-readable report on stdout",
          "  --only <suites>        comma list of: schema,canonical,signing,integrity",
          "  --schemas <dir>        schema directory (default: <repo>/schemas)",
          "  --vectors <dir>        envelope vector directory (default: <repo>/tests/vectors)",
          ""
        ].join("\n")
      );
      process.exit(0);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const schemasDir = args.schemas || path.join(repoRoot, "schemas");
const specDir = path.join(repoRoot, "spec");
const envelopeVectorsDir = args.vectors || path.join(repoRoot, "tests", "vectors");
const canonicalVectorsDir = path.join(here, "vectors", "canonicalization");
const signingVectorsDir = path.join(here, "vectors", "signing");

// --------------------------------------------------------------------------
// reporting
// --------------------------------------------------------------------------
const results = [];
function record(suite, name, ok, detail) {
  results.push({ suite, name, ok, ...(detail ? { detail } : {}) });
}
function suiteEnabled(name) {
  return !args.only || args.only.has(name);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}
function listJson(dir) {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
}
function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// --------------------------------------------------------------------------
// 1. schema vectors
// --------------------------------------------------------------------------
function buildEnvelopeValidator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const message = readJson(path.join(schemasDir, "message.schema.json"));
  const envelope = readJson(path.join(schemasDir, "envelope.schema.json"));
  // envelope.schema.json refs "message.schema.json" relatively; that resolves
  // against the envelope's own $id, so registering under the message $id is
  // sufficient (and registering twice makes Ajv throw on the duplicate key).
  ajv.addSchema(message, message.$id);
  return ajv.compile(envelope);
}

function runSchemaSuite() {
  let validate;
  try {
    validate = buildEnvelopeValidator();
  } catch (err) {
    record("schema", "compile-envelope-schema", false, err.message);
    return;
  }
  record("schema", "compile-envelope-schema", true);

  const files = listJson(envelopeVectorsDir);
  if (files.length === 0) {
    record("schema", "discover-vectors", false, `no vectors found in ${envelopeVectorsDir}`);
    return;
  }

  for (const file of files) {
    // Convention: valid-* must validate, invalid-* must not.
    let shouldPass;
    if (file.startsWith("valid-")) {
      shouldPass = true;
    } else if (file.startsWith("invalid-")) {
      shouldPass = false;
    } else {
      record("schema", file, false, "vector name must start with 'valid-' or 'invalid-'");
      continue;
    }

    let data;
    try {
      data = readJson(path.join(envelopeVectorsDir, file));
    } catch (err) {
      record("schema", file, false, `unparseable JSON: ${err.message}`);
      continue;
    }

    const passed = validate(data);
    if (shouldPass && !passed) {
      const first = (validate.errors || [])[0];
      record(
        "schema",
        file,
        false,
        `expected valid but failed: ${first ? `${first.instancePath || "/"} ${first.message}` : "unknown"}`
      );
    } else if (!shouldPass && passed) {
      record("schema", file, false, "expected invalid but it validated");
    } else {
      record("schema", file, true);
    }
  }

  // Every valid vector must also declare the frozen spec version.
  for (const file of files.filter((f) => f.startsWith("valid-"))) {
    const data = readJson(path.join(envelopeVectorsDir, file));
    if (data.spec !== SPEC_VERSION) {
      record("schema", `${file}:spec-version`, false, `spec must be "${SPEC_VERSION}", got "${data.spec}"`);
    } else {
      record("schema", `${file}:spec-version`, true);
    }
  }
}

// --------------------------------------------------------------------------
// 2. canonicalization vectors
// --------------------------------------------------------------------------
function runCanonicalSuite() {
  let canonicalizeEnvelopeForSigning;
  try {
    ({ canonicalizeEnvelopeForSigning } = require(path.join(repoRoot, "runtime", "signature.js")));
  } catch (err) {
    record("canonical", "load-implementation", false, err.message);
    return;
  }

  const files = listJson(canonicalVectorsDir);
  if (files.length === 0) {
    record("canonical", "discover-vectors", false, `no vectors in ${canonicalVectorsDir}`);
    return;
  }

  const collapsed = new Map();
  for (const file of files) {
    const vector = readJson(path.join(canonicalVectorsDir, file));
    let actualBytes;
    try {
      actualBytes = canonicalizeEnvelopeForSigning(vector.envelope);
    } catch (err) {
      record("canonical", vector.name, false, `canonicalization threw: ${err.message}`);
      continue;
    }
    const actual = actualBytes.toString("utf8");

    if (actual !== vector.canonical) {
      record(
        "canonical",
        vector.name,
        false,
        `canonical bytes differ\n      expected: ${vector.canonical}\n      actual:   ${actual}`
      );
      continue;
    }
    const actualSha = sha256Hex(actualBytes);
    if (actualSha !== vector.canonical_sha256) {
      record("canonical", vector.name, false, `sha256 mismatch: expected ${vector.canonical_sha256}, got ${actualSha}`);
      continue;
    }
    if (actualBytes.length !== vector.canonical_byte_length) {
      record(
        "canonical",
        vector.name,
        false,
        `byte length mismatch: expected ${vector.canonical_byte_length}, got ${actualBytes.length}`
      );
      continue;
    }
    // The canonical form must never contain the stripped signature field.
    if (actual.includes('"signature"')) {
      record("canonical", vector.name, false, "canonical payload still contains a signature field");
      continue;
    }
    collapsed.set(vector.name, actual);
    record("canonical", vector.name, true);
  }

  // Order-independence invariant: these three MUST produce identical bytes.
  const invariantGroup = ["minimal-envelope", "key-order-independence", "signature-field-excluded"];
  const present = invariantGroup.filter((n) => collapsed.has(n));
  if (present.length === invariantGroup.length) {
    const unique = new Set(present.map((n) => collapsed.get(n)));
    if (unique.size === 1) {
      record("canonical", "order-independence-invariant", true);
    } else {
      record(
        "canonical",
        "order-independence-invariant",
        false,
        "key order or signature stripping changed the canonical bytes"
      );
    }
  }
}

// --------------------------------------------------------------------------
// 3. signing vectors
// --------------------------------------------------------------------------
function runSigningSuite() {
  let verifyEnvelopeSignature;
  try {
    ({ verifyEnvelopeSignature } = require(path.join(repoRoot, "runtime", "signature.js")));
  } catch (err) {
    record("signing", "load-implementation", false, err.message);
    return;
  }

  const files = listJson(signingVectorsDir);
  if (files.length === 0) {
    record("signing", "discover-vectors", false, `no vectors in ${signingVectorsDir}`);
    return;
  }

  for (const file of files) {
    const vector = readJson(path.join(signingVectorsDir, file));
    const config = {
      policy: "enforce",
      clockSkewSec: 0,
      trustedKeys: new Map(Object.entries(vector.trusted_keys || {})),
      ...(vector.verify_at ? { nowMs: Date.parse(vector.verify_at) } : {})
    };

    let result;
    try {
      result = verifyEnvelopeSignature(vector.envelope, config);
    } catch (err) {
      record("signing", vector.name, false, `verification threw: ${err.message}`);
      continue;
    }

    if (vector.expect === "verify") {
      if (result.ok) {
        record("signing", vector.name, true);
      } else {
        record("signing", vector.name, false, `expected verify, got ${result.code}: ${result.message}`);
      }
      continue;
    }

    // expect === "reject"
    if (result.ok) {
      record("signing", vector.name, false, "expected rejection but signature verified");
    } else if (vector.expect_code && result.code !== vector.expect_code) {
      record("signing", vector.name, false, `expected code ${vector.expect_code}, got ${result.code}`);
    } else {
      record("signing", vector.name, true);
    }
  }
}

// --------------------------------------------------------------------------
// 4. schema integrity
// --------------------------------------------------------------------------
function runIntegritySuite() {
  const schemaFiles = [
    ...listJson(schemasDir).map((f) => path.join(schemasDir, f)),
    ...listJson(specDir).map((f) => path.join(specDir, f))
  ];

  if (schemaFiles.length === 0) {
    record("integrity", "discover-schemas", false, "no schema files found");
    return;
  }

  // Every $id must sit under one canonical origin. A split namespace makes
  // $ref resolution ambiguous for outside implementers.
  const origins = new Map();
  for (const file of schemaFiles) {
    const schema = readJson(file);
    const rel = path.relative(repoRoot, file);
    if (!schema.$id) {
      record("integrity", `${rel}:has-id`, false, "schema is missing $id");
      continue;
    }
    let origin;
    try {
      origin = new URL(schema.$id).origin;
    } catch {
      record("integrity", `${rel}:has-id`, false, `$id is not an absolute URL: ${schema.$id}`);
      continue;
    }
    origins.set(rel, origin);
    if (origin !== CANONICAL_SCHEMA_ORIGIN) {
      record("integrity", `${rel}:canonical-origin`, false, `$id origin ${origin} != ${CANONICAL_SCHEMA_ORIGIN}`);
    } else {
      record("integrity", `${rel}:canonical-origin`, true);
    }
  }

  const distinct = new Set(origins.values());
  if (distinct.size <= 1) {
    record("integrity", "single-schema-origin", true);
  } else {
    record("integrity", "single-schema-origin", false, `multiple origins in use: ${[...distinct].join(", ")}`);
  }

  // Absolute $refs must point at a schema we actually ship.
  const knownIds = new Set(schemaFiles.map((f) => readJson(f).$id).filter(Boolean));
  for (const file of schemaFiles) {
    const rel = path.relative(repoRoot, file);
    const raw = readFileSync(file, "utf8");
    const refs = [...raw.matchAll(/"\$ref"\s*:\s*"(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
    let allResolved = true;
    for (const ref of refs) {
      const base = ref.split("#")[0];
      if (!knownIds.has(base)) {
        record("integrity", `${rel}:ref-resolves`, false, `absolute $ref does not match any shipped $id: ${ref}`);
        allResolved = false;
      }
    }
    if (allResolved && refs.length > 0) {
      record("integrity", `${rel}:ref-resolves`, true);
    }
  }

  // Draft-07 schemas must compile too (federation/trust surface).
  const ajv07 = new Ajv07({ strict: false, allErrors: true });
  addFormats(ajv07);
  const draft07Files = schemaFiles.filter(
    (f) => String(readJson(f).$schema || "").includes("draft-07")
  );
  for (const file of draft07Files) {
    ajv07.addSchema(readJson(file), readJson(file).$id);
  }
  for (const file of draft07Files) {
    const rel = path.relative(repoRoot, file);
    try {
      ajv07.getSchema(readJson(file).$id);
      record("integrity", `${rel}:compiles`, true);
    } catch (err) {
      record("integrity", `${rel}:compiles`, false, err.message);
    }
  }

  // The bridge proof schema is embedded as a frozen constant in TypeScript AND
  // shipped as a file. They must not drift.
  const bridgeFile = path.join(schemasDir, "bridge-proof-v1.schema.json");
  const distIndex = path.join(repoRoot, "dist", "index.js");
  if (existsSync(bridgeFile) && existsSync(distIndex)) {
    try {
      const { BRIDGE_PROOF_SCHEMA } = require(distIndex);
      const fileSchema = readJson(bridgeFile);
      const a = JSON.stringify(fileSchema);
      const b = JSON.stringify(JSON.parse(JSON.stringify(BRIDGE_PROOF_SCHEMA)));
      if (a === b) {
        record("integrity", "bridge-proof-embedded-matches-file", true);
      } else {
        const keys = new Set([...Object.keys(fileSchema), ...Object.keys(BRIDGE_PROOF_SCHEMA)]);
        const differing = [...keys].filter(
          (k) => JSON.stringify(fileSchema[k]) !== JSON.stringify(BRIDGE_PROOF_SCHEMA[k])
        );
        record(
          "integrity",
          "bridge-proof-embedded-matches-file",
          false,
          `schemas/bridge-proof-v1.schema.json drifted from src/protocol/bridge-proof.ts at: ${differing.join(", ")}`
        );
      }
    } catch (err) {
      record("integrity", "bridge-proof-embedded-matches-file", false, err.message);
    }
  }

  // The frozen wire version must be exactly aimtp/0.1.
  const envelope = readJson(path.join(schemasDir, "envelope.schema.json"));
  const declared = envelope?.properties?.spec?.const;
  if (declared === SPEC_VERSION) {
    record("integrity", "frozen-spec-version", true);
  } else {
    record("integrity", "frozen-spec-version", false, `envelope spec const is "${declared}", expected "${SPEC_VERSION}"`);
  }
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------
if (suiteEnabled("schema")) runSchemaSuite();
if (suiteEnabled("canonical")) runCanonicalSuite();
if (suiteEnabled("signing")) runSigningSuite();
if (suiteEnabled("integrity")) runIntegritySuite();

const failed = results.filter((r) => !r.ok);
const bySuite = results.reduce((acc, r) => {
  acc[r.suite] = acc[r.suite] || { passed: 0, failed: 0 };
  acc[r.suite][r.ok ? "passed" : "failed"] += 1;
  return acc;
}, {});

if (args.json) {
  console.log(
    JSON.stringify(
      {
        ok: failed.length === 0,
        spec_version: SPEC_VERSION,
        canonical_schema_origin: CANONICAL_SCHEMA_ORIGIN,
        totals: { passed: results.length - failed.length, failed: failed.length },
        suites: bySuite,
        results
      },
      null,
      2
    )
  );
} else {
  console.log("AIMTP conformance report");
  console.log(`  wire version: ${SPEC_VERSION}`);
  console.log(`  schema origin: ${CANONICAL_SCHEMA_ORIGIN}`);
  console.log("");
  for (const suite of Object.keys(bySuite)) {
    const { passed, failed: f } = bySuite[suite];
    const mark = f === 0 ? "PASS" : "FAIL";
    console.log(`  [${mark}] ${suite.padEnd(10)} ${passed} passed, ${f} failed`);
  }
  if (failed.length > 0) {
    console.log("");
    console.log("Failures:");
    for (const failure of failed) {
      console.log(`  - ${failure.suite}/${failure.name}`);
      if (failure.detail) {
        console.log(`      ${failure.detail}`);
      }
    }
  }
  console.log("");
  console.log(
    failed.length === 0
      ? `OK: conformance (${results.length} checks)`
      : `FAILED: ${failed.length} of ${results.length} checks`
  );
}

process.exit(failed.length === 0 ? 0 : 1);
