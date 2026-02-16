import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  REVOCATION_PROOF_TYPE,
  REVOCATION_PROTOCOL_VERSION,
  REVOCATION_SET_TYPE,
  REVOCATION_SIGNATURE_ALG,
  canonicalizeRevocationSetForSigning,
  computeRevocationSetId,
  type RevocationEntry,
  type RevocationKind,
  type RevocationProofV04,
  type RevocationSet
} from "../../protocol/revocation";
import {
  normalizeTrustDistributionMode,
  resolveTrustDistributionSnapshot,
  type TrustDistributionMode
} from "./trust-distribution";

export type RevocationPolicyMode = "off" | "warn" | "enforce";
export type RevocationProofMode = "off" | "on";

type RevocationDistributionMode = "off" | "on";

interface LoggerLike {
  warn(event: unknown): void;
}

const DEFAULT_LOGGER: LoggerLike = {
  warn(event: unknown): void {
    console.warn(JSON.stringify(event));
  }
};

export interface RevocationProofVerificationResult {
  readonly verified: boolean;
  readonly code:
    | "revocation_proof_verified"
    | "revocation_proof_missing"
    | "revocation_proof_key_unknown"
    | "revocation_proof_invalid";
  readonly keyId: string | null;
}

export interface RevocationDistributionResult {
  readonly skipped: boolean;
  readonly mode: TrustDistributionMode;
  readonly distributionEnabled: boolean;
  readonly policyMode: RevocationPolicyMode;
  readonly proofMode: RevocationProofMode;
  readonly sourcePath: string | null;
  readonly proofPath: string | null;
  readonly accepted: boolean;
  readonly revocationCount: number;
  readonly warnings: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<string>;
  readonly revocationsBySubject: ReadonlyMap<string, ReadonlyArray<RevocationEntry>>;
  readonly artifact: RevocationSet | null;
  readonly proof: RevocationProofV04 | null;
  readonly proofVerification: RevocationProofVerificationResult | null;
}

export function parseTrustedRevocationKeysJson(
  raw: unknown
): Readonly<Record<string, string>> {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    const input = normalizeNonEmptyString(raw);
    if (!input) {
      return Object.freeze({});
    }
    try {
      parsed = JSON.parse(input);
    } catch {
      return Object.freeze({});
    }
  }

  if (!isPlainObject(parsed)) {
    return Object.freeze({});
  }

  const normalized: Record<string, string> = {};
  for (const [keyId, publicKeyPemRaw] of Object.entries(parsed)) {
    const normalizedKeyId = normalizeNonEmptyString(keyId);
    const normalizedPem = normalizeNonEmptyString(publicKeyPemRaw);
    if (!normalizedKeyId || !normalizedPem) {
      continue;
    }
    normalized[normalizedKeyId] = normalizedPem;
  }

  return Object.freeze(normalized);
}

function normalizeNonEmptyString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeRevocationDistributionMode(value: unknown): RevocationDistributionMode {
  const normalized = normalizeNonEmptyString(value).toLowerCase();
  if (normalized === "off" || normalized === "on") {
    return normalized;
  }
  return "off";
}

function normalizeProofMode(value: unknown): RevocationProofMode {
  return normalizeRevocationDistributionMode(value);
}

function normalizePolicyMode(value: unknown): RevocationPolicyMode {
  const normalized = normalizeNonEmptyString(value).toLowerCase();
  if (normalized === "off" || normalized === "warn" || normalized === "enforce") {
    return normalized;
  }
  return "off";
}

function shouldLoadRevocations(env: NodeJS.ProcessEnv, mode: TrustDistributionMode): boolean {
  const revocationMode = normalizeRevocationDistributionMode(env.INTENTOS_REVOCATIONS);
  return (
    env.INTENTOS_PROTOCOL_VERSION === "0.4" &&
    revocationMode === "on" &&
    (mode === "fs" || mode === "http")
  );
}

