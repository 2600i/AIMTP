#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const COMPOSE_FILE = "docker-compose.federation-3hop.yml";
const require = createRequire(import.meta.url);

const RELAY_PUBLIC_KEYS = Object.freeze({
  "relay://a": [
    "-----BEGIN PUBLIC KEY-----",
    "MCowBQYDK2VwAyEAQfzjXFsveEOYsv55DKXnd7VcM66OXZbDq3ACaKMwdoo=",
    "-----END PUBLIC KEY-----",
    ""
  ].join("\n"),
  "relay://b": [
    "-----BEGIN PUBLIC KEY-----",
    "MCowBQYDK2VwAyEApGNKaYbjOmsXFIzMGv5S27A3s/ORB2vcILeZCkxRjNc=",
    "-----END PUBLIC KEY-----",
    ""
  ].join("\n"),
  "relay://c": [
    "-----BEGIN PUBLIC KEY-----",
    "MCowBQYDK2VwAyEAPj1Ybwvb3AvgdJyfzrFAVDp2ebq12oJufsYbyxCCeww=",
    "-----END PUBLIC KEY-----",
    ""
  ].join("\n")
});

const RELAY_CONFIG = Object.freeze({
  "relay-a": {
    issuer: "relay://a",
    receiptPath: "/app/runtime/relay-a-receipts.jsonl",
    envelopeId: "fed3-relay-a-env-001",
    intentId: "fed3-relay-a-intent-001",
    capabilityId: "fed3-relay-a-cap-001"
  },
  "relay-b": {
    issuer: "relay://b",
    receiptPath: "/app/runtime/relay-b-receipts.jsonl",
    envelopeId: "fed3-relay-b-env-001",
    intentId: "fed3-relay-b-intent-001",
    capabilityId: "fed3-relay-b-cap-001"
  },
  "relay-c": {
    issuer: "relay://c",
    receiptPath: "/app/runtime/relay-c-receipts.jsonl",
    envelopeId: "fed3-relay-c-env-001",
    intentId: "fed3-relay-c-intent-001",
    capabilityId: "fed3-relay-c-cap-001"
  }
});

