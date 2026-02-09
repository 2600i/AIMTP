#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  signCapabilityPresentation,
  validateCapabilityPresentation
} = require("../runtime/capabilities");

const DEFAULT_PRIVATE_KEY_ENV = "AIMTP_CAP_PRIVATE_KEY";
const DEFAULT_PUBLIC_KEY_ENV = "AIMTP_CAP_PUBLIC_KEY";

const HELP = `AIMTP Capability CLI

Usage:
  node tools/aimtp-cap.mjs <command> [options]

Commands:
  mint     Mint a capability presentation JSON
  inspect  Print a human-readable summary and validation
  verify   Validate a capability presentation JSON (non-zero on failure)
  example  Write example capability JSON files for IntentOS roles

Run command help:
  node tools/aimtp-cap.mjs <command> --help
`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseOptions(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      throw new Error(`Unknown argument: ${token}`);
    }
    const key = token.slice(2);
    if (key === "help" || key === "as-header") {
      options[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    i += 1;
    options[key] = value;
  }
  return options;
}

function parseList(value) {
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parsePositiveInt(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }
  return parsed;
}

function parseUnixTime(value) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected unix timestamp seconds, got: ${value}`);
  }
  return parsed;
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function writeJson(filePath, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, serialized, "utf8");
}

function getEnvKey(options, optionName, defaultName) {
  const envName = options[optionName] || defaultName;
  if (typeof envName !== "string" || !envName.trim()) {
    throw new Error(`${optionName} must be a non-empty env var name`);
  }
  const value = process.env[envName.trim()];
  if (!value || !value.trim()) {
    throw new Error(`Environment variable ${envName} is required`);
  }
  return { envName: envName.trim(), value: value.trim() };
}

function buildScopes(actions, resources) {
  const unique = new Map();
  actions.forEach((action) => {
    resources.forEach((resource) => {
      const key = `${action}::${resource}`;
      if (!unique.has(key)) {
        unique.set(key, { action, resource });
      }
    });
  });
  return Array.from(unique.values());
}

function renderHeaderLine(presentation) {
  const encoded = Buffer.from(JSON.stringify(presentation), "utf8").toString("base64");
  return `X-AIMTP-CAPABILITY: ${encoded}`;
}

function printMintHelp() {
  console.log(`Mint capability presentation

Required:
  --issuer <id>
  --subject <id>
  --aud <audience>
  --actions <comma list>
  --resources <comma list>

Optional:
  --ttl <seconds>                   Default: 3600
  --out <file>                      Default: stdout
  --parent <file>                   Parent presentation file for delegation
  --kid <kid>                       Default: issuer
  --private-key-env <ENV>           Default: ${DEFAULT_PRIVATE_KEY_ENV}
  --public-key-env <ENV>            Default: ${DEFAULT_PUBLIC_KEY_ENV}
  --as-header                       Print header helper line to stderr
  --now <unix-sec>                  Override current time
`);
}

function printInspectHelp() {
  console.log(`Inspect capability presentation

Required:
  --file <path>

Optional:
  --aud <audience>
  --public-key-env <ENV>            Default: ${DEFAULT_PUBLIC_KEY_ENV}
  --now <unix-sec>                  Override current time
`);
}

function printVerifyHelp() {
  console.log(`Verify capability presentation

Required:
  --file <path>

Optional:
  --aud <audience>
  --public-key-env <ENV>            Default: ${DEFAULT_PUBLIC_KEY_ENV}
  --now <unix-sec>                  Override current time
`);
}

function printExampleHelp() {
  console.log(`Write example capability files

Optional:
  --aud <audience>                  Default: http://localhost:8787/aimtp
  --ttl <seconds>                   Default: 1800
  --issuer <issuer-id>              Default: orchestrator.local
  --out-dir <directory>             Default: config/capabilities/examples
  --private-key-env <ENV>           Default: ${DEFAULT_PRIVATE_KEY_ENV}
  --public-key-env <ENV>            Default: ${DEFAULT_PUBLIC_KEY_ENV}
