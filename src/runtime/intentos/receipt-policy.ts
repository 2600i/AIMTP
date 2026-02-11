import {
  Receipt,
  ReceiptVerificationResult,
  ReceiptTrustVersion,
  TrustedReceiptPublicKeys,
  normalizeReceiptTrustVersion,
  parseTrustedReceiptKeysJson,
  verifyReceipt
} from "../../protocol/intentos-receipts";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export type ReceiptPolicyMode = "off" | "warn" | "enforce";

export interface ReceiptPolicyLogger {
  warn(event: Readonly<Record<string, unknown>>): void;
}

export interface ProcessReceiptEnvelopeOptions {
  readonly mode?: ReceiptPolicyMode | string;
  readonly trustVersion?: ReceiptTrustVersion | string;
  readonly maxTimestampSkewSec?: number;
  readonly trustBundlePath?: string;
  readonly trustedReceiptKeysJson?: string;
  readonly trustedReceiptKeys?: TrustedReceiptPublicKeys;
  readonly logger?: ReceiptPolicyLogger;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ProcessReceiptEnvelopeResult {
  readonly accepted: boolean;
  readonly trusted: boolean;
  readonly mode: ReceiptPolicyMode;
  readonly trustVersion: ReceiptTrustVersion;
  readonly reason: string;
  readonly receipt: Receipt | null;
}

const DEFAULT_POLICY_MODE: ReceiptPolicyMode = "off";
const DEFAULT_POLICY_LOGGER: ReceiptPolicyLogger = {
  warn(event: Readonly<Record<string, unknown>>): void {
    console.warn(JSON.stringify(event));
  }
};

const EMPTY_TRUSTED_KEYS: TrustedReceiptPublicKeys = Object.freeze({});

interface TrustBundleKey {
  readonly publicKeyPem: string;
  readonly notBefore?: number;
  readonly notAfter?: number;
}

type TrustBundleIssuerKeySet = Readonly<Record<string, ReadonlyArray<TrustBundleKey>>>;

interface TrustedKeyResolution {
  readonly trustedKeys: TrustedReceiptPublicKeys;
  readonly bundleIssuerKeys: TrustBundleIssuerKeySet | null;
  readonly configError: string | null;
}

interface TrustBundleVerificationAttempt {
  readonly index: number;
  readonly fingerprint?: string;
  readonly active: boolean;
  readonly reasonSkipped?: string;
  readonly verifyResult?: string;
}

interface TrustBundleVerificationAttemptReport {
  readonly issuer: string;
  readonly trustVersion: ReceiptTrustVersion;
  readonly evaluationTimeSec: number;
  readonly keysTotal: number;
  readonly keysActive: number;
  readonly attempts: ReadonlyArray<TrustBundleVerificationAttempt>;
}

interface BundleReceiptVerificationResult {
  readonly verification: ReceiptVerificationResult;
  readonly attemptReport: TrustBundleVerificationAttemptReport | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeReceiptPolicyMode(
  value: unknown,
  fallback: ReceiptPolicyMode = DEFAULT_POLICY_MODE
): ReceiptPolicyMode {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "warn" || normalized === "enforce" || normalized === "off") {
    return normalized;
  }
  return fallback;
}

function readMode(options: ProcessReceiptEnvelopeOptions): ReceiptPolicyMode {
  if (options.mode !== undefined) {
    return normalizeReceiptPolicyMode(options.mode);
  }
  return normalizeReceiptPolicyMode(options.env?.INTENTOS_RECEIPT_POLICY);
}

function readTrustVersion(options: ProcessReceiptEnvelopeOptions): ReceiptTrustVersion {
  if (options.trustVersion !== undefined) {
    return normalizeReceiptTrustVersion(options.trustVersion);
  }
  return normalizeReceiptTrustVersion(options.env?.INTENTOS_TRUST_VERSION);
}

function parseOptionalNonNegativeInt(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

function normalizeNonEmptyString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function parseOptionalUnixSeconds(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

function parseTrustedReceiptKeysBundle(raw: string): TrustBundleIssuerKeySet {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid_trust_bundle_json:${message}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error("trust_bundle_must_be_object");
  }

  if (!isPlainObject(parsed.issuers)) {
    throw new Error("trust_bundle_issuers_must_be_object");
  }

  const normalized: Record<string, ReadonlyArray<TrustBundleKey>> = {};
  Object.entries(parsed.issuers).forEach(([issuerId, issuerEntry]) => {
    const issuer = normalizeNonEmptyString(issuerId);
    if (!issuer) {
      throw new Error("trust_bundle_issuer_id_must_be_non_empty_string");
    }
    if (!isPlainObject(issuerEntry)) {
      throw new Error(`trust_bundle_issuer_entry_must_be_object:${issuer}`);
    }
    if (!Array.isArray(issuerEntry.keys)) {
      throw new Error(`trust_bundle_keys_must_be_array:${issuer}`);
    }

    const keys: TrustBundleKey[] = [];
    for (const keyEntry of issuerEntry.keys) {
      if (!isPlainObject(keyEntry)) {
        throw new Error(`trust_bundle_key_entry_must_be_object:${issuer}`);
      }
      const publicKeyPem = normalizeNonEmptyString(keyEntry.publicKeyPem);
      if (!publicKeyPem) {
        continue;
      }

      const hasNotBefore = Object.prototype.hasOwnProperty.call(keyEntry, "notBefore");
      const hasNotAfter = Object.prototype.hasOwnProperty.call(keyEntry, "notAfter");
      const notBefore = hasNotBefore ? parseOptionalUnixSeconds(keyEntry.notBefore) : undefined;
      const notAfter = hasNotAfter ? parseOptionalUnixSeconds(keyEntry.notAfter) : undefined;
      if (hasNotBefore && notBefore === undefined) {
        throw new Error(`trust_bundle_key_not_before_must_be_unix_seconds:${issuer}`);
      }
      if (hasNotAfter && notAfter === undefined) {
        throw new Error(`trust_bundle_key_not_after_must_be_unix_seconds:${issuer}`);
      }
      if (notBefore !== undefined && notAfter !== undefined && notBefore >= notAfter) {
        throw new Error(`trust_bundle_key_window_must_have_notBefore_lt_notAfter:${issuer}`);
      }

      keys.push(
        Object.freeze({
          publicKeyPem,
          ...(notBefore !== undefined ? { notBefore } : {}),
          ...(notAfter !== undefined ? { notAfter } : {})
        })
      );
    }

    if (keys.length === 0) {
      throw new Error(`trust_bundle_missing_public_key_pem:${issuer}`);
    }

    normalized[issuer] = Object.freeze(keys);
  });

  return Object.freeze(normalized);
}

function loadTrustedReceiptKeysFromBundlePath(bundlePath: string): TrustBundleIssuerKeySet {
  let rawBundle = "";
  try {
    rawBundle = readFileSync(bundlePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid_trust_bundle_path:${message}`);
  }
  return parseTrustedReceiptKeysBundle(rawBundle);
}

function readMaxTimestampSkewSec(options: ProcessReceiptEnvelopeOptions): number | undefined {
  if (options.maxTimestampSkewSec !== undefined) {
    return parseOptionalNonNegativeInt(options.maxTimestampSkewSec);
  }
  return parseOptionalNonNegativeInt(options.env?.INTENTOS_TRUST_V2_MAX_TIMESTAMP_SKEW_SEC);
}

function readTrustedKeys(
  options: ProcessReceiptEnvelopeOptions
): TrustedKeyResolution {
  if (options.trustedReceiptKeys) {
    return {
      trustedKeys: options.trustedReceiptKeys,
      bundleIssuerKeys: null,
      configError: null
    };
  }

  const bundlePath = normalizeNonEmptyString(
    options.trustBundlePath ?? options.env?.INTENTOS_TRUST_BUNDLE_PATH
  );
  if (bundlePath) {
    try {
      return {
        trustedKeys: EMPTY_TRUSTED_KEYS,
        bundleIssuerKeys: loadTrustedReceiptKeysFromBundlePath(bundlePath),
        configError: null
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        trustedKeys: EMPTY_TRUSTED_KEYS,
        bundleIssuerKeys: null,
        configError: message
      };
    }
  }

  const trustedKeysJson =
    options.trustedReceiptKeysJson ?? options.env?.INTENTOS_TRUSTED_RECEIPT_KEYS_JSON;
  try {
    return {
      trustedKeys: parseTrustedReceiptKeysJson(trustedKeysJson),
      bundleIssuerKeys: null,
      configError: null
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      trustedKeys: EMPTY_TRUSTED_KEYS,
      bundleIssuerKeys: null,
      configError: message
    };
  }
}

function extractReceiptEnvelope(envelope: unknown): Receipt | null {
  if (!isPlainObject(envelope)) {
    return null;
  }

  const nested = envelope.receipt;
  if (isPlainObject(nested)) {
    return nested as unknown as Receipt;
  }

  if (
    "receiptId" in envelope ||
    "envelopeId" in envelope ||
    "intentId" in envelope ||
    "type" in envelope
  ) {
    return envelope as unknown as Receipt;
  }

  return null;
}

function warnReceiptPolicy(
  logger: ReceiptPolicyLogger,
  mode: ReceiptPolicyMode,
  trustVersion: ReceiptTrustVersion,
  reason: string,
  receipt: Receipt | null
): void {
  logger.warn({
    event: "intentos_receipt_policy_warning",
    mode,
    trust_version: trustVersion,
    reason,
    receipt_id: receipt?.receiptId ?? null,
    envelope_id: receipt?.envelopeId ?? null,
    intent_id: receipt?.intentId ?? null,
    issuer: receipt?.issuer ?? null
  });
}

function summarizeAttemptReasons(
  attempts: ReadonlyArray<TrustBundleVerificationAttempt>,
  limit = 3
): ReadonlyArray<string> {
  const reasons = attempts.flatMap((attempt) => {
    if (attempt.reasonSkipped) {
      return [`key[${attempt.index}]:${attempt.reasonSkipped}`];
    }
    if (attempt.verifyResult) {
      return [`key[${attempt.index}]:${attempt.verifyResult}`];
    }
    return [];
  });
  return reasons.slice(0, limit);
}

function warnBundleVerificationAttempts(
  logger: ReceiptPolicyLogger,
  mode: ReceiptPolicyMode,
  reason: string,
  report: TrustBundleVerificationAttemptReport
): void {
  logger.warn({
    event: "intentos_trust_bundle_verify_attempts",
    mode,
    reason,
    issuer: report.issuer,
    trustVersion: report.trustVersion,
    evaluationTimeSec: report.evaluationTimeSec,
    keysTotal: report.keysTotal,
    keysActive: report.keysActive,
    attemptReasons: summarizeAttemptReasons(report.attempts),
    attempts: report.attempts
  });
}

function resolveReceiptEvaluationTimeSec(receipt: Receipt): number {
  const candidate = parseOptionalUnixSeconds((receipt as { timestamp?: unknown }).timestamp);
  if (candidate !== undefined) {
    return candidate;
  }
  return Date.now() / 1000;
}

function isBundleKeyActiveAtTime(key: TrustBundleKey, timestampSec: number): boolean {
  const hasStarted = key.notBefore === undefined || timestampSec >= key.notBefore;
  const hasNotExpired = key.notAfter === undefined || timestampSec < key.notAfter;
  return hasStarted && hasNotExpired;
}

function normalizePublicKeyPemForFingerprint(publicKeyPem: string): string {
  return publicKeyPem.replace(/\r\n/g, "\n").trim();
}

function computeBundleKeyFingerprint(publicKeyPem: string): string {
  const normalizedPem = normalizePublicKeyPemForFingerprint(publicKeyPem);
  return createHash("sha256").update(normalizedPem).digest("hex").slice(0, 12);
}

function resolveBundleSkipReason(key: TrustBundleKey, evaluationTimeSec: number): string {
  if (key.notBefore !== undefined && evaluationTimeSec < key.notBefore) {
    return "not yet valid";
  }
  if (key.notAfter !== undefined && evaluationTimeSec >= key.notAfter) {
    return "expired";
  }
  return "inactive";
}

function buildBundleAttemptReport(
  issuer: string,
  trustVersion: ReceiptTrustVersion,
  evaluationTimeSec: number,
  issuerKeys: ReadonlyArray<TrustBundleKey>,
  attempts: ReadonlyArray<TrustBundleVerificationAttempt>
): TrustBundleVerificationAttemptReport {
  const keysActive = attempts.filter((attempt) => attempt.active).length;
  return {
    issuer,
    trustVersion,
    evaluationTimeSec,
    keysTotal: issuerKeys.length,
    keysActive,
    attempts
  };
}

function verifyReceiptWithBundleIssuerKeys(
  receipt: Receipt,
  bundleIssuerKeys: TrustBundleIssuerKeySet,
  trustVersion: ReceiptTrustVersion,
  maxTimestampSkewSec: number | undefined
): BundleReceiptVerificationResult {
  const verificationOptions = {
    trustVersion,
    maxTimestampSkewSec: trustVersion === "v2" ? maxTimestampSkewSec : undefined
  };
  const baseline = verifyReceipt(receipt, EMPTY_TRUSTED_KEYS, verificationOptions);
  if (baseline.verified || !baseline.reason.startsWith("untrusted issuer:")) {
    return { verification: baseline, attemptReport: null };
  }

  const issuer = normalizeNonEmptyString(receipt.issuer);
  if (!issuer) {
    return { verification: baseline, attemptReport: null };
  }

  const evaluationTimeSec = resolveReceiptEvaluationTimeSec(receipt);
  const issuerKeys = bundleIssuerKeys[issuer];
  if (!issuerKeys) {
    return {
      verification: {
        verified: false,
        reason: "unknown issuer",
        trustVersion: baseline.trustVersion
      },
      attemptReport: buildBundleAttemptReport(
        issuer,
        baseline.trustVersion,
        evaluationTimeSec,
        [],
        []
      )
    };
  }

  const attempts: TrustBundleVerificationAttempt[] = [];
  let successfulVerification: ReceiptVerificationResult | null = null;
  for (let index = 0; index < issuerKeys.length; index += 1) {
    const key = issuerKeys[index];
    const active = isBundleKeyActiveAtTime(key, evaluationTimeSec);
    const attempt: TrustBundleVerificationAttempt = {
      index,
      fingerprint: computeBundleKeyFingerprint(key.publicKeyPem),
      active
    };

    if (!active) {
      attempts.push({
        ...attempt,
        reasonSkipped: resolveBundleSkipReason(key, evaluationTimeSec)
      });
      continue;
    }

    if (successfulVerification) {
      attempts.push({
        ...attempt,
        reasonSkipped: "skipped after successful verification"
      });
      continue;
    }

    const verifyAttempt = verifyReceipt(receipt, { [issuer]: key.publicKeyPem }, verificationOptions);
    attempts.push({
      ...attempt,
      verifyResult: verifyAttempt.reason
    });
    if (verifyAttempt.verified) {
      successfulVerification = verifyAttempt;
    }
  }

  const attemptReport = buildBundleAttemptReport(
    issuer,
    baseline.trustVersion,
    evaluationTimeSec,
    issuerKeys,
    attempts
  );
  if (successfulVerification) {
    return {
      verification: successfulVerification,
      attemptReport
    };
  }

  if (attemptReport.keysActive === 0) {
    return {
      verification: {
        verified: false,
        reason: "no active key for issuer",
        trustVersion: baseline.trustVersion
      },
      attemptReport
    };
  }

  return {
    verification: {
      verified: false,
      reason: "signature invalid for all active keys",
      trustVersion: baseline.trustVersion
    },
    attemptReport
  };
}

export function processReceiptEnvelope(
  envelope: unknown,
  options: ProcessReceiptEnvelopeOptions = {}
): ProcessReceiptEnvelopeResult {
  const mode = readMode(options);
  const trustVersion = readTrustVersion(options);
  const maxTimestampSkewSec = readMaxTimestampSkewSec(options);
  const logger = options.logger ?? DEFAULT_POLICY_LOGGER;
  const { trustedKeys, bundleIssuerKeys, configError } = readTrustedKeys(options);
  const receipt = extractReceiptEnvelope(envelope);
  if (!receipt) {
    const reason = "missing receipt";
    if (mode === "warn") {
      warnReceiptPolicy(logger, mode, trustVersion, reason, null);
    }
    return {
      accepted: mode !== "enforce",
      trusted: false,
      mode,
      trustVersion,
      reason,
      receipt: null
    };
  }

  const bundleVerification = bundleIssuerKeys
    ? verifyReceiptWithBundleIssuerKeys(receipt, bundleIssuerKeys, trustVersion, maxTimestampSkewSec)
    : null;
  const verification = bundleVerification
    ? bundleVerification.verification
    : verifyReceipt(receipt, trustedKeys, {
      trustVersion,
      maxTimestampSkewSec: trustVersion === "v2" ? maxTimestampSkewSec : undefined
    });
  const reason =
    verification.verified || !configError
      ? verification.reason
      : `${verification.reason}; trusted key config: ${configError}`;

  if (verification.verified) {
    return {
      accepted: true,
      trusted: true,
      mode,
      trustVersion,
      reason,
      receipt
    };
  }

  if (mode === "warn") {
    if (bundleVerification?.attemptReport) {
      warnBundleVerificationAttempts(logger, mode, reason, bundleVerification.attemptReport);
    } else {
      warnReceiptPolicy(logger, mode, trustVersion, reason, receipt);
    }
  }

  return {
    accepted: mode !== "enforce",
    trusted: false,
    mode,
    trustVersion,
    reason,
    receipt
  };
}