function normalizeTrustVersion(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "v1" ? "v1" : "v2";
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...options
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function runDockerCompose(args, options = {}) {
  const result = runCommand("docker", ["compose", "-f", COMPOSE_FILE, ...args], options);
  if (options.allowFailure || result.status === 0) {
    return result;
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  const details = [stderr, stdout].filter((value) => value.length > 0).join("\n");
  throw new Error(`docker compose ${args.join(" ")} failed${details ? `: ${details}` : ""}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRelay(service, attempts = 30, delayMs = 500) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const probe = runDockerCompose(
      ["exec", "-T", service, "node", "-e", "process.stdout.write('ok')"],
      { allowFailure: true }
    );
    if (probe.status === 0) {
      return;
    }
    await sleep(delayMs);
  }
  throw new Error(`relay did not become ready: ${service}`);
}

function resetReceiptFile(service, filePath) {
  runDockerCompose([
    "exec",
    "-T",
    service,
    "node",
    "-e",
    `require(\"node:fs\").writeFileSync(${JSON.stringify(filePath)}, \"\", \"utf8\")`
  ]);
}

function emitSignedReceipt(service, config) {
  const script = `
const { fireDispatch } = require(\"./dist/protocol/intentos-execution.js\");
const env = {
  id: ${JSON.stringify(config.envelopeId)},
  recipient: \"agent://calendar\",
  createdAtSec: 1770000100,
  intent: {
    id: ${JSON.stringify(config.intentId)},
    requester: \"did:example:federation3\",
    action: \"calendar:create_event\",
    resource: \"calendar://primary/events\",
    payload: { title: \"federation-3hop-demo\" }
  },
  capability: {
    id: ${JSON.stringify(config.capabilityId)},
    subject: \"did:example:federation3\",
    audience: \"agent://calendar\",
    validFromSec: 1770000000,
    validUntilSec: 1770002000,
    scopes: [{ action: \"calendar:create_event\", resource: \"calendar://primary/events\" }],
    signature: \"demo3-sig\"
  }
};
fireDispatch(env, env.intent, async () => ({ ok: true, relay: ${JSON.stringify(config.issuer)} }))
  .then((record) => {
    if (record.state !== \"Completed\") {
      throw new Error(\"unexpected record state: \" + record.state);
    }
    process.stdout.write(record.state);
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(message);
    process.exit(1);
  });
`;

  runDockerCompose(["exec", "-T", service, "node", "-e", script]);
}

function readJsonlFromRelay(service, filePath) {
  const result = runDockerCompose(["exec", "-T", service, "cat", filePath]);
  return (result.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function findCompletedReceipt(receipts, envelopeId) {
  return receipts.find(
    (receipt) =>
      receipt &&
      typeof receipt === "object" &&
      receipt.envelopeId === envelopeId &&
      receipt.type === "receipt.completed"
  );
}

function loadReceiptPolicyModule() {
  const distPath = path.resolve(process.cwd(), "dist/runtime/intentos/receipt-policy.js");
  if (!fs.existsSync(distPath)) {
    throw new Error("Missing dist/runtime/intentos/receipt-policy.js. Run: npm run build");
  }
  return require(distPath);
}

function evaluateReceipt(processReceiptEnvelope, receipt, trustedReceiptKeys, trustVersion) {
  return processReceiptEnvelope(
    {
      id: `receipt-msg-demo3-${receipt.receiptId || "unknown"}`,
      receipt
    },
    {
      mode: "enforce",
      trustVersion,
      trustedReceiptKeys,
      env: {
        INTENTOS_TRUST_VERSION: trustVersion
      }
    }
  );
}

function printCaseResult(label, result, expectedAccepted) {
  if (result.accepted === expectedAccepted) {
    if (expectedAccepted) {
      console.log(`DEMO3 OK: ${label}`);
    } else {
      console.log(`DEMO3 REJECT: ${label} reason=${result.reason}`);
    }
    return;
  }

  if (expectedAccepted) {
    throw new Error(`expected accept for ${label}, got reject: ${result.reason}`);
  }
  throw new Error(`expected reject for ${label}, got accept`);
}

async function main() {
  const trustVersion = normalizeTrustVersion(process.env.INTENTOS_TRUST_VERSION);
  const { processReceiptEnvelope } = loadReceiptPolicyModule();

  await waitForRelay("relay-a");
  await waitForRelay("relay-b");
  await waitForRelay("relay-c");

  for (const [service, config] of Object.entries(RELAY_CONFIG)) {
    resetReceiptFile(service, config.receiptPath);
    emitSignedReceipt(service, config);
  }

  const receiptA = findCompletedReceipt(
    readJsonlFromRelay("relay-a", RELAY_CONFIG["relay-a"].receiptPath),
    RELAY_CONFIG["relay-a"].envelopeId
  );
  const receiptB = findCompletedReceipt(
    readJsonlFromRelay("relay-b", RELAY_CONFIG["relay-b"].receiptPath),
    RELAY_CONFIG["relay-b"].envelopeId
  );
  const receiptC = findCompletedReceipt(
    readJsonlFromRelay("relay-c", RELAY_CONFIG["relay-c"].receiptPath),
    RELAY_CONFIG["relay-c"].envelopeId
  );

  if (!receiptA || !receiptB || !receiptC) {
    throw new Error("missing completed receipt for one or more relays");
  }

  // Direct-trust semantics: only directly configured issuer keys are accepted.
  const trustedByA = {
    "relay://a": RELAY_PUBLIC_KEYS["relay://a"],
    "relay://b": RELAY_PUBLIC_KEYS["relay://b"]
  };
  const trustedByB = {
    "relay://a": RELAY_PUBLIC_KEYS["relay://a"],
    "relay://b": RELAY_PUBLIC_KEYS["relay://b"],
    "relay://c": RELAY_PUBLIC_KEYS["relay://c"]
  };
  const trustedByC = {
    "relay://b": RELAY_PUBLIC_KEYS["relay://b"],
    "relay://c": RELAY_PUBLIC_KEYS["relay://c"]
  };

  const case1 = evaluateReceipt(processReceiptEnvelope, receiptA, trustedByB, trustVersion);
  printCaseResult("Case 1: B verifies A", case1, true);

  const case2 = evaluateReceipt(processReceiptEnvelope, receiptB, trustedByC, trustVersion);
  printCaseResult("Case 2: C verifies B", case2, true);

  const case3 = evaluateReceipt(processReceiptEnvelope, receiptC, trustedByA, trustVersion);
  printCaseResult("Case 3: A verifies C", case3, false);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`DEMO3 FAILED: ${message}`);
  process.exit(1);
});