function ensureNonEmptyString(value: unknown, code: string): string {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) {
    throw new Error(code);
  }
  return normalized;
}

function ensureUnixSeconds(value: unknown, code: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(code);
  }
  return value as number;
}

function parseRevocationKind(value: unknown, code: string): RevocationKind {
  const normalized = normalizeNonEmptyString(value);
  if (normalized === "peer" || normalized === "key" || normalized === "anchor") {
    return normalized;
  }
  throw new Error(code);
}

function parseRevocationEntry(raw: unknown, index: number): RevocationEntry {
  if (!isPlainObject(raw)) {
    throw new Error(`revocation_distribution_entry_must_be_object:${index}`);
  }
  const allowedKeys = new Set(["subject", "kind", "reason", "revokedAt", "evidence"]);
  const unknownKeys = Object.keys(raw).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`revocation_distribution_entry_unknown_keys:${index}:${unknownKeys.join(",")}`);
  }

  const subject = ensureNonEmptyString(raw.subject, `revocation_distribution_entry_subject_missing:${index}`);
  const kind = parseRevocationKind(raw.kind, `revocation_distribution_entry_kind_invalid:${index}`);
  const revokedAt = ensureUnixSeconds(raw.revokedAt, `revocation_distribution_entry_revoked_at_invalid:${index}`);
  const reason = normalizeNonEmptyString(raw.reason);
  const evidence = normalizeNonEmptyString(raw.evidence);

  return {
    subject,
    kind,
    revokedAt,
    ...(reason ? { reason } : {}),
    ...(evidence ? { evidence } : {})
  };
}

function parseRevocationSet(rawJson: string, sourcePath: string): RevocationSet {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`revocation_distribution_invalid_json:${sourcePath}:${message}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`revocation_distribution_payload_must_be_object:${sourcePath}`);
  }

  const allowedKeys = new Set(["type", "specVersion", "issuer", "issuedAt", "revocations"]);
  const unknownKeys = Object.keys(parsed).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`revocation_distribution_payload_unknown_keys:${sourcePath}:${unknownKeys.join(",")}`);
  }

  if (parsed.type !== REVOCATION_SET_TYPE) {
    throw new Error(`revocation_distribution_payload_type_invalid:${sourcePath}`);
  }
  if (parsed.specVersion !== REVOCATION_PROTOCOL_VERSION) {
    throw new Error(`revocation_distribution_payload_spec_version_invalid:${sourcePath}`);
  }

  const issuer = ensureNonEmptyString(parsed.issuer, `revocation_distribution_issuer_missing:${sourcePath}`);
  const issuedAt = ensureUnixSeconds(parsed.issuedAt, `revocation_distribution_issued_at_invalid:${sourcePath}`);

  if (!Array.isArray(parsed.revocations)) {
    throw new Error(`revocation_distribution_revocations_must_be_array:${sourcePath}`);
  }

  const revocations = parsed.revocations.map((entry, index) => parseRevocationEntry(entry, index));

  return {
    type: REVOCATION_SET_TYPE,
    specVersion: REVOCATION_PROTOCOL_VERSION,
    issuer,
    issuedAt,
    revocations
  };
}

function parseRevocationProof(rawJson: string, sourcePath: string): RevocationProofV04 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`revocation_distribution_proof_invalid_json:${sourcePath}:${message}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`revocation_distribution_proof_payload_must_be_object:${sourcePath}`);
  }

  const allowedKeys = new Set([
    "type",
    "version",
    "keyId",
    "alg",
    "createdAt",
    "signature",
    "revocationSetId"
  ]);
  const unknownKeys = Object.keys(parsed).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`revocation_distribution_proof_unknown_keys:${sourcePath}:${unknownKeys.join(",")}`);
  }

  if (parsed.type !== REVOCATION_PROOF_TYPE) {
    throw new Error(`revocation_distribution_proof_type_invalid:${sourcePath}`);
  }
  if (parsed.version !== REVOCATION_PROTOCOL_VERSION) {
    throw new Error(`revocation_distribution_proof_version_invalid:${sourcePath}`);
  }

  const keyId = ensureNonEmptyString(parsed.keyId, `revocation_distribution_proof_key_id_missing:${sourcePath}`);
  const alg = normalizeNonEmptyString(parsed.alg).toLowerCase();
  if (alg !== REVOCATION_SIGNATURE_ALG) {
    throw new Error(`revocation_distribution_proof_alg_invalid:${sourcePath}`);
  }
  const createdAt = ensureUnixSeconds(
    parsed.createdAt,
    `revocation_distribution_proof_created_at_invalid:${sourcePath}`
  );
  const signature = ensureNonEmptyString(
    parsed.signature,
    `revocation_distribution_proof_signature_missing:${sourcePath}`
  );
  const revocationSetId = normalizeNonEmptyString(parsed.revocationSetId);

  return {
    type: REVOCATION_PROOF_TYPE,
    version: REVOCATION_PROTOCOL_VERSION,
    keyId,
    alg: REVOCATION_SIGNATURE_ALG,
    createdAt,
    signature,
    ...(revocationSetId ? { revocationSetId } : {})
  };
}

