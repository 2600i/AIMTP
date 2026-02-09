"use strict";

const crypto = require("crypto");
const { canonicalizeJson } = require("./signature");

const BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toInteger(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Number.NaN;
}

function scopeKey(scope) {
  return `${scope.action}::${scope.resource}`;
}

function normalizeScope(scope) {
  return {
    action: typeof scope.action === "string" ? scope.action.trim() : "",
    resource: typeof scope.resource === "string" ? scope.resource.trim() : ""
  };
}

function canonicalizeCapabilityPayload(payload) {
  return Buffer.from(canonicalizeJson(payload), "utf8");
}

function detectSigningAlgorithm(privateKey) {
  if (!privateKey || privateKey.type !== "private") {
    throw new Error("invalid_private_key");
  }
  if (privateKey.asymmetricKeyType === "ed25519") {
    return "ed25519";
  }
  if (privateKey.asymmetricKeyType === "ec") {
    return "secp256k1";
  }
  throw new Error("unsupported_private_key_type");
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

function loadPublicKey(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("missing_public_key");
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("-----BEGIN")) {
    return crypto.createPublicKey(trimmed);
  }
  const decoded = decodeKeyMaterial(trimmed);
  if (!decoded || decoded.length === 0) {
    throw new Error("invalid_public_key");
  }
  return crypto.createPublicKey({
    key: decoded,
    format: "der",
    type: "spki"
  });
}

function createCapabilityDocument(input) {
  if (!isPlainObject(input)) {
    throw new Error("capability_document_must_be_object");
  }
  const scopes = Array.isArray(input.scopes) ? input.scopes.map(normalizeScope) : [];
  return {
    issuer: typeof input.issuer === "string" ? input.issuer.trim() : "",
    subject: typeof input.subject === "string" ? input.subject.trim() : "",
    aud: typeof input.aud === "string" ? input.aud.trim() : "",
    iat: toInteger(input.iat),
    exp: toInteger(input.exp),
    scopes
  };
}

function validateCapabilityDocument(doc, options = {}) {
  const errors = [];
  const normalized = createCapabilityDocument(doc);
  if (!normalized.issuer) {
    errors.push("issuer is required");
  }
  if (!normalized.subject) {
    errors.push("subject is required");
  }
  if (!normalized.aud) {
    errors.push("aud is required");
  }
  if (typeof options.aud === "string" && options.aud.trim() && normalized.aud !== options.aud.trim()) {
    errors.push("aud must match exactly");
  }
  if (!Number.isFinite(normalized.iat)) {
    errors.push("iat must be an integer unix timestamp");
  }
  if (!Number.isFinite(normalized.exp)) {
    errors.push("exp must be an integer unix timestamp");
  }
  if (Number.isFinite(normalized.iat) && Number.isFinite(normalized.exp) && normalized.exp <= normalized.iat) {
    errors.push("exp must be greater than iat");
  }
  const nowSec =
    Number.isFinite(options.nowSec) ? Math.floor(options.nowSec) : Math.floor(Date.now() / 1000);
  if (Number.isFinite(normalized.iat) && normalized.iat > nowSec) {
    errors.push("capability is not yet valid");
  }
  if (Number.isFinite(normalized.exp) && normalized.exp < nowSec) {
    errors.push("capability is expired");
  }
  if (!Array.isArray(normalized.scopes) || normalized.scopes.length === 0) {
    errors.push("at least one scope is required");
  } else {
    normalized.scopes.forEach((scope, index) => {
      if (!scope.action) {
        errors.push(`scope[${index}].action is required`);
      }
      if (!scope.resource) {
        errors.push(`scope[${index}].resource is required`);
      }
      if (scope.action.includes("*")) {
        errors.push(`scope[${index}].action cannot include wildcard`);
      }
      if (scope.resource.includes("*")) {
        errors.push(`scope[${index}].resource cannot include wildcard`);
      }
    });
  }
  return { ok: errors.length === 0, errors, normalized };
}

function validateCapabilityChain(chain, options = {}) {
  const errors = [];
  if (!Array.isArray(chain) || chain.length === 0) {
    return { ok: false, errors: ["chain must be a non-empty array"], normalized: [] };
  }
  const normalized = [];
  for (let i = 0; i < chain.length; i += 1) {
    const result = validateCapabilityDocument(chain[i], options);
    if (!result.ok) {
      result.errors.forEach((error) => errors.push(`chain[${i}]: ${error}`));
    }
    const doc = result.normalized;
    normalized.push(doc);
    if (i === 0) {
      continue;
    }
    const parent = normalized[i - 1];
    if (doc.issuer !== parent.subject) {
      errors.push(`chain[${i}]: issuer must equal previous subject`);
    }
    if (doc.aud !== parent.aud) {
      errors.push(`chain[${i}]: aud must match previous delegation`);
    }
    if (Number.isFinite(doc.exp) && Number.isFinite(parent.exp) && doc.exp > parent.exp) {
      errors.push(`chain[${i}]: exp cannot exceed parent exp`);
    }
    const parentScopes = new Set(parent.scopes.map(scopeKey));
    doc.scopes.forEach((scope) => {
      if (!parentScopes.has(scopeKey(scope))) {
        errors.push(`chain[${i}]: scope ${scope.action} ${scope.resource} is not delegated by parent`);
      }
    });
  }
  return { ok: errors.length === 0, errors, normalized };
}

