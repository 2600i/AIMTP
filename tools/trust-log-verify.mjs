#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HELP = `IntentOS Trust Log Verify CLI

Usage:
  node tools/trust-log-verify.mjs --log path/to/log.jsonl
`;

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
    options[key] = value;
    index += 1;
  }
  return options;
}

function dirnameFromImportMeta() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function loadTrustTransparencyModule() {
  const require = createRequire(import.meta.url);
  const distPath = path.resolve(dirnameFromImportMeta(), "../dist/runtime/intentos/trust-transparency.js");
  try {
    return require(distPath);
  } catch {
    throw new Error("Missing dist/runtime/intentos/trust-transparency.js. Run: npm run build");
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
  }

  if (options.help) {
    console.log(HELP);
    return;
  }
  if (!options.log) {
    console.error(`Missing --log\n\n${HELP}`);
    process.exit(1);
  }

  const { verifyTransparencyLog } = loadTrustTransparencyModule();
  const result = verifyTransparencyLog(path.resolve(options.log));
  if (result.valid) {
    console.log("VERIFIED: chain intact");
    return;
  }

  const brokenAt = typeof result.brokenAt === "number" && result.brokenAt > 0 ? result.brokenAt : 1;
  console.log(`INVALID: chain broken at entry ${brokenAt}`);
  process.exit(1);
}

main();
