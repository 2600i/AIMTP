#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";

const repoRoot = path.resolve(process.cwd());
const require = createRequire(import.meta.url);
const { processReceiptEnvelope, signReceipt } = require(path.resolve(repoRoot, "dist", "index.js"));

function makeTerminalReceipt() {
  return {
    receiptId: "rcpt-federation-v2-001",
    envelopeId: "env-federation-v2-001",
    intentId: "intent-federation-v2-001",
    type: "receipt.completed",
    timestamp: "2026-02-19T10:00:00.000Z",
    metadata: { outputHash: "sha256:ok" },
    issuer: "relay://federation-alpha",
    sigAlg: "ed25519"
  };
}

function evaluate(mode, receipt, trustedReceiptKeys) {
  return processReceiptEnvelope(
    { receipt },
    {
      mode,
      env: {
        INTENTOS_TRUST_VERSION: "v2"
      },
      trustedReceiptKeys
    }
  );
}

function testUnsignedTerminalReceiptRejectedInAllModes() {
  const receipt = makeTerminalReceipt();
  const trustedKeys = {};

  const warnResult = evaluate("warn", receipt, trustedKeys);
  const enforceResult = evaluate("enforce", receipt, trustedKeys);

  assert.equal(warnResult.accepted, false);
  assert.equal(enforceResult.accepted, false);
  assert.match(warnResult.reason, /missing signature/i);
  assert.match(enforceResult.reason, /missing signature/i);
}

function testTamperedTerminalReceiptRejectedInAllModes() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const issuer = "relay://federation-alpha";

  const signed = signReceipt(makeTerminalReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
  const tampered = {
    ...signed,
    metadata: { outputHash: "sha256:tampered" }
  };
  const trustedKeys = {
    [issuer]: publicKeyPem
  };

  const warnResult = evaluate("warn", tampered, trustedKeys);
  const enforceResult = evaluate("enforce", tampered, trustedKeys);

  assert.equal(warnResult.accepted, false);
  assert.equal(enforceResult.accepted, false);
  assert.match(warnResult.reason, /invalid signature|signature invalid/i);
  assert.match(enforceResult.reason, /invalid signature|signature invalid/i);
}

function main() {
  testUnsignedTerminalReceiptRejectedInAllModes();
  testTamperedTerminalReceiptRejectedInAllModes();
  console.log("OK: federation v2 policy regression tests");
}

main();
