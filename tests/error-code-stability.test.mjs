#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(process.cwd());
const docsPath = path.resolve(repoRoot, "docs", "intentos-federation.md");
const testsDir = path.resolve(repoRoot, "tests");

const MAJOR_CODE_MATRIX = [
  {
    code: "handshake_capability_required_missing",
    meaning: "handshake negotiation required-missing reject"
  },
  {
    code: "handshake_identity_anchor_signature_invalid",
    meaning: "inline anchor signature reject"
  },
  {
    code: "handshake_peer_proof_missing",
    meaning: "peer proof missing in enforce mode"
  },
  {
    code: "handshake_peer_proof_invalid",
    meaning: "peer proof invalid signature/payload"
  },
  {
    code: "handshake_peer_proof_key_unknown",
    meaning: "peer proof key id mismatch"
  },
  {
    code: "handshake_peer_revoked",
    meaning: "revoked peer reject/warn path"
  },
  {
    code: "handshake_key_revoked",
    meaning: "revoked key reject/warn path"
  },
  {
    code: "anchor_revoked",
    meaning: "revoked anchor reject/warn path"
  },
  {
    code: "identity_anchor_fetch_invalid_json",
    meaning: "anchor fetch invalid JSON"
  },
  {
    code: "identity_anchor_fetch_schema_invalid",
    meaning: "anchor fetch schema invalid"
  },
  {
    code: "revocation_fetch_invalid_json",
    meaning: "revocation fetch invalid JSON"
  },
  {
    code: "revocation_fetch_schema_invalid",
    meaning: "revocation fetch schema invalid"
  },
  {
    code: "revocation_proof_missing",
    meaning: "revocation proof required but missing"
  },
  {
    code: "revocation_proof_key_unknown",
    meaning: "revocation proof key id unknown"
  },
  {
    code: "revocation_proof_invalid",
    meaning: "revocation proof invalid"
  },
  {
    code: "revocation_proof_verified",
    meaning: "revocation proof verified success signal"
  },
  {
    code: "trust_bundle_invalid",
    meaning: "trust bundle invalid schema/json"
  },
  {
    code: "input_unreadable",
    meaning: "trust bundle apply input path unreadable"
  }
];

function collectTestSources() {
  const entries = fs
    .readdirSync(testsDir)
    .filter((entry) => entry.endsWith(".js") || entry.endsWith(".mjs") || entry.endsWith(".ts"));
  return entries.map((entry) => ({
    file: entry,
    content: fs.readFileSync(path.join(testsDir, entry), "utf8")
  }));
}

function testDocsContainEveryMajorCode() {
  const docs = fs.readFileSync(docsPath, "utf8");
  for (const item of MAJOR_CODE_MATRIX) {
    assert.ok(
      docs.includes(`\`${item.code}\``) || docs.includes(item.code),
      `docs missing code ${item.code} (${item.meaning})`
    );
  }
}

function testMajorCodesAreAssertedInTests() {
  const sources = collectTestSources();
  for (const item of MAJOR_CODE_MATRIX) {
    const matching = sources.filter((source) => source.content.includes(item.code)).map((source) => source.file);
    assert.ok(
      matching.length > 0,
      `no test assertion reference found for ${item.code} (${item.meaning})`
    );
  }
}

function main() {
  testDocsContainEveryMajorCode();
  testMajorCodesAreAssertedInTests();
  console.log("OK: error code stability tests");
}

main();
