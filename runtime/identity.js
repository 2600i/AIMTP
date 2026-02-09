"use strict";

const crypto = require("crypto");
const { stableJsonStringify } = require("./federation");

const RFC3339_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const IDENTITY_ROLES = new Set(["relay", "agent", "service"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseDateTime(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const trimmed = value.trim();
  if (!RFC3339_REGEX.test(trimmed)) {
    return Number.NaN;
  }
  const millis = Date.parse(trimmed);
  if (!Number.isFinite(millis)) {
    return Number.NaN;
  }
  return millis;
}

function decodeBase64(value) {
  if (typeof value !== "string" || !value || !BASE64_REGEX.test(value)) {
    return null;
  }
  try {
    return Buffer.from(value, "base64");
  } catch (_err) {
    return null;
  }
}

function decodeKeyMaterial(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const hexCandidate = trimmed.replace(/^0x/i, "");
  if (
    hexCandidate.length > 0 &&
    hexCandidate.length % 2 === 0 &&
    /^[a-fA-F0-9]+$/.test(hexCandidate)
  ) {
    return Buffer.from(hexCandidate, "hex");
  }
  if (!BASE64_REGEX.test(trimmed)) {
    return null;
  }
  try {
    return Buffer.from(trimmed, "base64");
  } catch (_err) {
    return null;
  }
}

function loadPublicKey(alg, value) {
  if (alg !== "ed25519") {
    throw new Error("identity_alg_unsupported");
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("identity_public_key_missing");
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("-----BEGIN")) {
    return crypto.createPublicKey(trimmed);
  }
  const decoded = decodeKeyMaterial(trimmed);
  if (!decoded || decoded.length === 0) {
    throw new Error("identity_public_key_decode_failed");
  }
  if (decoded.length === 32) {
    return crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, decoded]),
      format: "der",
      type: "spki"
    });
  }
  return crypto.createPublicKey({ key: decoded, format: "der", type: "spki" });
}

function loadPrivateKey(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("identity_private_key_missing");
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("-----BEGIN")) {
    return crypto.createPrivateKey(trimmed);
  }
  const decoded = decodeKeyMaterial(trimmed);
  if (!decoded || decoded.length === 0) {
    throw new Error("identity_private_key_decode_failed");
  }
  return crypto.createPrivateKey({
    key: decoded,
    format: "der",
    type: "pkcs8"
  });
}

function canonicalizePayloadForProof(value) {
  if (!isPlainObject(value)) {
    throw new Error("identity_payload_must_be_object");
  }
  const payload = {};
  Object.keys(value).forEach((key) => {
    if (key === "proof") {
      return;
    }
    if (value[key] !== undefined) {
      payload[key] = value[key];
    }
  });
  return Buffer.from(stableJsonStringify(payload), "utf8");
}

