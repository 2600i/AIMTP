"use strict";

const crypto = require("crypto");
const fs = require("fs");

const RFC3339_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const POLICY_VALUES = new Set(["off", "warn", "enforce"]);
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parsePolicy(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (POLICY_VALUES.has(normalized)) {
    return normalized;
  }
  return "off";
}

function parseNonNegativeInt(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value !== "string" || value.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function parseTrustedKeysEntries(value) {
  const entries = [];
  if (typeof value !== "string") {
    return entries;
  }
  value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .forEach((part) => {
      const separator = part.indexOf("=");
      if (separator <= 0 || separator === part.length - 1) {
        return;
      }
      const kid = part.slice(0, separator).trim();
      const key = part.slice(separator + 1).trim();
      if (!kid || !key) {
        return;
      }
      entries.push([kid, key]);
    });
  return entries;
}

function parseTrustedKeysFile(filePath) {
  const entries = [];
  if (typeof filePath !== "string" || filePath.trim() === "") {
    return entries;
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const trimmed = raw.trim();
  if (!trimmed) {
    return entries;
  }

  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    if (isPlainObject(parsed)) {
      Object.keys(parsed).forEach((kid) => {
        const key = parsed[kid];
        if (typeof key === "string" && kid.trim() && key.trim()) {
          entries.push([kid.trim(), key.trim()]);
        }
      });
    }
    return entries;
  }

  trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .forEach((line) => {
      const separator = line.indexOf("=");
      if (separator <= 0 || separator === line.length - 1) {
        return;
      }
      const kid = line.slice(0, separator).trim();
      const key = line.slice(separator + 1).trim();
      if (!kid || !key) {
        return;
      }
      entries.push([kid, key]);
    });

  return entries;
}

function createSignatureTrustConfig(options = {}) {
  const policy = parsePolicy(
    options.policy !== undefined ? options.policy : process.env.AIMTP_SIGNATURE_POLICY
  );
  const clockSkewSec = parseNonNegativeInt(
    options.clockSkewSec !== undefined
      ? options.clockSkewSec
      : process.env.AIMTP_SIGNATURE_CLOCK_SKEW_SEC,
    0
  );
  const trustedKeysRaw =
    options.trustedKeys !== undefined ? options.trustedKeys : process.env.AIMTP_TRUSTED_KEYS;
  const trustedKeysFile =
    options.trustedKeysFile !== undefined
      ? options.trustedKeysFile
      : process.env.AIMTP_TRUSTED_KEYS_FILE;
  const trustedKeys = new Map();

  try {
    parseTrustedKeysFile(trustedKeysFile).forEach(([kid, key]) => {
      trustedKeys.set(kid, key);
    });
  } catch (err) {
    const logger = options.logger || null;
    if (logger && typeof logger.log === "function") {
      const message = err instanceof Error ? err.message : String(err);
      logger.log(`signature_trusted_keys_file_error message=${message}`);
    }
  }
  parseTrustedKeysEntries(trustedKeysRaw).forEach(([kid, key]) => {
    trustedKeys.set(kid, key);
  });

  return {
    policy,
    clockSkewSec,
    trustedKeys
  };
}

function canonicalizeJson(value) {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("non_finite_number");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeJson(entry)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`);
    return `{${parts.join(",")}}`;
  }
  throw new Error(`unsupported_value_type:${typeof value}`);
}

function canonicalizeEnvelopeForSigning(envelope) {
  if (!isPlainObject(envelope)) {
    throw new Error("envelope_must_be_object");
  }
  const payload = {};
  Object.keys(envelope).forEach((key) => {
    if (key === "signature") {
      return;
    }
    const value = envelope[key];
    if (value !== undefined) {
      payload[key] = value;
    }
  });
  return Buffer.from(canonicalizeJson(payload), "utf8");
}

function normalizeSignature(signature) {
  if (!isPlainObject(signature)) {
    return null;
  }
  const kidRaw =
    typeof signature.kid === "string" && signature.kid.trim()
      ? signature.kid
      : typeof signature.key_id === "string" && signature.key_id.trim()
        ? signature.key_id
        : "";
  const sigRaw =
    typeof signature.sig === "string" && signature.sig.trim()
      ? signature.sig
      : typeof signature.signature === "string" && signature.signature.trim()
        ? signature.signature
        : "";
  const alg = typeof signature.alg === "string" ? signature.alg.trim().toLowerCase() : "";
  const createdAt =
    typeof signature.created_at === "string" && signature.created_at.trim()
      ? signature.created_at.trim()
      : "";
  const expiresAt =
    typeof signature.expires_at === "string" && signature.expires_at.trim()
      ? signature.expires_at.trim()
      : "";
  return {
    kid: kidRaw.trim(),
    sig: sigRaw.trim(),
    alg,
    createdAt,
    expiresAt
  };
}

function parseDateTime(value) {
  if (!value) {
    return null;
  }
  if (!RFC3339_REGEX.test(value)) {
    return Number.NaN;
  }
  const millis = Date.parse(value);
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

function loadPublicKey(alg, trustedValue) {
  if (typeof trustedValue !== "string" || !trustedValue.trim()) {
    throw new Error("trusted_key_missing");
  }
  const trimmed = trustedValue.trim();
  if (trimmed.startsWith("-----BEGIN")) {
    return crypto.createPublicKey(trimmed);
  }

  const decoded = decodeKeyMaterial(trimmed);
  if (!decoded || decoded.length === 0) {
    throw new Error("trusted_key_decode_failed");
  }

  if (alg === "ed25519" && decoded.length === 32) {
    return crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, decoded]),
      format: "der",
      type: "spki"
    });
  }

  return crypto.createPublicKey({
    key: decoded,
    format: "der",
    type: "spki"
  });
}

function verifyBytesByAlgorithm(alg, payload, publicKey, signatureBytes) {
  if (alg === "ed25519") {
    return crypto.verify(null, payload, publicKey, signatureBytes);
  }
  if (alg === "secp256k1") {
    if (crypto.verify("sha256", payload, publicKey, signatureBytes)) {
      return true;
    }
    if (signatureBytes.length === 64) {
      return crypto.verify("sha256", payload, { key: publicKey, dsaEncoding: "ieee-p1363" }, signatureBytes);
    }
    return false;
  }
  return false;
}

function verificationError(httpStatus, code, message, details) {
  const result = { ok: false, httpStatus, code, message };
  if (details !== undefined) {
    result.details = details;
  }
  return result;
}

function verifyEnvelopeSignature(envelope, config) {
  if (!isPlainObject(envelope)) {
    return verificationError(400, "signature_invalid", "Envelope must be an object");
  }

  const signature = normalizeSignature(envelope.signature);
  if (!signature) {
    return verificationError(401, "signature_required", "Signature is required by policy");
  }
  if (!signature.kid) {
    return verificationError(400, "signature_invalid", "Signature kid is required");
  }
  if (!signature.sig) {
    return verificationError(400, "signature_invalid", "Signature sig is required");
  }
  if (!signature.alg) {
    return verificationError(400, "signature_invalid", "Signature alg is required");
  }
  if (signature.alg !== "ed25519" && signature.alg !== "secp256k1") {
    return verificationError(400, "signature_unsupported_alg", "Unsupported signature algorithm", {
      alg: signature.alg
    });
  }

  const trustedKeys = config && config.trustedKeys instanceof Map ? config.trustedKeys : new Map();
  const trustedKey = trustedKeys.get(signature.kid);
  if (!trustedKey) {
    return verificationError(403, "signature_untrusted_key", "Signature kid is not trusted", {
      kid: signature.kid
    });
  }

  const signatureBytes = decodeBase64(signature.sig);
  if (!signatureBytes || signatureBytes.length === 0) {
    return verificationError(400, "signature_invalid", "Signature sig must be base64");
  }

  const skewMs = Math.max(
    0,
    Number.isFinite(config && config.clockSkewSec)
      ? Math.floor(config.clockSkewSec * 1000)
      : 0
  );
  const nowMs = Number.isFinite(config && config.nowMs) ? Math.floor(config.nowMs) : Date.now();
  const createdAtMs = parseDateTime(signature.createdAt);
  const expiresAtMs = parseDateTime(signature.expiresAt);
  if (Number.isNaN(createdAtMs)) {
    return verificationError(400, "signature_invalid", "signature.created_at must be RFC3339");
  }
  if (Number.isNaN(expiresAtMs)) {
    return verificationError(400, "signature_invalid", "signature.expires_at must be RFC3339");
  }
  if (createdAtMs !== null && nowMs + skewMs < createdAtMs) {
    return verificationError(401, "signature_not_yet_valid", "Signature is not yet valid", {
      created_at: signature.createdAt
    });
  }
  if (expiresAtMs !== null && nowMs - skewMs > expiresAtMs) {
    return verificationError(401, "signature_expired", "Signature has expired", {
      expires_at: signature.expiresAt
    });
  }

  let payload;
  try {
    payload = canonicalizeEnvelopeForSigning(envelope);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return verificationError(400, "signature_invalid", "Canonicalization failed", { reason });
  }

  let publicKey;
  try {
    publicKey = loadPublicKey(signature.alg, trustedKey);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return verificationError(500, "signature_key_error", "Trusted key could not be loaded", {
      kid: signature.kid,
      reason
    });
  }

  let verified = false;
  try {
    verified = verifyBytesByAlgorithm(signature.alg, payload, publicKey, signatureBytes);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return verificationError(400, "signature_invalid", "Signature verification failed", { reason });
  }

  if (!verified) {
    return verificationError(403, "signature_verification_failed", "Signature verification failed", {
      kid: signature.kid,
      alg: signature.alg
    });
  }

  return {
    ok: true,
    code: "signature_verified",
    message: "Signature verified",
    details: {
      kid: signature.kid,
      alg: signature.alg
    }
  };
}

function evaluateEnvelopeSignaturePolicy(envelope, config) {
  const policy = config && typeof config.policy === "string" ? config.policy : "off";
  if (policy === "off") {
    return { allowed: true };
  }

  const result = verifyEnvelopeSignature(envelope, config);
  if (result.ok) {
    return { allowed: true };
  }
  if (policy === "warn") {
    return { allowed: true, warning: result };
  }
  return { allowed: false, error: result };
}

module.exports = {
  canonicalizeJson,
  canonicalizeEnvelopeForSigning,
  createSignatureTrustConfig,
  evaluateEnvelopeSignaturePolicy,
  parsePolicy,
  verifyEnvelopeSignature
};
