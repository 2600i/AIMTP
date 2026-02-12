#!/usr/bin/env node

import process from "node:process";
import { spawnSync } from "node:child_process";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args) {
  const printable = `${command} ${args.join(" ")}`.trim();
  console.log(`$ ${printable}`);
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    fail(`Failed to run "${printable}": ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function parseArgs(argv) {
  let version = "";
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--version") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        fail("Missing value for --version");
      }
      version = value.trim();
      index += 1;
      continue;
    }
    fail(`Unknown argument: ${token}`);
  }
  return { version };
}

function main() {
  const { version } = parseArgs(process.argv.slice(2));

  const preflightArgs = ["scripts/release.mjs", "preflight"];
  if (version) {
    preflightArgs.push("--version", version);
  }
  run(process.execPath, preflightArgs);

  run("npm", ["test"]);
  run("npm", ["run", "build"]);
  run("npm", ["run", "test:receipts"]);
  run("npm", ["run", "smoke:rc"]);

  console.log("Release verify checks passed.");
}

main();
