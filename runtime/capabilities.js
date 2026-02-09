"use strict";

const { createIdentityVerifier, verifyProofForPayload } = require("./identity");

const RFC3339_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const PRINCIPAL_ROLES = new Set(["relay", "agent", "service"]);

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

function authorizationDecision(allow, reason_code, message, details) {
  const result = { allow, reason_code, message };
  if (details !== undefined) {
    result.details = details;
  }
  return result;
}

function validateScope(scope) {
  if (!isPlainObject(scope)) {
    return verifyResult(false, "capdoc_scope_invalid", "scope must be an object");
  }
  if (typeof scope.action !== "string" || !scope.action.trim()) {
    return verifyResult(false, "capdoc_scope_invalid", "scope.action is required");
  }
  if (typeof scope.resource !== "string" || !scope.resource.trim()) {
    return verifyResult(false, "capdoc_scope_invalid", "scope.resource is required");
  }
  return verifyResult(true, "capdoc_scope_valid", "scope is valid");
}

function validateCapDoc(doc, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? Math.floor(options.nowMs) : Date.now();
  const clockSkewSec = parseClockSkewSec(options.clockSkewSec, 0);
  const skewMs = clockSkewSec * 1000;

  if (!isPlainObject(doc)) {
    return verifyResult(false, "capdoc_invalid", "capability document must be an object");
  }
  if (typeof doc.id !== "string" || !doc.id.trim()) {
    return verifyResult(false, "capdoc_invalid", "capability id is required");
  }
  if (doc.type !== "aimtp.capability") {
    return verifyResult(false, "capdoc_invalid", "capability type must be aimtp.capability");
  }
  if (typeof doc.issuer !== "string" || !doc.issuer.trim()) {
    return verifyResult(false, "capdoc_invalid", "capability issuer is required");
  }
  if (typeof doc.subject !== "string" || !doc.subject.trim()) {
    return verifyResult(false, "capdoc_invalid", "capability subject is required");
  }
  if (!Array.isArray(doc.scopes) || doc.scopes.length === 0) {
    return verifyResult(false, "capdoc_invalid", "capability scopes must be a non-empty array");
  }
  for (let i = 0; i < doc.scopes.length; i += 1) {
    const scopeResult = validateScope(doc.scopes[i]);
    if (!scopeResult.ok) {
      return verifyResult(false, scopeResult.code, scopeResult.message, { scope_index: i, cap_id: doc.id });
    }
  }

  if (doc.constraints !== undefined) {
    if (!isPlainObject(doc.constraints)) {
      return verifyResult(false, "capdoc_constraints_invalid", "constraints must be an object");
    }
    if (doc.constraints.max_hops !== undefined) {
      if (!Number.isInteger(doc.constraints.max_hops) || doc.constraints.max_hops < 0) {
        return verifyResult(false, "capdoc_constraints_invalid", "constraints.max_hops must be >= 0");
      }
    }
    if (doc.constraints.audience !== undefined) {
      if (
        !Array.isArray(doc.constraints.audience) ||
        doc.constraints.audience.length === 0 ||
        doc.constraints.audience.some((value) => typeof value !== "string" || !value.trim())
      ) {
        return verifyResult(
          false,
          "capdoc_constraints_invalid",
          "constraints.audience must be a non-empty string array"
        );
      }
    }
    if (doc.constraints.rate_limit !== undefined) {
      if (!isPlainObject(doc.constraints.rate_limit)) {
        return verifyResult(false, "capdoc_constraints_invalid", "constraints.rate_limit must be an object");
      }
      if (doc.constraints.rate_limit.per_minute !== undefined) {
        if (
          !Number.isInteger(doc.constraints.rate_limit.per_minute) ||
          doc.constraints.rate_limit.per_minute <= 0
        ) {
          return verifyResult(
            false,
            "capdoc_constraints_invalid",
            "constraints.rate_limit.per_minute must be > 0"
          );
        }
      }
    }
  }

  if (doc.delegation !== undefined) {
    if (!isPlainObject(doc.delegation)) {
      return verifyResult(false, "capdoc_delegation_invalid", "delegation must be an object");
    }
    if (typeof doc.delegation.allowed !== "boolean") {
      return verifyResult(false, "capdoc_delegation_invalid", "delegation.allowed must be boolean");
    }
    if (doc.delegation.max_depth !== undefined) {
      if (!Number.isInteger(doc.delegation.max_depth) || doc.delegation.max_depth < 0) {
        return verifyResult(false, "capdoc_delegation_invalid", "delegation.max_depth must be >= 0");
      }
    }
  }

  const issuedAtMs = parseDateTime(doc.issued_at);
  const expiresAtMs = parseDateTime(doc.expires_at);
  if (Number.isNaN(issuedAtMs)) {
    return verifyResult(false, "capdoc_invalid", "issued_at must be RFC3339");
  }
  if (Number.isNaN(expiresAtMs)) {
    return verifyResult(false, "capdoc_invalid", "expires_at must be RFC3339");
  }
  if (issuedAtMs !== null && expiresAtMs !== null && issuedAtMs > expiresAtMs) {
    return verifyResult(false, "capdoc_invalid", "issued_at must be before expires_at");
  }
  if (issuedAtMs !== null && nowMs + skewMs < issuedAtMs) {
    return verifyResult(false, "capdoc_not_yet_valid", "capability document is not yet valid");
  }
  if (expiresAtMs !== null && nowMs - skewMs > expiresAtMs) {
    return verifyResult(false, "capdoc_expired", "capability document has expired");
  }

  if (!isPlainObject(doc.proof)) {
    return verifyResult(false, "capdoc_proof_missing", "proof is required");
  }
  if (doc.proof.alg !== "ed25519") {
    return verifyResult(false, "capdoc_proof_invalid", "proof.alg must be ed25519");
  }
  if (typeof doc.proof.kid !== "string" || !doc.proof.kid.trim()) {
    return verifyResult(false, "capdoc_proof_invalid", "proof.kid is required");
  }
  if (typeof doc.proof.sig !== "string" || !doc.proof.sig.trim()) {
    return verifyResult(false, "capdoc_proof_invalid", "proof.sig is required");
  }

  return verifyResult(true, "capdoc_valid", "capability document is valid", {
    cap_id: doc.id,
    issuer: doc.issuer,
    subject: doc.subject
  });
}

