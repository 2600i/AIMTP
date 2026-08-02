#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
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

const RELAY_PRIVATE_KEYS = Object.freeze({
  "relay://b": [
    "-----BEGIN PRIVATE KEY-----",
    "MC4CAQAwBQYDK2VwBCIEIIOeZRQ327rtKArRvONoV7k9fow3LfRRQe9ZQ0Y+eHs4",
    "-----END PRIVATE KEY-----",
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

function normalizeBridgeFlag(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes";
}

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

function loadRuntimeApi() {
  const distPath = path.resolve(process.cwd(), "dist/index.js");
  if (!fs.existsSync(distPath)) {
    throw new Error("Missing dist/index.js. Run: npm run build");
  }
  return require(distPath);
}

function readJsonFromPath(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function mintBridgeProofWithTool(issuer, subject, subjectPublicKeyPem) {
  const issuerPrivateKeyPem = RELAY_PRIVATE_KEYS[issuer];
  if (!issuerPrivateKeyPem) {
    throw new Error(`missing bridge private key for issuer: ${issuer}`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimtp-bridge-proof-demo3-"));
  const subjectKeyPath = path.join(tempDir, "subject-public.pem");
  const issuerKeyPath = path.join(tempDir, "issuer-private.pem");
  const outputPath = path.join(tempDir, "bridge-proof.json");
  fs.writeFileSync(subjectKeyPath, subjectPublicKeyPem, "utf8");
  fs.writeFileSync(issuerKeyPath, issuerPrivateKeyPem, "utf8");

  const result = runCommand(process.execPath, [
    path.resolve(process.cwd(), "tools", "bridge-proof.mjs"),
    "mint",
    "--issuer",
    issuer,
    "--subject",
    subject,
    "--subject-key",
    subjectKeyPath,
    "--ttl",
    "120",
    "--out",
    outputPath,
    "--issuer-key",
    issuerKeyPath
  ]);
  if (result.status !== 0) {
    const details = `${(result.stdout || "").trim()} ${(result.stderr || "").trim()}`.trim();
    throw new Error(`bridge proof tool mint failed${details ? `: ${details}` : ""}`);
  }
  return readJsonFromPath(outputPath);
}

function evaluateReceipt(
  processReceiptEnvelope,
  receipt,
  trustedReceiptKeys,
  trustVersion,
  bridgeProof = null
) {
  return processReceiptEnvelope(
    {
      id: `receipt-msg-demo3-${receipt.receiptId || "unknown"}`,
      receipt
    },
    {
      mode: "enforce",
      trustVersion,
      trustedReceiptKeys,
      ...(bridgeProof ? { trustBridgeProofJson: JSON.stringify(bridgeProof) } : {}),
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
  const bridgeEnabled = normalizeBridgeFlag(process.env.FEDERATION_BRIDGE);
  const bridgeUseTool = normalizeBridgeFlag(process.env.FEDERATION_BRIDGE_USE_TOOL);
  const bridgeProofPath = typeof process.env.FEDERATION_BRIDGE_PROOF_PATH === "string"
    ? process.env.FEDERATION_BRIDGE_PROOF_PATH.trim()
    : "";
  const runtimeApi = loadRuntimeApi();
  const { processReceiptEnvelope } = runtimeApi;

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

  if (bridgeEnabled && trustVersion === "v2") {
    const bridgeProof = bridgeProofPath
      ? readJsonFromPath(bridgeProofPath)
      : bridgeUseTool
        ? mintBridgeProofWithTool("relay://b", "relay://c", RELAY_PUBLIC_KEYS["relay://c"])
        : runtimeApi.createBridgeProof(
          {
            issuer: "relay://b",
            subject: "relay://c",
            subjectPublicKeyPem: RELAY_PUBLIC_KEYS["relay://c"],
            issuedAt: Math.floor(Date.now() / 1000),
            expiresAt: Math.floor(Date.now() / 1000) + 120
          },
          RELAY_PRIVATE_KEYS["relay://b"]
        );
    const case4 = evaluateReceipt(
      processReceiptEnvelope,
      receiptC,
      trustedByA,
      trustVersion,
      bridgeProof
    );
    printCaseResult("Case 4: A verifies C with bridge proof", case4, true);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`DEMO3 FAILED: ${message}`);
  process.exit(1);
});