`);
}

function validateOrThrow(presentation, options) {
  const result = validateCapabilityPresentation(presentation, options);
  if (!result.ok) {
    throw new Error(result.errors.join("; "));
  }
  return result;
}

async function runMint(options) {
  if (options.help) {
    printMintHelp();
    return;
  }

  const issuer = typeof options.issuer === "string" ? options.issuer.trim() : "";
  const subject = typeof options.subject === "string" ? options.subject.trim() : "";
  const aud = typeof options.aud === "string" ? options.aud.trim() : "";
  const actions = parseList(options.actions);
  const resources = parseList(options.resources);
  if (!issuer) {
    throw new Error("--issuer is required");
  }
  if (!subject) {
    throw new Error("--subject is required");
  }
  if (!aud) {
    throw new Error("--aud is required");
  }
  if (actions.length === 0) {
    throw new Error("--actions must include at least one action");
  }
  if (resources.length === 0) {
    throw new Error("--resources must include at least one resource");
  }

  const ttl = parsePositiveInt(options.ttl, 3600);
  const nowSec = options.now ? parseUnixTime(options.now) : Math.floor(Date.now() / 1000);
  const { value: privateKey } = getEnvKey(options, "private-key-env", DEFAULT_PRIVATE_KEY_ENV);
  const { value: publicKey } = getEnvKey(options, "public-key-env", DEFAULT_PUBLIC_KEY_ENV);

  let chain = [];
  if (options.parent) {
    const parentPresentation = await readJson(path.resolve(options.parent));
    const parentResult = validateCapabilityPresentation(parentPresentation, {
      aud,
      publicKey,
      nowSec
    });
    if (!parentResult.ok) {
      throw new Error(`Parent presentation is invalid: ${parentResult.errors.join("; ")}`);
    }
    chain = parentResult.chain;
    if (chain.length > 0) {
      const parentLeaf = chain[chain.length - 1];
      if (parentLeaf.subject !== issuer) {
        throw new Error("Parent chain leaf subject must match --issuer for delegation");
      }
    }
  }

  const document = {
    issuer,
    subject,
    aud,
    iat: nowSec,
    exp: nowSec + ttl,
    scopes: buildScopes(actions, resources)
  };
  const fullChain = [...chain, document];
  const kid = typeof options.kid === "string" && options.kid.trim() ? options.kid.trim() : issuer;
  const presentation = signCapabilityPresentation(fullChain, {
    privateKey,
    publicKey,
    kid
  });

  validateOrThrow(presentation, { aud, publicKey, nowSec });
  const output = `${JSON.stringify(presentation, null, 2)}\n`;
  if (options.out) {
    const targetPath = path.resolve(options.out);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, output, "utf8");
  } else {
    process.stdout.write(output);
  }

  if (options["as-header"]) {
    console.error(renderHeaderLine(presentation));
  }
}

function printInspectResult(filePath, result) {
  console.log(`file: ${filePath}`);
  console.log(`issuer: ${result.summary.issuer}`);
  console.log(`subject: ${result.summary.subject}`);
  console.log(`aud: ${result.summary.aud}`);
  console.log(`iat: ${result.summary.iat}`);
  console.log(`exp: ${result.summary.exp}`);
  console.log(`delegation_depth: ${result.summary.depth}`);
  console.log("scopes:");
  result.summary.scopes.forEach((scope) => {
    console.log(`- ${scope.action} ${scope.resource}`);
  });
  if (result.ok) {
    console.log("validation: ok");
  } else {
    console.log("validation: failed");
    result.errors.forEach((error) => console.log(`- ${error}`));
  }
}

async function runInspect(options) {
  if (options.help) {
    printInspectHelp();
    return;
  }
  if (!options.file) {
    throw new Error("--file is required");
  }
  const nowSec = options.now ? parseUnixTime(options.now) : Math.floor(Date.now() / 1000);
  const resolvedFile = path.resolve(options.file);
  const presentation = await readJson(resolvedFile);
  let publicKey = "";
  try {
    publicKey = getEnvKey(options, "public-key-env", DEFAULT_PUBLIC_KEY_ENV).value;
  } catch (_err) {
    publicKey = "";
  }
  const verifySignature = Boolean(publicKey || presentation.public_key);
  const result = validateCapabilityPresentation(presentation, {
    aud: options.aud,
    publicKey: publicKey || undefined,
    nowSec,
    verifySignature
  });
  printInspectResult(resolvedFile, result);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

async function runVerify(options) {
  if (options.help) {
    printVerifyHelp();
    return;
  }
  if (!options.file) {
    throw new Error("--file is required");
  }
  const nowSec = options.now ? parseUnixTime(options.now) : Math.floor(Date.now() / 1000);
  const resolvedFile = path.resolve(options.file);
  const presentation = await readJson(resolvedFile);
  let publicKey = "";
  try {
    publicKey = getEnvKey(options, "public-key-env", DEFAULT_PUBLIC_KEY_ENV).value;
  } catch (_err) {
    publicKey = "";
  }
  const result = validateCapabilityPresentation(presentation, {
    aud: options.aud,
    publicKey: publicKey || undefined,
    nowSec,
    verifySignature: true
  });
  if (!result.ok) {
    result.errors.forEach((error) => console.error(error));
    process.exit(1);
  }
  console.log("VALID");
}

async function writeExamplePresentation(filePath, payload) {
  await writeJson(filePath, payload);
  console.log(`wrote ${filePath}`);
}

async function runExample(options) {
  if (options.help) {
    printExampleHelp();
    return;
  }
  const aud =
    typeof options.aud === "string" && options.aud.trim()
      ? options.aud.trim()
      : "http://localhost:8787/aimtp";
  const ttl = parsePositiveInt(options.ttl, 1800);
  const issuer =
    typeof options.issuer === "string" && options.issuer.trim()
      ? options.issuer.trim()
      : "orchestrator.local";
  const outDir = path.resolve(options["out-dir"] || "config/capabilities/examples");
  const nowSec = Math.floor(Date.now() / 1000);
  const { value: privateKey } = getEnvKey(options, "private-key-env", DEFAULT_PRIVATE_KEY_ENV);
  const { value: publicKey } = getEnvKey(options, "public-key-env", DEFAULT_PUBLIC_KEY_ENV);

  const createPresentation = (subject, scopes, kid) =>
    signCapabilityPresentation(
      [
        {
          issuer,
          subject,
          aud,
          iat: nowSec,
          exp: nowSec + ttl,
          scopes
        }
      ],
      { privateKey, publicKey, kid }
    );

  const orchestrator = createPresentation(
    "orchestrator.local",
    [
      { action: "intentos.read", resource: "intentos:intents" },
      { action: "intentos.read", resource: "intentos:tasks" },
      { action: "intentos.task.enqueue", resource: "intentos:tasks" }
    ],
    "orchestrator.local"
  );
  const agent = createPresentation(
    "agent.demo",
    [
      { action: "intentos.task.claim", resource: "intentos:task/demo-task-001" },
      { action: "intentos.task.result", resource: "intentos:task/demo-task-001" }
    ],
    "agent.demo"
  );
  const viewer = createPresentation(
    "viewer.local",
    [
      { action: "intentos.read", resource: "intentos:intents" },
      { action: "intentos.read", resource: "intentos:tasks" }
    ],
    "viewer.local"
  );

  validateOrThrow(orchestrator, { aud, publicKey, nowSec });
  validateOrThrow(agent, { aud, publicKey, nowSec });
  validateOrThrow(viewer, { aud, publicKey, nowSec });

  await writeExamplePresentation(path.join(outDir, "orchestrator.json"), orchestrator);
  await writeExamplePresentation(path.join(outDir, "agent.json"), agent);
  await writeExamplePresentation(path.join(outDir, "viewer.json"), viewer);
}

async function main() {
  const command = process.argv[2];
  if (!command || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }
  const options = parseOptions(process.argv.slice(3));
  if (command === "mint") {
    await runMint(options);
    return;
  }
  if (command === "inspect") {
    await runInspect(options);
    return;
  }
  if (command === "verify") {
    await runVerify(options);
    return;
  }
  if (command === "example") {
    await runExample(options);
    return;
  }
  fail(`Unknown command: ${command}`);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
