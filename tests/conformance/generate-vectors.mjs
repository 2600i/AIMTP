#!/usr/bin/env node
//
// Regenerates the committed AIMTP conformance vectors.
//
// Run this ONLY when intentionally changing the normative canonicalization or
// signing rules in spec/aimtp-v0.1.md. The generated vectors are the frozen
// cross-implementation contract; regenerating them without a spec change means
// you have silently broken interoperability with every deployed implementation.
//
//   node tests/conformance/generate-vectors.mjs
//
// Verify with: npm run conformance

import { createHash, createPrivateKey, createPublicKey, sign as signBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const { canonicalizeEnvelopeForSigning } = require(
  path.join(repoRoot, "runtime", "signature.js")
);

const CANON_DIR = path.join(import.meta.dirname, "vectors", "canonicalization");
const SIGN_DIR = path.join(import.meta.dirname, "vectors", "signing");

// A fixed 32-byte ed25519 seed so these vectors are byte-reproducible in any
// language. TEST KEY ONLY -- never use for anything real.
const ED25519_SEED_HEX =
  "61696d74702d636f6e666f726d616e63652d746573742d6b65792d76312d3031";
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function ed25519KeyPairFromSeed(seedHex) {
  const seed = Buffer.from(seedHex, "hex");
  if (seed.length !== 32) {
    throw new Error("ed25519 seed must be 32 bytes");
  }
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8"
  });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// ---------------------------------------------------------------------------
// Canonicalization vectors
//
// Each case pins the exact canonical byte string produced by the rules in
// spec/aimtp-v0.1.md "Canonical Signing Payload". These are deliberately
// adversarial about key order, nesting, unicode, and numeric forms.
// ---------------------------------------------------------------------------
const canonicalizationCases = [
  {
    name: "minimal-envelope",
    description: "Minimal required fields only.",
    envelope: {
      spec: "aimtp/0.1",
      id: "0b74b6f3-2a2f-4a58-9d0f-2c0d82b8d4f2",
      timestamp: "2025-01-01T00:00:00Z",
      message: {
        id: "7f5e2d1c-1f48-4f87-9d2c-2e784684f2b3",
        role: "user",
        content: "Hello from AIMTP"
      }
    }
  },
  {
    name: "key-order-independence",
    description:
      "Top-level and nested keys supplied in reverse order. Canonical output MUST be identical to minimal-envelope.",
    envelope: {
      message: {
        role: "user",
        id: "7f5e2d1c-1f48-4f87-9d2c-2e784684f2b3",
        content: "Hello from AIMTP"
      },
      timestamp: "2025-01-01T00:00:00Z",
      id: "0b74b6f3-2a2f-4a58-9d0f-2c0d82b8d4f2",
      spec: "aimtp/0.1"
    }
  },
  {
    name: "signature-field-excluded",
    description:
      "The top-level signature field MUST be removed before canonicalization. Output MUST equal minimal-envelope.",
    envelope: {
      spec: "aimtp/0.1",
      id: "0b74b6f3-2a2f-4a58-9d0f-2c0d82b8d4f2",
      timestamp: "2025-01-01T00:00:00Z",
      message: {
        id: "7f5e2d1c-1f48-4f87-9d2c-2e784684f2b3",
        role: "user",
        content: "Hello from AIMTP"
      },
      signature: {
        alg: "ed25519",
        kid: "should-be-stripped",
        sig: "AAAA"
      }
    }
  },
  {
    name: "array-order-preserved",
    description: "Array element order MUST NOT be sorted.",
    envelope: {
      spec: "aimtp/0.1",
      id: "arr-1",
      timestamp: "2025-01-01T00:00:00Z",
      message: {
        id: "arr-msg-1",
        role: "assistant",
        content: "see attachments",
        attachments: [
          { name: "z.txt", content_type: "text/plain", size: 3 },
          { name: "a.txt", content_type: "text/plain", size: 1 }
        ]
      },
      actions: [
        { id: "second", type: "notify", inputs: {} },
        { id: "first", type: "invoke", inputs: {} }
      ]
    }
  },
  {
    name: "nested-object-sorting",
    description: "Keys MUST be sorted lexicographically at every level of nesting.",
    envelope: {
      spec: "aimtp/0.1",
      id: "nest-1",
      timestamp: "2025-01-01T00:00:00Z",
      message: { id: "nest-msg-1", role: "tool", content: "nested" },
      metadata: {
        zulu: { yankee: 1, alpha: { charlie: true, bravo: null } },
        alpha: "first"
      }
    }
  },
  {
    name: "unicode-and-escapes",
    description:
      "Non-ASCII content, quotes, backslashes, newlines, and tabs. Output MUST be UTF-8 with standard JSON string escaping.",
    envelope: {
      spec: "aimtp/0.1",
      id: "uni-1",
      timestamp: "2025-01-01T00:00:00Z",
      message: {
        id: "uni-msg-1",
        role: "user",
        content: 'quote:" backslash:\\ newline:\n tab:\t emoji:\u{1F510} cjk:中文'
      },
      metadata: { "key with spaces": "v", "é": "accented" }
    }
  },
  {
    name: "numeric-and-boolean-forms",
    description:
      "Integers, negative numbers, zero, and booleans. Note: JSON has one number type; 1.0 canonicalizes as 1.",
    envelope: {
      spec: "aimtp/0.1",
      id: "num-1",
      timestamp: "2025-01-01T00:00:00Z",
      message: { id: "num-msg-1", role: "user", content: "numbers" },
      metadata: {
        zero: 0,
        negative: -42,
        integral_float: 1.0,
        fractional: 1.5,
        large: 1234567890123,
        yes: true,
        no: false,
        nothing: null
      }
    }
  },
  {
    name: "empty-containers",
    description: "Empty objects and empty arrays MUST be preserved, not dropped.",
    envelope: {
      spec: "aimtp/0.1",
      id: "empty-1",
      timestamp: "2025-01-01T00:00:00Z",
      message: { id: "empty-msg-1", role: "user", content: "empty" },
      metadata: { emptyObject: {}, emptyArray: [], emptyString: "" }
    }
  },
  {
    name: "full-envelope-ai-hooks",
    description: "Envelope exercising intent, actions, capabilities, negotiation, and task.",
    envelope: {
      spec: "aimtp/0.1",
      id: "full-1",
      timestamp: "2025-01-01T00:00:00Z",
      sender: "agent-a",
      recipient: "agent-b",
      intent: { type: "task.request", priority: "high", requires_ack: true, tags: ["b", "a"] },
      actions: [{ id: "a1", type: "invoke", inputs: { tool: "summarize" }, constraints: { max_tokens: 100 } }],
      capabilities: { offered: ["summarize.v1"], required: ["auth.v1"] },
      negotiation: { offer: { price: 10 }, accept: false },
      task: { kind: "request", id: "task-1", type: "summarize.v1", input: { text: "hi" }, expects_response: true },
      message: { id: "full-msg-1", role: "user", content: "do the thing", content_type: "text/plain" },
      metadata: { trace_id: "trace-1" }
    }
  }
];

