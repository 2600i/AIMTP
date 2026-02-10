#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const COMPOSE_FILE = "docker-compose.federation.yml";
const require = createRequire(import.meta.url);

function loadReceiptPolicyModule() {
  const distPath = path.resolve(process.cwd(), "dist/runtime/intentos/receipt-policy.js");
  if (!fs.existsSync(distPath)) {
    throw new Error("Missing dist/runtime/intentos/receipt-policy.js. Run: npm run build");
  }
  return require(distPath);
}

const { processReceiptEnvelope } = loadReceiptPolicyModule();

const RELAY_CONFIG = Object.freeze({
  "relay-a": {
    issuer: "relay://a",
    receiptPath: "/app/runtime/relay-a-receipts.jsonl",
    envelopeId: "fed-relay-a-env-001",
    intentId: "fed-relay-a-intent-001",
    capabilityId: "fed-relay-a-cap-001"
  },
  "relay-b": {
    issuer: "relay://b",
    receiptPath: "/app/runtime/relay-b-receipts.jsonl",
    envelopeId: "fed-relay-b-env-001",
    intentId: "fed-relay-b-intent-001",
    capabilityId: "fed-relay-b-cap-001"
  }
});

function normalizeTrustVersion(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "v2" ? "v2" : "v1";
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
  const result = runCommand(
    "docker",
    ["compose", "-f", COMPOSE_FILE, ...args],
    options
  );
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
    `require("node:fs").writeFileSync(${JSON.stringify(filePath)}, "", "utf8")`
  ]);
}

function emitSignedReceipt(service, config) {
  const script = `
const { fireDispatch } = require("./dist/protocol/intentos-execution.js");
const env = {
  id: ${JSON.stringify(config.envelopeId)},
  recipient: "agent://calendar",
  createdAtSec: 1770000100,
  intent: {
    id: ${JSON.stringify(config.intentId)},
    requester: "did:example:federation",
    action: "calendar:create_event",
    resource: "calendar://primary/events",
    payload: { title: "federation-demo" }
  },
  capability: {
    id: ${JSON.stringify(config.capabilityId)},
    subject: "did:example:federation",
    audience: "agent://calendar",
    validFromSec: 1770000000,
    validUntilSec: 1770002000,
    scopes: [{ action: "calendar:create_event", resource: "calendar://primary/events" }],
    signature: "demo-sig"
  }
};
fireDispatch(env, env.intent, async () => ({ ok: true, relay: ${JSON.stringify(config.issuer)} }))
  .then((record) => {
    if (record.state !== "Completed") {
      throw new Error("unexpected record state: " + record.state);
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

function verifyReceiptInRelay(service, receipt) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimtp-fed-demo-"));
  const localPath = path.join(tempDir, `receipt-${service}.json`);
  const remotePath = `/tmp/${path.basename(localPath)}`;
  fs.writeFileSync(localPath, `${JSON.stringify(receipt)}\n`, "utf8");

  try {
    runDockerCompose(["cp", localPath, `${service}:${remotePath}`]);
    const verifyResult = runDockerCompose(
      [
        "exec",
        "-T",
        service,
        "node",
        "tools/intentos-receipt-verify.mjs",
        "--receipt",
        remotePath
      ],
      { allowFailure: true }
    );
    if (verifyResult.status !== 0) {
      const stderr = (verifyResult.stderr || "").trim();
      const stdout = (verifyResult.stdout || "").trim();
      const details = [stderr, stdout].filter((value) => value.length > 0).join("\n");
      throw new Error(`verification failed in ${service}${details ? `: ${details}` : ""}`);
    }
    return (verifyResult.stdout || "").trim();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function enforceReceiptPolicy(service, receipt, trustVersion) {
  const result = processReceiptEnvelope({
    id: `receipt-msg-${service}-${receipt.receiptId || "unknown"}`,
    receipt
  }, {
    mode: "enforce",
    trustVersion
  });
  if (!result.accepted) {
    throw new Error(`receipt policy rejected in ${service}: ${result.reason}`);
  }
  return result;
}

function runTrustModePreview(receipt, trustVersion) {
  const unsigned = {
    ...receipt,
    sigAlg: undefined,
    signature: undefined
  };

  const tampered = {
    ...receipt,
    metadata: {
      ...(receipt && typeof receipt.metadata === "object" ? receipt.metadata : {}),
      outputHash: "tampered-demo-output-hash"
    }
  };

  const cases = [
    { name: "unsigned", receipt: unsigned },
    { name: "tampered", receipt: tampered }
  ];

  cases.forEach((entry) => {
    (["warn", "enforce"]).forEach((mode) => {
      const warnings = [];
      const result = processReceiptEnvelope(
        {
          id: `receipt-msg-preview-${entry.name}-${mode}-${entry.receipt.receiptId || "unknown"}`,
          receipt: entry.receipt
        },
        {
          mode,
          trustVersion,
          logger: {
            warn(event) {
              warnings.push(event);
            }
          }
        }
      );
      console.log(
        `DEMO POLICY PREVIEW: case=${entry.name} trustVersion=${trustVersion} mode=${mode} accepted=${String(
          result.accepted
        )} trusted=${String(result.trusted)} reason=${result.reason} warnings=${warnings.length}`
      );
    });
  });
}

async function main() {
  const trustVersion = normalizeTrustVersion(process.env.INTENTOS_TRUST_VERSION);
  const relayA = "relay-a";
  const relayB = "relay-b";

  await waitForRelay(relayA);
  await waitForRelay(relayB);

  resetReceiptFile(relayA, RELAY_CONFIG[relayA].receiptPath);
  resetReceiptFile(relayB, RELAY_CONFIG[relayB].receiptPath);

  emitSignedReceipt(relayA, RELAY_CONFIG[relayA]);
  emitSignedReceipt(relayB, RELAY_CONFIG[relayB]);

  const relayAReceipts = readJsonlFromRelay(relayA, RELAY_CONFIG[relayA].receiptPath);
  const relayBReceipts = readJsonlFromRelay(relayB, RELAY_CONFIG[relayB].receiptPath);

  const relayACompleted = findCompletedReceipt(relayAReceipts, RELAY_CONFIG[relayA].envelopeId);
  const relayBCompleted = findCompletedReceipt(relayBReceipts, RELAY_CONFIG[relayB].envelopeId);

  if (!relayACompleted) {
    throw new Error("missing completed receipt for relay-a");
  }
  if (!relayBCompleted) {
    throw new Error("missing completed receipt for relay-b");
  }

  const relayAPolicy = enforceReceiptPolicy(relayA, relayACompleted, trustVersion);
  const relayBPolicy = enforceReceiptPolicy(relayB, relayBCompleted, trustVersion);

  verifyReceiptInRelay(relayB, relayACompleted);
  verifyReceiptInRelay(relayA, relayBCompleted);

  console.log(
    `DEMO POLICY: ${relayA} trustVersion=${trustVersion} mode=${relayAPolicy.mode} trusted=${String(
      relayAPolicy.trusted
    )}`
  );
  console.log(
    `DEMO POLICY: ${relayB} trustVersion=${trustVersion} mode=${relayBPolicy.mode} trusted=${String(
      relayBPolicy.trusted
    )}`
  );
  runTrustModePreview(relayACompleted, trustVersion);
  console.log("DEMO OK: relay-a receipt verified by relay-b trust store");
  console.log("DEMO OK: relay-b receipt verified by relay-a trust store");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`DEMO FAILED: ${message}`);
  process.exit(1);
});
