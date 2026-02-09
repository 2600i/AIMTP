"use strict";

const crypto = require("crypto");
const fs = require("fs");

const RFC3339_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const DEFAULT_TRUSTED_RELAYS_PATH = "./config/trusted_relays.json";
const DEFAULT_DESCRIPTOR_TTL_SEC = 3600;
const DEFAULT_CLOCK_SKEW_SEC = 30;
const DEFAULT_FORWARD_TIMEOUT_MS = 5000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableJsonStringify(value) {
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
    return `[${value.map((entry) => stableJsonStringify(entry)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`);
    return `{${parts.join(",")}}`;
  }
  throw new Error(`unsupported_value_type:${typeof value}`);
}

function canonicalizeForSigning(value) {
  if (!isPlainObject(value)) {
    throw new Error("object_required");
  }
  const payload = {};
  Object.keys(value).forEach((key) => {
    if (key === "signature") {
      return;
    }
    if (value[key] !== undefined) {
      payload[key] = value[key];
    }
  });
  return Buffer.from(stableJsonStringify(payload), "utf8");
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function normalizeEndpoint(value) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const url = new URL(trimmed);
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    return `${url.protocol}//${url.host}${path}`;
  } catch (_err) {
    return "";
  }
}

function endpointHostname(value) {
  if (typeof value !== "string") {
    return "";
  }
  try {
    return new URL(value).hostname.toLowerCase();
  } catch (_err) {
    return "";
  }
}

function parseBooleanOnOff(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "on") {
    return true;
  }
  if (normalized === "off") {
    return false;
  }
  return fallback;
}

function parseTrustPolicyMode(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "off") {
    return "off";
  }
  if (normalized === "explicit") {
    return "explicit";
  }
  return fallback;
}