mkdirSync(CANON_DIR, { recursive: true });
const canonicalOutputs = new Map();

for (const testCase of canonicalizationCases) {
  const canonicalBytes = canonicalizeEnvelopeForSigning(testCase.envelope);
  const canonical = canonicalBytes.toString("utf8");
  canonicalOutputs.set(testCase.name, canonical);

  const vector = {
    name: testCase.name,
    description: testCase.description,
    spec_reference: "spec/aimtp-v0.1.md#canonical-signing-payload",
    envelope: testCase.envelope,
    canonical,
    canonical_sha256: sha256Hex(canonicalBytes),
    canonical_byte_length: canonicalBytes.length
  };
  writeFileSync(
    path.join(CANON_DIR, `${testCase.name}.json`),
    `${JSON.stringify(vector, null, 2)}\n`,
    "utf8"
  );
}

// Cross-check the three cases that MUST collapse to identical canonical bytes.
const mustMatch = ["minimal-envelope", "key-order-independence", "signature-field-excluded"];
const [reference, ...rest] = mustMatch.map((name) => canonicalOutputs.get(name));
for (let index = 0; index < rest.length; index += 1) {
  if (rest[index] !== reference) {
    throw new Error(
      `canonicalization invariant broken: ${mustMatch[index + 1]} != ${mustMatch[0]}`
    );
  }
}

// ---------------------------------------------------------------------------
// Signing vectors
// ---------------------------------------------------------------------------
const { privateKey, publicKey } = ed25519KeyPairFromSeed(ED25519_SEED_HEX);
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const KID = "conformance-ed25519-1";