function buildRevocationsBySubject(
  revocations: ReadonlyArray<RevocationEntry>
): Map<string, ReadonlyArray<RevocationEntry>> {
  const grouped = new Map<string, RevocationEntry[]>();
  for (const entry of revocations) {
    const list = grouped.get(entry.subject);
    if (list) {
      list.push(entry);
      continue;
    }
    grouped.set(entry.subject, [entry]);
  }

  const normalized = new Map<string, ReadonlyArray<RevocationEntry>>();
  for (const [subject, entries] of grouped.entries()) {
    normalized.set(subject, Object.freeze([...entries]));
  }
  return normalized;
}

function toEmptyResult(
  mode: TrustDistributionMode,
  distributionEnabled: boolean,
  policyMode: RevocationPolicyMode,
  proofMode: RevocationProofMode,
  sourcePath: string | null,
  proofPath: string | null
): RevocationDistributionResult {
  return {
    skipped: !distributionEnabled,
    mode,
    distributionEnabled,
    policyMode,
    proofMode,
    sourcePath,
    proofPath,
    accepted: true,
    revocationCount: 0,
    warnings: [],
    errors: [],
    revocationsBySubject: new Map<string, ReadonlyArray<RevocationEntry>>(),
    artifact: null,
    proof: null,
    proofVerification: null
  };
}

function buildVerificationFailure(
  code: RevocationProofVerificationResult["code"],
  keyId: string | null
): RevocationProofVerificationResult {
  return {
    verified: false,
    code,
    keyId
  };
}

export function verifyRevocationProof(
  set: RevocationSet,
  proof: RevocationProofV04 | null | undefined,
  trustedKeysJson: unknown
): RevocationProofVerificationResult {
  if (!proof) {
    return buildVerificationFailure("revocation_proof_missing", null);
  }

  const keyId = normalizeNonEmptyString(proof.keyId);
  if (!keyId) {
    return buildVerificationFailure("revocation_proof_missing", null);
  }

  const trustedKeys = parseTrustedRevocationKeysJson(trustedKeysJson);
  const publicKeyPem = normalizeNonEmptyString(trustedKeys[keyId]);
  if (!publicKeyPem) {
    return buildVerificationFailure("revocation_proof_key_unknown", keyId);
  }

  if (proof.revocationSetId && proof.revocationSetId !== computeRevocationSetId(set)) {
    return buildVerificationFailure("revocation_proof_invalid", keyId);
  }

  try {
    const verifiedSignature = verify(
      null,
      canonicalizeRevocationSetForSigning(set),
      createPublicKey(publicKeyPem),
      Buffer.from(proof.signature, "base64")
    );
    if (!verifiedSignature) {
      return buildVerificationFailure("revocation_proof_invalid", keyId);
    }
  } catch {
    return buildVerificationFailure("revocation_proof_invalid", keyId);
  }

  return {
    verified: true,
    code: "revocation_proof_verified",
    keyId
  };
}