function resolveIdentityForIssuer(doc, options = {}) {
  if (typeof options.lookupIdentity === "function") {
    const resolved = options.lookupIdentity(doc.issuer, doc);
    if (isPlainObject(resolved)) {
      return resolved;
    }
  }
  if (options.identities instanceof Map) {
    const resolved = options.identities.get(doc.issuer);
    if (isPlainObject(resolved)) {
      return resolved;
    }
  }
  if (isPlainObject(options.identities)) {
    const resolved = options.identities[doc.issuer];
    if (isPlainObject(resolved)) {
      return resolved;
    }
  }
  if (isPlainObject(doc.issuer_identity)) {
    return doc.issuer_identity;
  }
  return null;
}

function verifyCapDoc(doc, identityVerifier, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? Math.floor(options.nowMs) : Date.now();
  const clockSkewSec = parseClockSkewSec(options.clockSkewSec, 0);
  const validation = validateCapDoc(doc, { nowMs, clockSkewSec });
  if (!validation.ok) {
    return validation;
  }

  const verifier = identityVerifier || createIdentityVerifier({ clockSkewSec });
  const issuerIdentity = resolveIdentityForIssuer(doc, options);
  if (!issuerIdentity) {
    return verifyResult(false, "capdoc_issuer_identity_missing", "issuer identity is required", {
      issuer: doc.issuer,
      cap_id: doc.id
    });
  }
  if (issuerIdentity.id !== doc.issuer) {
    return verifyResult(
      false,
      "capdoc_issuer_mismatch",
      "issuer identity does not match capability issuer",
      { issuer: doc.issuer, identity_id: issuerIdentity.id, cap_id: doc.id }
    );
  }
  if (!PRINCIPAL_ROLES.has(issuerIdentity.role)) {
    return verifyResult(false, "capdoc_issuer_role_invalid", "issuer identity role is invalid", {
      issuer: doc.issuer,
      role: issuerIdentity.role,
      cap_id: doc.id
    });
  }

  const identityResult = verifier.verifyIdentityDocument(issuerIdentity, { nowMs });
  if (!identityResult.ok) {
    return verifyResult(
      false,
      "capdoc_issuer_identity_invalid",
      "issuer identity validation failed",
      { issuer: doc.issuer, cap_id: doc.id, reason: identityResult.code }
    );
  }

  const proofResult = verifyProofForPayload(doc, issuerIdentity, doc.proof, { nowMs, clockSkewSec });
  if (!proofResult.ok) {
    return verifyResult(false, "capdoc_proof_invalid", "capability proof verification failed", {
      issuer: doc.issuer,
      cap_id: doc.id,
      reason: proofResult.code
    });
  }

  return verifyResult(true, "capdoc_verified", "capability document verified", {
    issuer: doc.issuer,
    subject: doc.subject,
    cap_id: doc.id,
    kid: doc.proof.kid
  });
}

