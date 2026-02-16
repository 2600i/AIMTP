import { readFileSync } from "node:fs";
import {
  REVOCATION_PROTOCOL_VERSION,
  REVOCATION_SET_TYPE,
  type RevocationEntry,
  type RevocationKind,
  type RevocationSet
} from "../../protocol/revocation";
import {
  normalizeTrustDistributionMode,
  resolveTrustDistributionSnapshot,
  type TrustDistributionMode
} from "./trust-distribution";

export type RevocationPolicyMode = "off" | "warn" | "enforce";

type RevocationDistributionMode = "off" | "on";

interface LoggerLike {
  warn(event: unknown): void;
}

const DEFAULT_LOGGER: LoggerLike = {
  warn(event: unknown): void {
    console.warn(JSON.stringify(event));
  }
};

export interface RevocationDistributionResult {
  readonly skipped: boolean;
  readonly mode: TrustDistributionMode;
  readonly distributionEnabled: boolean;
  readonly policyMode: RevocationPolicyMode;
  readonly sourcePath: string | null;
  readonly accepted: boolean;
  readonly revocationCount: number;
  readonly warnings: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<string>;
  readonly revocationsBySubject: ReadonlyMap<string, ReadonlyArray<RevocationEntry>>;
  readonly artifact: RevocationSet | null;
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
  sourcePath: string | null
): RevocationDistributionResult {
  return {
    skipped: !distributionEnabled,
    mode,
    distributionEnabled,
    policyMode,
    sourcePath,
    accepted: true,
    revocationCount: 0,
    warnings: [],
    errors: [],
    revocationsBySubject: new Map<string, ReadonlyArray<RevocationEntry>>(),
    artifact: null
  };
}

export function loadRevocationsFromDistribution(
  env: NodeJS.ProcessEnv = {},
  logger: LoggerLike = DEFAULT_LOGGER
): RevocationDistributionResult {
  const mode = normalizeTrustDistributionMode(env.INTENTOS_TRUST_DISTRIBUTION);
  const distributionEnabled = shouldLoadRevocations(env, mode);
  const policyMode = normalizePolicyMode(env.INTENTOS_REVOCATION_POLICY);

  if (!distributionEnabled) {
    return toEmptyResult(mode, false, policyMode, null);
  }

  let sourcePath: string | null = null;
  try {
    const snapshot = resolveTrustDistributionSnapshot(env);
    sourcePath = snapshot?.revocationsPath ?? null;
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    if (policyMode === "warn") {
      logger.warn({
        event: "intentos_revocation_distribution",
        mode: policyMode,
        diagnostic
      });
      return {
        ...toEmptyResult(mode, true, policyMode, sourcePath),
        accepted: false,
        warnings: [diagnostic]
      };
    }
    if (policyMode === "enforce") {
      return {
        ...toEmptyResult(mode, true, policyMode, sourcePath),
        accepted: false,
        errors: [diagnostic]
      };
    }
    return toEmptyResult(mode, true, policyMode, sourcePath);
  }

  if (!sourcePath) {
    return toEmptyResult(mode, true, policyMode, null);
  }

  if (policyMode === "off") {
    return {
      ...toEmptyResult(mode, true, policyMode, sourcePath),
      skipped: false
    };
  }

  try {
    const parsedSet = parseRevocationSet(readFileSync(sourcePath, "utf8"), sourcePath);
    const revocationsBySubject = buildRevocationsBySubject(parsedSet.revocations);
    return {
      skipped: false,
      mode,
      distributionEnabled: true,
      policyMode,
      sourcePath,
      accepted: true,
      revocationCount: parsedSet.revocations.length,
      warnings: [],
      errors: [],
      revocationsBySubject,
      artifact: parsedSet
    };
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    if (policyMode === "warn") {
      logger.warn({
        event: "intentos_revocation_distribution",
        mode: policyMode,
        diagnostic
      });
      return {
        ...toEmptyResult(mode, true, policyMode, sourcePath),
        skipped: false,
        accepted: false,
        warnings: [diagnostic]
      };
    }
    return {
      ...toEmptyResult(mode, true, policyMode, sourcePath),
      skipped: false,
      accepted: false,
      errors: [diagnostic]
    };
  }
}