function parseRfc3339(value) {
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
  if (typeof value !== "string" || !BASE64_REGEX.test(value)) {
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

function loadEd25519PublicKey(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("public_key_missing");
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("-----BEGIN")) {
    return crypto.createPublicKey(trimmed);
  }
  const decoded = decodeKeyMaterial(trimmed);
  if (!decoded || decoded.length === 0) {
    throw new Error("public_key_decode_failed");
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

function loadEd25519PrivateKey(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("private_key_missing");
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("-----BEGIN")) {
    return crypto.createPrivateKey(trimmed);
  }
  const decoded = decodeKeyMaterial(trimmed);
  if (!decoded || decoded.length === 0) {
    throw new Error("private_key_decode_failed");
  }
  return crypto.createPrivateKey({ key: decoded, format: "der", type: "pkcs8" });
}

function parseLocalDomains(value) {
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

function parseFederationConfig(options = {}) {
  const enabled =
    typeof options.enabled === "boolean"
      ? options.enabled
      : parseBooleanOnOff(process.env.AIMTP_FEDERATION, false);
  const relayIdRaw =
    typeof options.relayId === "string" ? options.relayId : process.env.AIMTP_RELAY_ID;
  const endpointRaw =
    typeof options.relayEndpoint === "string"
      ? options.relayEndpoint
      : process.env.AIMTP_RELAY_ENDPOINT;
  const trustedRelaysPath =
    typeof options.trustedRelaysPath === "string" && options.trustedRelaysPath.trim()
      ? options.trustedRelaysPath.trim()
      : process.env.AIMTP_TRUSTED_RELAYS_PATH && process.env.AIMTP_TRUSTED_RELAYS_PATH.trim()
        ? process.env.AIMTP_TRUSTED_RELAYS_PATH.trim()
        : DEFAULT_TRUSTED_RELAYS_PATH;
  const trustPolicyMode = parseTrustPolicyMode(
    typeof options.trustPolicyMode === "string"
      ? options.trustPolicyMode
      : process.env.AIMTP_TRUST_POLICY_MODE,
    enabled ? "explicit" : "off"
  );
  const descriptorTtlSec =
    typeof options.descriptorTtlSec === "number"
      ? parsePositiveInt(options.descriptorTtlSec, DEFAULT_DESCRIPTOR_TTL_SEC)
      : parsePositiveInt(process.env.AIMTP_RELAY_DESCRIPTOR_TTL_SEC, DEFAULT_DESCRIPTOR_TTL_SEC);
  const clockSkewSec =
    typeof options.clockSkewSec === "number"
      ? parseNonNegativeInt(options.clockSkewSec, DEFAULT_CLOCK_SKEW_SEC)
      : parseNonNegativeInt(process.env.AIMTP_FEDERATION_CLOCK_SKEW_SEC, DEFAULT_CLOCK_SKEW_SEC);
  const forwardTimeoutMs =
    typeof options.forwardTimeoutMs === "number"
      ? parsePositiveInt(options.forwardTimeoutMs, DEFAULT_FORWARD_TIMEOUT_MS)
      : parsePositiveInt(process.env.AIMTP_FEDERATION_TIMEOUT_MS, DEFAULT_FORWARD_TIMEOUT_MS);
  const localDomains =
    Array.isArray(options.localDomains) && options.localDomains.length > 0
      ? options.localDomains.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
      : parseLocalDomains(process.env.AIMTP_LOCAL_DOMAINS);
  const relayPublicKey =
    typeof options.relayPublicKey === "string"
      ? options.relayPublicKey.trim()
      : process.env.AIMTP_RELAY_PUBLIC_KEY
        ? process.env.AIMTP_RELAY_PUBLIC_KEY.trim()
        : "";
  const relayPrivateKey =
    typeof options.relayPrivateKey === "string"
      ? options.relayPrivateKey.trim()
      : process.env.AIMTP_RELAY_PRIVATE_KEY
        ? process.env.AIMTP_RELAY_PRIVATE_KEY.trim()
        : "";
  const allowHttpEndpoints = options.allowHttpEndpoints === true;
  const errors = [];

  const relayId = typeof relayIdRaw === "string" ? relayIdRaw.trim() : "";
  const relayEndpoint = normalizeEndpoint(endpointRaw);
  if (enabled) {
    if (!relayId) {
      errors.push("AIMTP_RELAY_ID is required when federation is on");
    }
    if (!relayEndpoint) {
      errors.push("AIMTP_RELAY_ENDPOINT is required when federation is on");
    }
    if (relayEndpoint && !allowHttpEndpoints) {
      try {
        const protocol = new URL(relayEndpoint).protocol;
        if (protocol !== "https:") {
          errors.push("AIMTP_RELAY_ENDPOINT must use https when federation is on");
        }
      } catch (_err) {
        errors.push("AIMTP_RELAY_ENDPOINT must be a valid URL");
      }
    }
    if (!relayPublicKey) {
      errors.push("AIMTP_RELAY_PUBLIC_KEY is required when federation is on");
    }
    if (!relayPrivateKey) {
      errors.push("AIMTP_RELAY_PRIVATE_KEY is required when federation is on");
    }
  }

  return {
    enabled,
    trustPolicyMode,
    relayId,
    relayEndpoint,
    trustedRelaysPath,
    descriptorTtlSec,
    clockSkewSec,
    forwardTimeoutMs,
    localDomains,
    relayPublicKey,
    relayPrivateKey,
    allowHttpEndpoints,
    errors
  };
}

function normalizeTrustedRelayEntry(input, options = {}) {
  if (!isPlainObject(input)) {
    throw new Error("trusted_relay_entry_invalid");
  }
  const relayId = typeof input.relay_id === "string" ? input.relay_id.trim() : "";
  const endpoint = normalizeEndpoint(input.endpoint);
  const publicKey = typeof input.public_key === "string" ? input.public_key.trim() : "";
  const alg = typeof input.alg === "string" ? input.alg.trim().toLowerCase() : "";
  const expiresAt =
    typeof input.expires_at === "string" && input.expires_at.trim()
      ? input.expires_at.trim()
      : undefined;

  if (!relayId) {
    throw new Error("trusted_relay_id_required");
  }
  if (!endpoint) {
    throw new Error("trusted_relay_endpoint_required");
  }
  if (!options.allowHttpEndpoints) {
    const protocol = new URL(endpoint).protocol;
    if (protocol !== "https:") {
      throw new Error("trusted_relay_endpoint_must_be_https");
    }
  }
  if (!publicKey) {
    throw new Error("trusted_relay_public_key_required");
  }
  if (!alg) {
    throw new Error("trusted_relay_alg_required");
  }
  if (alg !== "ed25519") {
    throw new Error("trusted_relay_alg_unsupported");
  }
  if (expiresAt) {
    const parsed = parseRfc3339(expiresAt);
    if (!Number.isFinite(parsed)) {
      throw new Error("trusted_relay_expires_at_invalid");
    }
  }

  return {
    relay_id: relayId,
    endpoint,
    public_key: publicKey,
    alg,
    expires_at: expiresAt
  };
}

function loadTrustPolicy(filePath, options = {}) {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!isPlainObject(parsed)) {
    throw new Error("trust_policy_invalid");
  }

  const trustedRelays = new Map();
  const trustedList = Array.isArray(parsed.trusted_relays) ? parsed.trusted_relays : [];
  trustedList.forEach((entry) => {
    const normalized = normalizeTrustedRelayEntry(entry, options);
    trustedRelays.set(normalized.relay_id, normalized);
  });

  const domains = {};
  if (isPlainObject(parsed.domains)) {
    Object.keys(parsed.domains).forEach((domain) => {
      const relayId = parsed.domains[domain];
      if (typeof relayId !== "string" || !relayId.trim()) {
        return;
      }
      domains[domain.trim().toLowerCase()] = relayId.trim();
    });
  }

  return {
    trustedRelays,
    domains,
    sourcePath: filePath
  };
}

function isExpired(value, nowMs, skewSec) {
  if (!value) {
    return false;
  }
  const parsed = parseRfc3339(value);
  if (!Number.isFinite(parsed)) {
    return true;
  }
  const skewMs = Math.max(0, Math.floor(skewSec * 1000));
  return nowMs - skewMs > parsed;
}

function isTrustEntryExpired(entry, nowMs = Date.now(), clockSkewSec = 0) {
  if (!entry || typeof entry !== "object") {
    return true;
  }
  return isExpired(entry.expires_at, nowMs, clockSkewSec);
}

function signRelayDescriptor(descriptor, privateKeyValue) {
  const payload = canonicalizeForSigning(descriptor);
  const privateKey = loadEd25519PrivateKey(privateKeyValue);
  const signature = crypto.sign(null, payload, privateKey);
  return signature.toString("base64");
}

function buildRelayDescriptor(config, nowMs = Date.now()) {
  const issuedAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + config.descriptorTtlSec * 1000).toISOString();
  const descriptor = {
    relay_id: config.relayId,
    endpoint: config.relayEndpoint,
    alg: "ed25519",
    public_key: config.relayPublicKey,
    issued_at: issuedAt,
    expires_at: expiresAt
  };
  const sig = signRelayDescriptor(descriptor, config.relayPrivateKey);
  return {
    ...descriptor,
    signature: {
      alg: "ed25519",
      kid: config.relayId,
      sig
    }
  };
}

function verifyRelayDescriptor(descriptor, trustedEntry, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? Math.floor(options.nowMs) : Date.now();
  const clockSkewSec = Number.isFinite(options.clockSkewSec)
    ? Math.max(0, Math.floor(options.clockSkewSec))
    : 0;

  if (!isPlainObject(descriptor)) {
    return {
      ok: false,
      httpStatus: 400,
      code: "federation_descriptor_invalid",
      message: "Descriptor must be an object"
    };
  }
  if (!trustedEntry) {
    return {
      ok: false,
      httpStatus: 403,
      code: "federation_untrusted_relay",
      message: "Relay is not trusted"
    };
  }
  if (descriptor.relay_id !== trustedEntry.relay_id) {
    return {
      ok: false,
      httpStatus: 403,
      code: "federation_relay_id_mismatch",
      message: "Descriptor relay_id mismatch"
    };
  }
  if (!isPlainObject(descriptor.signature)) {
    return {
      ok: false,
      httpStatus: 401,
      code: "federation_descriptor_signature_required",
      message: "Descriptor signature is required"
    };
  }
  if (typeof descriptor.signature.sig !== "string" || !descriptor.signature.sig.trim()) {
    return {
      ok: false,
      httpStatus: 401,
      code: "federation_descriptor_signature_required",
      message: "Descriptor signature is required"
    };
  }

  const descriptorEndpoint = normalizeEndpoint(descriptor.endpoint);
  if (!descriptorEndpoint) {
    return {
      ok: false,
      httpStatus: 400,
      code: "federation_descriptor_endpoint_invalid",
      message: "Descriptor endpoint is invalid"
    };
  }
  if (descriptorEndpoint !== trustedEntry.endpoint) {
    return {
      ok: false,
      httpStatus: 403,
      code: "federation_endpoint_mismatch",
      message: "Descriptor endpoint does not match trust entry"
    };
  }
  if (descriptor.alg !== "ed25519" || trustedEntry.alg !== "ed25519") {
    return {
      ok: false,
      httpStatus: 400,
      code: "federation_descriptor_alg_unsupported",
      message: "Unsupported descriptor algorithm"
    };
  }
  if (typeof descriptor.public_key !== "string" || !descriptor.public_key.trim()) {
    return {
      ok: false,
      httpStatus: 400,
      code: "federation_descriptor_public_key_missing",
      message: "Descriptor public key is required"
    };
  }

  const issuedAtMs = parseRfc3339(descriptor.issued_at);
  const expiresAtMs = parseRfc3339(descriptor.expires_at);
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs)) {
    return {
      ok: false,
      httpStatus: 400,
      code: "federation_descriptor_time_invalid",
      message: "Descriptor issued_at/expires_at must be RFC3339"
    };
  }
  if (expiresAtMs <= issuedAtMs) {
    return {
      ok: false,
      httpStatus: 400,
      code: "federation_descriptor_time_invalid",
      message: "Descriptor expires_at must be after issued_at"
    };
  }
  const skewMs = Math.max(0, Math.floor(clockSkewSec * 1000));
  if (nowMs + skewMs < issuedAtMs) {
    return {
      ok: false,
      httpStatus: 401,
      code: "federation_descriptor_not_yet_valid",
      message: "Descriptor is not yet valid"
    };
  }
  if (nowMs - skewMs > expiresAtMs) {
    return {
      ok: false,
      httpStatus: 401,
      code: "federation_descriptor_expired",
      message: "Descriptor has expired"
    };
  }
  if (isExpired(trustedEntry.expires_at, nowMs, clockSkewSec)) {
    return {
      ok: false,
      httpStatus: 403,
      code: "federation_trust_entry_expired",
      message: "Trust entry has expired"
    };
  }

  const signatureBytes = decodeBase64(descriptor.signature.sig.trim());
  if (!signatureBytes || signatureBytes.length === 0) {
    return {
      ok: false,
      httpStatus: 400,
      code: "federation_descriptor_signature_invalid",
      message: "Descriptor signature must be base64"
    };
  }

  let publicKey;
  try {
    publicKey = loadEd25519PublicKey(trustedEntry.public_key);
  } catch (err) {
    return {
      ok: false,
      httpStatus: 500,
      code: "federation_trust_key_invalid",
      message: "Trusted relay key is invalid",
      details: { reason: err instanceof Error ? err.message : String(err) }
    };
  }

  let payload;
  try {
    payload = canonicalizeForSigning(descriptor);
  } catch (err) {
    return {
      ok: false,
      httpStatus: 400,
      code: "federation_descriptor_invalid",
      message: "Descriptor canonicalization failed",
      details: { reason: err instanceof Error ? err.message : String(err) }
    };
  }

  let verified = false;
  try {
    verified = crypto.verify(null, payload, publicKey, signatureBytes);
  } catch (_err) {
    verified = false;
  }
  if (!verified) {
    return {
      ok: false,
      httpStatus: 401,
      code: "federation_descriptor_signature_verification_failed",
      message: "Descriptor signature verification failed"
    };
  }

  return {
    ok: true,
    httpStatus: 200,
    code: "federation_descriptor_verified",
    message: "Descriptor verified"
  };
}