function scopeMatches(scope, request) {
  return scope.action === request.action && scope.resource === request.resource;
}

function normalizeCapabilityChain(chain) {
  if (Array.isArray(chain)) {
    return { docs: chain, requested: null };
  }
  if (isPlainObject(chain) && Array.isArray(chain.chain)) {
    return {
      docs: chain.chain,
      requested: isPlainObject(chain.requested) ? chain.requested : null
    };
  }
  return { docs: null, requested: null };
}

function validateCapChain(chain, options = {}) {
  const normalized = normalizeCapabilityChain(chain);
  const docs = normalized.docs;
  const nowMs = Number.isFinite(options.nowMs) ? Math.floor(options.nowMs) : Date.now();
  const clockSkewSec = parseClockSkewSec(options.clockSkewSec, 0);

  if (!Array.isArray(docs) || docs.length === 0) {
    return verifyResult(false, "capability_chain_missing", "capability chain is required");
  }

  for (let i = 0; i < docs.length; i += 1) {
    const docValidation = validateCapDoc(docs[i], { nowMs, clockSkewSec });
    if (!docValidation.ok) {
      return verifyResult(false, docValidation.code, docValidation.message, { cap_index: i });
    }
  }

  for (let i = 0; i < docs.length - 1; i += 1) {
    if (docs[i].subject !== docs[i + 1].issuer) {
      return verifyResult(false, "capability_chain_discontinuity", "capability chain is not contiguous", {
        cap_index: i
      });
    }
  }

  if (docs.length > 1) {
    for (let i = 0; i < docs.length - 1; i += 1) {
      const delegation = isPlainObject(docs[i].delegation) ? docs[i].delegation : null;
      if (!delegation || delegation.allowed !== true) {
        return verifyResult(false, "capability_delegation_not_allowed", "delegation is not allowed", {
          cap_index: i
        });
      }
      if (Number.isInteger(delegation.max_depth)) {
        const remainingDepth = docs.length - i - 1;
        if (remainingDepth > delegation.max_depth) {
          return verifyResult(
            false,
            "capability_delegation_depth_exceeded",
            "delegation depth exceeded",
            { cap_index: i }
          );
        }
      }
    }
  }

  return verifyResult(true, "capability_chain_valid", "capability chain is valid");
}