function applyDiagnosticByPolicy(
  mode: TrustDistributionMode,
  policyMode: RevocationPolicyMode,
  proofMode: RevocationProofMode,
  sourcePath: string | null,
  proofPath: string | null,
  diagnostic: string,
  logger: LoggerLike
): RevocationDistributionResult {
  if (policyMode === "warn") {
    logger.warn({
      event: "intentos_revocation_distribution",
      mode: policyMode,
      diagnostic
    });
    return {
      ...toEmptyResult(mode, true, policyMode, proofMode, sourcePath, proofPath),
      skipped: false,
      accepted: false,
      warnings: [diagnostic]
    };
  }
  if (policyMode === "enforce" || proofMode === "on") {
    return {
      ...toEmptyResult(mode, true, policyMode, proofMode, sourcePath, proofPath),
      skipped: false,
      accepted: false,
      errors: [diagnostic]
    };
  }
  return {
    ...toEmptyResult(mode, true, policyMode, proofMode, sourcePath, proofPath),
    skipped: false
  };
}

export function loadRevocationsFromDistribution(
  env: NodeJS.ProcessEnv = {},
  logger: LoggerLike = DEFAULT_LOGGER
): RevocationDistributionResult {
  const mode = normalizeTrustDistributionMode(env.INTENTOS_TRUST_DISTRIBUTION);
  const distributionEnabled = shouldLoadRevocations(env, mode);
  const policyMode = normalizePolicyMode(env.INTENTOS_REVOCATION_POLICY);
  const proofMode = normalizeProofMode(env.INTENTOS_REVOCATION_PROOF);

  if (!distributionEnabled) {
    return toEmptyResult(mode, false, policyMode, proofMode, null, null);
  }

  let sourcePath: string | null = null;
  let proofPath: string | null = null;
  try {
    const snapshot = resolveTrustDistributionSnapshot(env);
    sourcePath = snapshot?.revocationsPath ?? null;
    proofPath = snapshot?.revocationsProofPath ?? null;
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    return applyDiagnosticByPolicy(
      mode,
      policyMode,
      proofMode,
      sourcePath,
      proofPath,
      diagnostic,
      logger
    );
  }

  if (!sourcePath) {
    return toEmptyResult(mode, true, policyMode, proofMode, null, proofPath);
  }

  if (policyMode === "off" && proofMode === "off") {
    return {
      ...toEmptyResult(mode, true, policyMode, proofMode, sourcePath, proofPath),
      skipped: false
    };
  }

  try {
    const parsedSet = parseRevocationSet(readFileSync(sourcePath, "utf8"), sourcePath);
    const revocationsBySubject = buildRevocationsBySubject(parsedSet.revocations);

    let parsedProof: RevocationProofV04 | null = null;
    let proofVerification: RevocationProofVerificationResult | null = null;

    if (proofMode === "on") {
      if (!proofPath) {
        throw new Error("revocation_proof_missing");
      }
      parsedProof = parseRevocationProof(readFileSync(proofPath, "utf8"), proofPath);
      proofVerification = verifyRevocationProof(
        parsedSet,
        parsedProof,
        env.INTENTOS_TRUSTED_REVOCATION_KEYS_JSON
      );
      if (!proofVerification.verified) {
        throw new Error(proofVerification.code);
      }
    }

    return {
      skipped: false,
      mode,
      distributionEnabled: true,
      policyMode,
      proofMode,
      sourcePath,
      proofPath,
      accepted: true,
      revocationCount: parsedSet.revocations.length,
      warnings: [],
      errors: [],
      revocationsBySubject,
      artifact: parsedSet,
      proof: parsedProof,
      proofVerification
    };
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    return applyDiagnosticByPolicy(
      mode,
      policyMode,
      proofMode,
      sourcePath,
      proofPath,
      diagnostic,
      logger
    );
  }
}
