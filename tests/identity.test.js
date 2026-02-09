"use strict";

const assert = require("assert");
const crypto = require("crypto");
const {
  createIdentityVerifier,
  createProof,
  signIdentityDocument,
  verifyProofForPayload
} = require("../runtime/identity");

function keyMaterial() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
  };
}

function makeIdentity(keys, expiresAt) {
  return {
    id: "did:aimtp:agent-a",
    role: "agent",
    keys: [
      {
        kid: "did:aimtp:agent-a#k1",
        alg: "ed25519",
        public_key: keys.publicKey,
        purposes: ["assertion"]
      }
    ],
    issued_at: "2026-02-09T00:00:00Z",
    expires_at: expiresAt || "2027-02-09T00:00:00Z"
  };
}

function main() {
  const keys = keyMaterial();
  const identity = makeIdentity(keys);

  const payloadA = {
    id: "payload-1",
    intent: "task.request",
    identity,
    metadata: {
      b: 2,
      a: 1,
      nested: { z: 9, m: 3 }
    }
  };
  const payloadB = {
    metadata: {
      nested: { m: 3, z: 9 },
      a: 1,
      b: 2
    },
    identity: {
      expires_at: identity.expires_at,
      issued_at: identity.issued_at,
      keys: [
        {
          purposes: ["assertion"],
          public_key: identity.keys[0].public_key,
          alg: identity.keys[0].alg,
          kid: identity.keys[0].kid
        }
      ],
      role: identity.role,
      id: identity.id
    },
    intent: "task.request",
    id: "payload-1"
  };

  const stableProof = createProof(payloadA, keys.privateKey, {
    kid: identity.keys[0].kid,
    createdAt: "2026-02-09T00:00:00Z",
    expiresAt: "2026-02-09T01:00:00Z"
  });
  const stableVerify = verifyProofForPayload(payloadB, identity, stableProof, {
    nowMs: Date.parse("2026-02-09T00:10:00Z")
  });
  assert.strictEqual(stableVerify.ok, true, "canonicalization must be stable");

  const docProof = signIdentityDocument(identity, keys.privateKey, {
    kid: identity.keys[0].kid,
    createdAt: "2026-02-09T00:00:00Z",
    expiresAt: "2026-02-09T01:00:00Z"
  });
  const docVerify = verifyProofForPayload(identity, identity, docProof, {
    nowMs: Date.parse("2026-02-09T00:10:00Z")
  });
  assert.strictEqual(docVerify.ok, true, "identity document proof should verify");

  const verifier = createIdentityVerifier({ clockSkewSec: 0 });
  const envelope = {
    spec: "aimtp/0.1",
    id: "env-identity-001",
    timestamp: "2026-02-09T00:00:00Z",
    sender: "agent-a",
    recipient: "agent-b",
    intent: "task.request",
    message: {
      id: "msg-identity-001",
      role: "user",
      content: "hello"
    },
    identity
  };
  envelope.proof = createProof(envelope, keys.privateKey, {
    kid: identity.keys[0].kid,
    createdAt: "2026-02-09T00:00:00Z",
    expiresAt: "2026-02-09T01:00:00Z"
  });

  const envelopeVerify = verifier.verifyEnvelopeIdentity(envelope, {
    nowMs: Date.parse("2026-02-09T00:05:00Z")
  });
  assert.strictEqual(envelopeVerify.ok, true, "envelope proof should verify against identity key");

  const expiredIdentity = makeIdentity(keys, "2026-02-08T00:00:00Z");
  const expiredEnvelope = {
    ...envelope,
    identity: expiredIdentity
  };
  expiredEnvelope.proof = createProof(expiredEnvelope, keys.privateKey, {
    kid: expiredIdentity.keys[0].kid,
    createdAt: "2026-02-09T00:00:00Z",
    expiresAt: "2026-02-09T01:00:00Z"
  });

  const expiredVerify = verifier.verifyEnvelopeIdentity(expiredEnvelope, {
    nowMs: Date.parse("2026-02-09T00:05:00Z")
  });
  assert.strictEqual(expiredVerify.ok, false);
  assert.strictEqual(expiredVerify.code, "identity_expired");

  console.log("OK: identity tests");
}

main();
