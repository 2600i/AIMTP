"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  canonicalizeEnvelopeForSigning,
  createSignatureTrustConfig,
  evaluateEnvelopeSignaturePolicy,
  verifyEnvelopeSignature
} = require("../runtime/signature");

function baseEnvelope() {
  return {
    spec: "aimtp/0.1",
    id: "env-sign-001",
    timestamp: "2026-02-06T00:00:00Z",
    sender: "agent-a",
    recipient: "agent-b",
    intent: "task.request",
    message: {
      id: "msg-sign-001",
      role: "user",
      content: { text: "ping", order: ["a", "b"] },
      metadata: { z: 2, a: 1 }
    },
    metadata: { trace_id: "trace-123", flags: { x: true, a: false } }
  };
}

function signEnvelope(envelope, privateKey, alg, kid, extraSignature = {}) {
  const payload = canonicalizeEnvelopeForSigning(envelope);
  const signatureBytes =
    alg === "ed25519"
      ? crypto.sign(null, payload, privateKey)
      : crypto.sign("sha256", payload, privateKey);
  return {
    ...envelope,
    signature: {
      alg,
      kid,
      sig: signatureBytes.toString("base64"),
      ...extraSignature
    }
  };
}

function main() {
  const unordered = {
    recipient: "agent-b",
    sender: "agent-a",
    spec: "aimtp/0.1",
    timestamp: "2026-02-06T00:00:00Z",
    id: "env-sign-001",
    metadata: { flags: { a: false, x: true }, trace_id: "trace-123" },
    message: {
      metadata: { a: 1, z: 2 },
      role: "user",
      id: "msg-sign-001",
      content: { order: ["a", "b"], text: "ping" }
    },
    intent: "task.request",
    signature: {
      alg: "ed25519",
      kid: "other-key",
      sig: "AAAA"
    }
  };
  const canonicalA = canonicalizeEnvelopeForSigning(baseEnvelope()).toString("utf8");
  const canonicalB = canonicalizeEnvelopeForSigning(unordered).toString("utf8");
  assert.strictEqual(canonicalA, canonicalB, "canonical payload must be stable");

  const { publicKey: edPublicKey, privateKey: edPrivateKey } = crypto.generateKeyPairSync("ed25519");
  const edPublicPem = edPublicKey.export({ format: "pem", type: "spki" });
  const edPublicDerBase64 = edPublicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");
  const edKid = "ed-key-1";
  const signedEd = signEnvelope(baseEnvelope(), edPrivateKey, "ed25519", edKid);

  const edVerified = verifyEnvelopeSignature(signedEd, {
    trustedKeys: new Map([[edKid, edPublicPem]]),
    clockSkewSec: 0
  });
  assert.strictEqual(edVerified.ok, true, "ed25519 signature should verify");

  const legacySignedEd = {
    ...baseEnvelope(),
    signature: {
      alg: signedEd.signature.alg,
      key_id: signedEd.signature.kid,
      signature: signedEd.signature.sig
    }
  };
  const legacyVerified = verifyEnvelopeSignature(legacySignedEd, {
    trustedKeys: new Map([[edKid, edPublicPem]]),
    clockSkewSec: 0
  });
  assert.strictEqual(legacyVerified.ok, true, "legacy signature aliases should verify");

  const tampered = {
    ...signedEd,
    message: {
      ...signedEd.message,
      content: { text: "tampered" }
    }
  };
  const edTampered = verifyEnvelopeSignature(tampered, {
    trustedKeys: new Map([[edKid, edPublicPem]]),
    clockSkewSec: 0
  });
  assert.strictEqual(edTampered.ok, false);
  assert.strictEqual(edTampered.code, "signature_verification_failed");

  const { publicKey: secpPublicKey, privateKey: secpPrivateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "secp256k1"
  });
  const secpPublicPem = secpPublicKey.export({ format: "pem", type: "spki" });
  const secpKid = "secp-key-1";
  const signedSecp = signEnvelope(baseEnvelope(), secpPrivateKey, "secp256k1", secpKid);
  const secpVerified = verifyEnvelopeSignature(signedSecp, {
    trustedKeys: new Map([[secpKid, secpPublicPem]]),
    clockSkewSec: 0
  });
  assert.strictEqual(secpVerified.ok, true, "secp256k1 signature should verify");

  const warnDecision = evaluateEnvelopeSignaturePolicy(baseEnvelope(), {
    policy: "warn",
    trustedKeys: new Map(),
    clockSkewSec: 0
  });
  assert.strictEqual(warnDecision.allowed, true);
  assert.strictEqual(warnDecision.warning.code, "signature_required");

  const enforceDecision = evaluateEnvelopeSignaturePolicy(baseEnvelope(), {
    policy: "enforce",
    trustedKeys: new Map(),
    clockSkewSec: 0
  });
  assert.strictEqual(enforceDecision.allowed, false);
  assert.strictEqual(enforceDecision.error.code, "signature_required");

  const offDecision = evaluateEnvelopeSignaturePolicy(baseEnvelope(), {
    policy: "off",
    trustedKeys: new Map(),
    clockSkewSec: 0
  });
  assert.strictEqual(offDecision.allowed, true);

  const nowMs = Date.parse("2026-02-06T00:10:00Z");
  const expiredEnvelope = signEnvelope(baseEnvelope(), edPrivateKey, "ed25519", edKid, {
    created_at: "2026-02-06T00:00:00Z",
    expires_at: "2026-02-06T00:05:00Z"
  });
  const expiredResult = verifyEnvelopeSignature(expiredEnvelope, {
    trustedKeys: new Map([[edKid, edPublicPem]]),
    clockSkewSec: 0,
    nowMs
  });
  assert.strictEqual(expiredResult.ok, false);
  assert.strictEqual(expiredResult.code, "signature_expired");

  const keyFilePath = path.join(
    os.tmpdir(),
    `aimtp-keys-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`
  );
  fs.writeFileSync(keyFilePath, `# trusted keys\n${edKid}=${edPublicDerBase64}\n`, "utf8");
  const config = createSignatureTrustConfig({
    policy: "enforce",
    trustedKeysFile: keyFilePath,
    trustedKeys: "extra-key=Zm9v",
    clockSkewSec: "5"
  });
  assert.strictEqual(config.policy, "enforce");
  assert.strictEqual(config.clockSkewSec, 5);
  assert.strictEqual(config.trustedKeys.has(edKid), true);
  assert.strictEqual(config.trustedKeys.has("extra-key"), true);
  fs.rmSync(keyFilePath, { force: true });

  console.log("OK: signature policy tests");
}

main();