function parseHopCount(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || raw === "") {
    return 0;
  }
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return Number.NaN;
  }
  return parsed;
}

function validateHopLimit(value, maxHop) {
  const hop = parseHopCount(value);
  const normalizedMax = Number.isFinite(maxHop) && maxHop > 0 ? Math.floor(maxHop) : 1;
  if (!Number.isFinite(hop)) {
    return { ok: false, hop: 0, reason: "invalid_hop_header" };
  }
  if (hop > normalizedMax) {
    return { ok: false, hop, reason: "hop_limit_exceeded" };
  }
  return { ok: true, hop };
}

function recipientDomain(recipient) {
  if (typeof recipient !== "string") {
    return "";
  }
  const trimmed = recipient.trim();
  if (!trimmed) {
    return "";
  }
  const atIndex = trimmed.lastIndexOf("@");
  if (atIndex > -1 && atIndex < trimmed.length - 1) {
    return trimmed.slice(atIndex + 1).toLowerCase();
  }
  const colonIndex = trimmed.lastIndexOf(":");
  if (colonIndex > -1 && colonIndex < trimmed.length - 1) {
    return trimmed.slice(colonIndex + 1).toLowerCase();
  }
  return "";
}

function isLocalRecipient(recipient, config) {
  const domain = recipientDomain(recipient);
  if (!domain) {
    return true;
  }

  const allowed = new Set();
  if (config && typeof config.relayId === "string" && config.relayId.trim()) {
    allowed.add(config.relayId.trim().toLowerCase());
  }
  if (config && typeof config.relayEndpoint === "string" && config.relayEndpoint.trim()) {
    const host = endpointHostname(config.relayEndpoint.trim());
    if (host) {
      allowed.add(host);
    }
  }
  if (config && Array.isArray(config.localDomains)) {
    config.localDomains.forEach((entry) => {
      if (typeof entry === "string" && entry.trim()) {
        allowed.add(entry.trim().toLowerCase());
      }
    });
  }

  return allowed.has(domain);
}

function resolveDestinationRelayId(recipient, domainsMap) {
  const domain = recipientDomain(recipient);
  if (!domain) {
    return "";
  }
  if (isPlainObject(domainsMap) && typeof domainsMap[domain] === "string" && domainsMap[domain].trim()) {
    return domainsMap[domain].trim();
  }
  return domain;
}

module.exports = {
  DEFAULT_TRUSTED_RELAYS_PATH,
  buildRelayDescriptor,
  canonicalizeForSigning,
  isTrustEntryExpired,
  isLocalRecipient,
  loadTrustPolicy,
  parseFederationConfig,
  parseHopCount,
  recipientDomain,
  resolveDestinationRelayId,
  stableJsonStringify,
  validateHopLimit,
  verifyRelayDescriptor
};