function signCapabilityPresentation(chain, options = {}) {
  if (!Array.isArray(chain) || chain.length === 0) {
    throw new Error("chain must be a non-empty array");
  }
  const privateKeyValue = options.privateKey;
  if (typeof privateKeyValue !== "string" || !privateKeyValue.trim()) {
    throw new Error("private key is required");
  }
  const privateKey = crypto.createPrivateKey(privateKeyValue);
  const alg = detectSigningAlgorithm(privateKey);
  const payload = canonicalizeCapabilityPayload({ chain });
  const signatureBytes =
    alg === "ed25519"
      ? crypto.sign(null, payload, privateKey)
      : crypto.sign("sha256", payload, privateKey);
  const presentation = {
    chain,
    signature: {
      alg,
      kid: options.kid || chain[chain.length - 1].issuer,
      sig: signatureBytes.toString("base64")
    }
  };
  if (typeof options.publicKey === "string" && options.publicKey.trim()) {
    presentation.public_key = options.publicKey.trim();
  }
  return presentation;
}

function verifyCapabilitySignature(presentation, options = {}) {
  if (!isPlainObject(presentation)) {
    return { ok: false, error: "presentation must be an object" };
  }
  const signature = isPlainObject(presentation.signature) ? presentation.signature : null;
  if (!signature) {
    return { ok: false, error: "signature is required" };
  }
  const alg = typeof signature.alg === "string" ? signature.alg.trim().toLowerCase() : "";
  const sig = typeof signature.sig === "string" ? signature.sig.trim() : "";
  if (alg !== "ed25519" && alg !== "secp256k1") {
    return { ok: false, error: "signature.alg must be ed25519 or secp256k1" };
  }
  const signatureBytes = decodeBase64(sig);
  if (!signatureBytes || signatureBytes.length === 0) {
    return { ok: false, error: "signature.sig must be base64" };
  }
  const publicKeyValue =
    (typeof options.publicKey === "string" && options.publicKey.trim()) ||
    (typeof presentation.public_key === "string" && presentation.public_key.trim());
  if (!publicKeyValue) {
    return { ok: false, error: "public key is required for signature verification" };
  }
  let publicKey;
  try {
    publicKey = loadPublicKey(publicKeyValue);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const payload = canonicalizeCapabilityPayload({ chain: presentation.chain });
  let verified = false;
  try {
    if (alg === "ed25519") {
      verified = crypto.verify(null, payload, publicKey, signatureBytes);
    } else {
      verified = crypto.verify("sha256", payload, publicKey, signatureBytes);
      if (!verified && signatureBytes.length === 64) {
        verified = crypto.verify(
          "sha256",
          payload,
          { key: publicKey, dsaEncoding: "ieee-p1363" },
          signatureBytes
        );
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!verified) {
    return { ok: false, error: "signature verification failed" };
  }
  return { ok: true };
}

function summarizeCapabilityChain(chain) {
  if (!Array.isArray(chain) || chain.length === 0) {
    return {
      issuer: "",
      subject: "",
      aud: "",
      iat: 0,
      exp: 0,
      depth: 0,
      scopes: []
    };
  }
  const leaf = chain[chain.length - 1];
  return {
    issuer: leaf.issuer,
    subject: leaf.subject,
    aud: leaf.aud,
    iat: leaf.iat,
    exp: leaf.exp,
    depth: Math.max(0, chain.length - 1),
    scopes: Array.isArray(leaf.scopes) ? leaf.scopes : []
  };
}

function validateCapabilityPresentation(presentation, options = {}) {
  const errors = [];
  if (!isPlainObject(presentation)) {
    return { ok: false, errors: ["presentation must be an object"] };
  }
  const chainResult = validateCapabilityChain(presentation.chain, options);
  if (!chainResult.ok) {
    chainResult.errors.forEach((error) => errors.push(error));
  }
  const verifySignature = options.verifySignature !== false;
  if (verifySignature) {
    const signatureResult = verifyCapabilitySignature(presentation, options);
    if (!signatureResult.ok) {
      errors.push(signatureResult.error);
    }
  }
  const summary = summarizeCapabilityChain(chainResult.normalized);
  return {
    ok: errors.length === 0,
    errors,
    summary,
    chain: chainResult.normalized
  };
}

module.exports = {
  canonicalizeCapabilityPayload,
  createCapabilityDocument,
  signCapabilityPresentation,
  summarizeCapabilityChain,
  validateCapabilityChain,
  validateCapabilityDocument,
  validateCapabilityPresentation,
  verifyCapabilitySignature
};
