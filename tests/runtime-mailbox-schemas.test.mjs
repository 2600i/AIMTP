#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vectorsDir = path.join(root, "tests", "runtime-vectors", "mailbox");
const vectorFiles = fs
  .readdirSync(vectorsDir)
  .filter((name) => name.endsWith(".json"))
  .sort();

assert.equal(vectorFiles.length, 4, "expected one vector file for each mailbox schema");

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

let checked = 0;
for (const vectorFile of vectorFiles) {
  const vector = JSON.parse(fs.readFileSync(path.join(vectorsDir, vectorFile), "utf8"));
  const schemaPath = path.resolve(root, vector.schema);
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const validate = ajv.compile(schema);

  for (const testCase of vector.cases) {
    const actual = validate(testCase.value);
    assert.equal(
      actual,
      testCase.valid,
      `${vectorFile}: ${testCase.name}: ${ajv.errorsText(validate.errors)}`
    );
    checked += 1;
  }
}

assert.equal(checked, 16, "expected all mailbox schema vectors to run");
console.log(`OK: reference relay mailbox schemas (${checked} vectors)`);