function evaluateCapability(chain, request, options = {}) {
  const normalized = normalizeCapabilityChain(chain);
  const docs = normalized.docs;
  const chainRequested = normalized.requested;
  const nowMs = Number.isFinite(options.nowMs) ? Math.floor(options.nowMs) : Date.now();
  const clockSkewSec = parseClockSkewSec(options.clockSkewSec, 0);
  const identityVerifier = options.identityVerifier || createIdentityVerifier({ clockSkewSec });

  if (!Array.isArray(docs) || docs.length === 0) {
    return authorizationDecision(false, "capability_chain_missing", "capability chain is required", {
      chain_verified: false
    });
  }
  if (!isPlainObject(request)) {
    return authorizationDecision(false, "capability_request_invalid", "authorization request must be an object", {
      chain_verified: false
    });
  }
  if (typeof request.action !== "string" || !request.action.trim()) {
    return authorizationDecision(false, "capability_request_invalid", "authorization request action is required", {
      chain_verified: false
    });
  }
  if (typeof request.resource !== "string" || !request.resource.trim()) {
    return authorizationDecision(
      false,
      "capability_request_invalid",
      "authorization request resource is required",
      { chain_verified: false }
    );
  }
  if (chainRequested) {
    if (
      chainRequested.action !== undefined && chainRequested.action !== request.action ||
      chainRequested.resource !== undefined && chainRequested.resource !== request.resource
    ) {
      return authorizationDecision(false, "capability_requested_mismatch", "requested capability does not match", {
        chain_verified: false
      });
    }
  }

  const chainValidation = validateCapChain(docs, { nowMs, clockSkewSec });
  if (!chainValidation.ok) {
    return authorizationDecision(false, chainValidation.code, chainValidation.message, {
      chain_verified: false,
      cap_index:
        chainValidation.details && Number.isInteger(chainValidation.details.cap_index)
          ? chainValidation.details.cap_index
          : undefined
    });
  }

  for (let i = 0; i < docs.length; i += 1) {
    const verifyDocResult = verifyCapDoc(docs[i], identityVerifier, {
      ...options,
      nowMs,
      clockSkewSec
    });
    if (!verifyDocResult.ok) {
      return authorizationDecision(false, verifyDocResult.code, verifyDocResult.message, {
        chain_verified: false,
        cap_index: i
      });
    }
  }

  const finalDoc = docs[docs.length - 1];
  if (typeof request.subject === "string" && request.subject.trim()) {
    if (finalDoc.subject !== request.subject) {
      return authorizationDecision(false, "capability_subject_mismatch", "capability subject mismatch", {
        chain_verified: true
      });
    }
  }

  for (let i = 0; i < docs.length; i += 1) {
    const hasScope = docs[i].scopes.some((scope) => scopeMatches(scope, request));
    if (!hasScope) {
      return authorizationDecision(false, "capability_scope_mismatch", "scope does not authorize request", {
        chain_verified: true,
        cap_index: i
      });
    }
  }

  for (let i = 0; i < docs.length; i += 1) {
    const constraints = isPlainObject(docs[i].constraints) ? docs[i].constraints : null;
    if (!constraints) {
      continue;
    }
    if (Array.isArray(constraints.audience)) {
      if (typeof request.audience !== "string" || !request.audience.trim()) {
        return authorizationDecision(false, "capability_audience_missing", "audience is required by constraint", {
          chain_verified: true,
          cap_index: i
        });
      }
      const match = constraints.audience.some((entry) => entry === request.audience);
      if (!match) {
        return authorizationDecision(false, "capability_audience_mismatch", "audience is not allowed", {
          chain_verified: true,
          cap_index: i
        });
      }
    }
    if (Number.isInteger(constraints.max_hops)) {
      const hops = Number.isFinite(request.hops) ? Math.max(0, Math.floor(request.hops)) : 0;
      if (hops > constraints.max_hops) {
        return authorizationDecision(false, "capability_max_hops_exceeded", "max_hops exceeded", {
          chain_verified: true,
          cap_index: i
        });
      }
    }
  }

  return authorizationDecision(true, "capability_authorized", "capability authorizes request", {
    chain_verified: true,
    issuer: docs[0].issuer,
    subject: finalDoc.subject,
    cap_ids: docs.map((doc) => doc.id)
  });
}

module.exports = {
  evaluateCapability,
  validateCapChain,
  validateCapDoc,
  verifyCapDoc
};
