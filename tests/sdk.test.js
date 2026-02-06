"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { decodeEnvelope, encodeEnvelope, validateEnvelope } = require("../src/sdk/index.js");

const ROOT = path.resolve(__dirname, "..");
const VECTORS = path.join(ROOT, "tests", "vectors");

function loadVector(name) {
  const raw = fs.readFileSync(path.join(VECTORS, name), "utf-8");
  return JSON.parse(raw);
}

function assertValid(name) {
  const data = loadVector(name);
  const errors = validateEnvelope(data);
  assert.strictEqual(errors.length, 0, `${name} should be valid`);
  const encoded = encodeEnvelope(data);
  const decoded = decodeEnvelope(encoded);
  assert.deepStrictEqual(decoded, data, `${name} round trip`);
}

function assertInvalid(name) {
  const data = loadVector(name);
  const errors = validateEnvelope(data);
  assert.ok(errors.length > 0, `${name} should be invalid`);
  assert.throws(() => encodeEnvelope(data));
}

function main() {
  assertValid("valid-envelope.json");
  assertValid("valid-envelope-attachment.json");
  assertValid("valid-envelope-signature.json");
  assertValid("valid-envelope-signature-legacy.json");

  assertInvalid("invalid-missing-spec.json");
  assertInvalid("invalid-bad-role.json");
  assertInvalid("invalid-missing-message.json");

  console.log("OK: sdk tests");
}

main();