function parseClockSkewSec(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function verifyResult(ok, code, message, details) {
  const result = { ok, code, message };
  if (details !== undefined) {
    result.details = details;
  }
  return result;
}

function validateIdentityDocument(identity, nowMs, clockSkewSec) {
  if (!isPlainObject(identity)) {
    return verifyResult(false, "identity_invalid", "identity must be an object");
  }
  if (typeof identity.id !== "string" || !identity.id.trim()) {
    return verifyResult(false, "identity_invalid", "identity.id must be a non-empty string");
  }
  if (typeof identity.role !== "string" || !IDENTITY_ROLES.has(identity.role)) {
    return verifyResult(false, "identity_invalid", "identity.role is invalid");
  }
  if (!Array.isArray(identity.keys) || identity.keys.length === 0) {
    return verifyResult(false, "identity_invalid", "identity.keys must be a non-empty array");
  }

  const seen = new Set();
  for (const key of identity.keys) {
    if (!isPlainObject(key)) {
      return verifyResult(false, "identity_invalid", "identity key entry must be an object");
    }
    if (typeof key.kid !== "string" || !key.kid.trim()) {
      return verifyResult(false, "identity_invalid", "identity key kid is required");
    }
    if (seen.has(key.kid)) {
      return verifyResult(false, "identity_invalid", "identity key kid must be unique", {
        kid: key.kid
      });
    }
    seen.add(key.kid);
    if (key.alg !== "ed25519") {
      return verifyResult(false, "identity_alg_unsupported", "identity key alg is unsupported", {
        kid: key.kid,
        alg: key.alg
      });
    }
    if (typeof key.public_key !== "string" || !key.public_key.trim()) {
      return verifyResult(false, "identity_invalid", "identity key public_key is required", {
        kid: key.kid
      });
    }
  }

  const skewMs = Math.max(0, clockSkewSec * 1000);
  const issuedAtMs = parseDateTime(identity.issued_at);
  const expiresAtMs = parseDateTime(identity.expires_at);
  if (Number.isNaN(issuedAtMs)) {
    return verifyResult(false, "identity_invalid", "identity.issued_at must be RFC3339");
  }
  if (Number.isNaN(expiresAtMs)) {
    return verifyResult(false, "identity_invalid", "identity.expires_at must be RFC3339");
  }
  if (issuedAtMs !== null && nowMs + skewMs < issuedAtMs) {
    return verifyResult(false, "identity_not_yet_valid", "identity is not yet valid");
  }
  if (expiresAtMs !== null && nowMs - skewMs > expiresAtMs) {
    return verifyResult(false, "identity_expired", "identity has expired");
  }

  return verifyResult(true, "identity_valid", "identity document is valid");
}

function resolveProofKey(identity, proof) {
  if (!Array.isArray(identity.keys)) {
    return null;
  }
  return identity.keys.find(
    (entry) => isPlainObject(entry) && typeof entry.kid === "string" && entry.kid === proof.kid
  ) || null;
}

class LocalEd25519ProofVerifier {
  verify(payload, proof, key) {
    if (proof.alg !== "ed25519") {
      return false;
    }
    const signatureBytes = decodeBase64(proof.sig);
    if (!signatureBytes || signatureBytes.length === 0) {
      return false;
    }
    const publicKey = loadPublicKey(key.alg, key.public_key);
    return crypto.verify(null, payload, publicKey, signatureBytes);
  }
}

function verifyProofForPayload(payloadObject, identity, proof, options = {}) {
  const clockSkewSec = parseClockSkewSec(options.clockSkewSec, 0);
  const nowMs = Number.isFinite(options.nowMs) ? Math.floor(options.nowMs) : Date.now();
  const verifier = options.verifier || new LocalEd25519ProofVerifier();

  if (!isPlainObject(proof)) {
    return verifyResult(false, "identity_proof_missing", "proof is required");
  }
  if (proof.alg !== "ed25519") {
    return verifyResult(false, "identity_proof_alg_unsupported", "proof alg is unsupported", {
      alg: proof.alg
    });
  }
  if (typeof proof.kid !== "string" || !proof.kid.trim()) {
    return verifyResult(false, "identity_proof_invalid", "proof.kid is required");
  }
  if (typeof proof.sig !== "string" || !proof.sig.trim()) {
    return verifyResult(false, "identity_proof_invalid", "proof.sig is required");
  }

  const createdAtMs = parseDateTime(proof.created_at);
  const expiresAtMs = parseDateTime(proof.expires_at);
  if (Number.isNaN(createdAtMs)) {
    return verifyResult(false, "identity_proof_invalid", "proof.created_at must be RFC3339");
  }
  if (Number.isNaN(expiresAtMs)) {
    return verifyResult(false, "identity_proof_invalid", "proof.expires_at must be RFC3339");
  }
  const skewMs = Math.max(0, clockSkewSec * 1000);
  if (createdAtMs !== null && nowMs + skewMs < createdAtMs) {
    return verifyResult(false, "identity_proof_not_yet_valid", "proof is not yet valid");
  }
  if (expiresAtMs !== null && nowMs - skewMs > expiresAtMs) {
    return verifyResult(false, "identity_proof_expired", "proof has expired");
  }

  const key = resolveProofKey(identity, proof);
  if (!key) {
    return verifyResult(false, "identity_proof_kid_unknown", "proof.kid not found in identity", {
      kid: proof.kid
    });
  }

  let payload;
  try {
    payload = canonicalizePayloadForProof(payloadObject);
  } catch (err) {
    return verifyResult(false, "identity_payload_invalid", "payload canonicalization failed", {
      reason: err instanceof Error ? err.message : String(err)
    });
  }

  let verified = false;
  try {
    verified = verifier.verify(payload, proof, key);
  } catch (err) {
    return verifyResult(false, "identity_proof_invalid", "proof verification failed", {
      reason: err instanceof Error ? err.message : String(err)
    });
  }

  if (!verified) {
    return verifyResult(false, "identity_proof_verification_failed", "proof verification failed", {
      kid: proof.kid
    });
  }

  return verifyResult(true, "identity_proof_verified", "identity proof verified", {
    kid: proof.kid
  });
}

function createIdentityVerifier(options = {}) {
  const verifier = options.verifier || new LocalEd25519ProofVerifier();
  const clockSkewSec = parseClockSkewSec(options.clockSkewSec, 0);

  function verifyIdentityDocument(identity, runtimeOptions = {}) {
    const nowMs = Number.isFinite(runtimeOptions.nowMs)
      ? Math.floor(runtimeOptions.nowMs)
      : Date.now();
    return validateIdentityDocument(identity, nowMs, clockSkewSec);
  }

  function verifyEnvelopeIdentity(envelope, runtimeOptions = {}) {
    if (!isPlainObject(envelope)) {
      return verifyResult(false, "identity_payload_invalid", "envelope must be an object");
    }

    const identity = envelope.identity;
    const proof = envelope.proof;
    const hasIdentity = isPlainObject(identity);
    const hasProof = isPlainObject(proof);

    if (!hasIdentity && !hasProof) {
      return verifyResult(true, "identity_not_present", "identity/proof not present");
    }
    if (hasIdentity && !hasProof) {
      return verifyResult(false, "identity_proof_missing", "proof is required when identity is present");
    }
    if (!hasIdentity && hasProof) {
      return verifyResult(false, "identity_missing", "identity is required when proof is present");
    }

    const nowMs = Number.isFinite(runtimeOptions.nowMs)
      ? Math.floor(runtimeOptions.nowMs)
      : Date.now();
    const identityResult = validateIdentityDocument(identity, nowMs, clockSkewSec);
    if (!identityResult.ok) {
      return identityResult;
    }

    return verifyProofForPayload(envelope, identity, proof, {
      verifier,
      nowMs,
      clockSkewSec
    });
  }

  return {
    verifyEnvelopeIdentity,
    verifyIdentityDocument
  };
}

function createProof(payloadObject, privateKeyValue, options = {}) {
  if (!isPlainObject(payloadObject)) {
    throw new Error("identity_payload_must_be_object");
  }
  if (typeof options.kid !== "string" || !options.kid.trim()) {
    throw new Error("identity_proof_kid_required");
  }

  const proof = {
    type: typeof options.type === "string" && options.type.trim() ? options.type.trim() : "aimtp.ed25519",
    alg: "ed25519",
    kid: options.kid.trim(),
    created_at:
      typeof options.createdAt === "string" && options.createdAt.trim()
        ? options.createdAt.trim()
        : new Date().toISOString()
  };
  if (typeof options.expiresAt === "string" && options.expiresAt.trim()) {
    proof.expires_at = options.expiresAt.trim();
  }

  const payload = canonicalizePayloadForProof(payloadObject);
  const privateKey = loadPrivateKey(privateKeyValue);
  const signature = crypto.sign(null, payload, privateKey);
  proof.sig = signature.toString("base64");
  return proof;
}

function signIdentityDocument(identity, privateKeyValue, options = {}) {
  return createProof(identity, privateKeyValue, options);
}

module.exports = {
  LocalEd25519ProofVerifier,
  createIdentityVerifier,
  createProof,
  signIdentityDocument,
  verifyProofForPayload
};