function signEnvelope(envelope, extraSignatureFields = {}) {
  const payload = canonicalizeEnvelopeForSigning(envelope);
  const sig = signBytes(null, payload, privateKey).toString("base64");
  return {
    ...envelope,
    signature: { alg: "ed25519", kid: KID, sig, ...extraSignatureFields }
  };
}

const baseEnvelope = {
  spec: "aimtp/0.1",
  id: "sign-1",
  timestamp: "2025-01-01T00:00:00Z",
  sender: "agent-a",
  recipient: "agent-b",
  message: { id: "sign-msg-1", role: "user", content: "signed payload" }
};

const signedValid = signEnvelope(baseEnvelope);

// Tampering the content must invalidate the signature.
const signedTampered = JSON.parse(JSON.stringify(signedValid));
signedTampered.message.content = "tampered payload";

// Reordering keys must NOT invalidate the signature (canonicalization is order
// independent). This is the vector that catches naive re-serialization.
const signedReordered = {
  signature: signedValid.signature,
  message: {
    content: signedValid.message.content,
    role: signedValid.message.role,
    id: signedValid.message.id
  },
  recipient: signedValid.recipient,
  sender: signedValid.sender,
  timestamp: signedValid.timestamp,
  id: signedValid.id,
  spec: signedValid.spec
};

// Legacy field aliases key_id / signature must be accepted.
const signedLegacyAlias = {
  ...baseEnvelope,
  signature: {
    alg: "ed25519",
    key_id: KID,
    signature: signedValid.signature.sig
  }
};

const signingCases = [
  {
    name: "valid-ed25519",
    description: "Correctly signed envelope MUST verify.",
    envelope: signedValid,
    expect: "verify"
  },
  {
    name: "key-order-reordered-still-valid",
    description:
      "Same envelope with all keys reordered MUST still verify, because canonicalization sorts keys.",
    envelope: signedReordered,
    expect: "verify"
  },
  {
    name: "legacy-alias-fields",
    description:
      "Backward-compatible aliases key_id (for kid) and signature (for sig) MUST be accepted.",
    envelope: signedLegacyAlias,
    expect: "verify"
  },
  {
    name: "tampered-content",
    description: "Mutating any signed field MUST fail verification.",
    envelope: signedTampered,
    expect: "reject",
    expect_code: "signature_verification_failed"
  },
  {
    name: "untrusted-kid",
    description: "A kid absent from the trust store MUST be rejected before crypto runs.",
    envelope: signEnvelope(baseEnvelope, { kid: "not-in-trust-store" }),
    expect: "reject",
    expect_code: "signature_untrusted_key"
  },
  {
    name: "unsupported-alg",
    description: "An unrecognized alg MUST be rejected.",
    envelope: { ...signedValid, signature: { ...signedValid.signature, alg: "rsa-pss" } },
    expect: "reject",
    expect_code: "signature_unsupported_alg"
  },
  {
    name: "expired-signature",
    description: "expires_at in the past MUST be rejected when evaluated at verify_at.",
    envelope: signEnvelope(baseEnvelope, { expires_at: "2025-01-01T00:00:00Z" }),
    expect: "reject",
    expect_code: "signature_expired",
    verify_at: "2026-01-01T00:00:00Z"
  },
  {
    name: "not-yet-valid-signature",
    description: "created_at in the future MUST be rejected when evaluated at verify_at.",
    envelope: signEnvelope(baseEnvelope, { created_at: "2030-01-01T00:00:00Z" }),
    expect: "reject",
    expect_code: "signature_not_yet_valid",
    verify_at: "2026-01-01T00:00:00Z"
  }
];

mkdirSync(SIGN_DIR, { recursive: true });
for (const testCase of signingCases) {
  const vector = {
    name: testCase.name,
    description: testCase.description,
    spec_reference: "spec/aimtp-v0.1.md#security",
    alg: "ed25519",
    kid: KID,
    public_key_pem: publicKeyPem,
    ed25519_seed_hex: ED25519_SEED_HEX,
    trusted_keys: { [KID]: publicKeyPem },
    envelope: testCase.envelope,
    expect: testCase.expect,
    ...(testCase.expect_code ? { expect_code: testCase.expect_code } : {}),
    ...(testCase.verify_at ? { verify_at: testCase.verify_at } : {})
  };
  writeFileSync(
    path.join(SIGN_DIR, `${testCase.name}.json`),
    `${JSON.stringify(vector, null, 2)}\n`,
    "utf8"
  );
}

console.log(
  `Generated ${canonicalizationCases.length} canonicalization and ${signingCases.length} signing vectors.`
);
