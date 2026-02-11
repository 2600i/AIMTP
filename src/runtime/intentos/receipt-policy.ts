import {
  Receipt,
  ReceiptTrustVersion,
  TrustedReceiptPublicKeys,
  normalizeReceiptTrustVersion,
  parseTrustedReceiptKeysJson,
  verifyReceipt
} from "../../protocol/intentos-receipts";
import { readFileSync } from "node:fs";

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

function parseTrustedReceiptKeysBundle(raw: string): TrustedReceiptPublicKeys {
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

  const normalized: Record<string, string> = {};
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

    let publicKeyPem = "";
    for (const keyEntry of issuerEntry.keys) {
      if (!isPlainObject(keyEntry)) {
        throw new Error(`trust_bundle_key_entry_must_be_object:${issuer}`);
      }
      const candidate = normalizeNonEmptyString(keyEntry.publicKeyPem);
      if (candidate) {
        publicKeyPem = candidate;
        break;
      }
    }

    if (!publicKeyPem) {
      throw new Error(`trust_bundle_missing_public_key_pem:${issuer}`);
    }

    normalized[issuer] = publicKeyPem;
  });

  return Object.freeze(normalized);
}

function loadTrustedReceiptKeysFromBundlePath(bundlePath: string): TrustedReceiptPublicKeys {
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
): { trustedKeys: TrustedReceiptPublicKeys; configError: string | null } {
  if (options.trustedReceiptKeys) {
    return {
      trustedKeys: options.trustedReceiptKeys,
      configError: null
    };
  }

  const bundlePath = normalizeNonEmptyString(
    options.trustBundlePath ?? options.env?.INTENTOS_TRUST_BUNDLE_PATH
  );
  if (bundlePath) {
    try {
      return {
        trustedKeys: loadTrustedReceiptKeysFromBundlePath(bundlePath),
        configError: null
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        trustedKeys: Object.freeze({}),
        configError: message
      };
    }
  }

  const trustedKeysJson =
    options.trustedReceiptKeysJson ?? options.env?.INTENTOS_TRUSTED_RECEIPT_KEYS_JSON;
  try {
    return {
      trustedKeys: parseTrustedReceiptKeysJson(trustedKeysJson),
      configError: null
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      trustedKeys: Object.freeze({}),
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

export function processReceiptEnvelope(
  envelope: unknown,
  options: ProcessReceiptEnvelopeOptions = {}
): ProcessReceiptEnvelopeResult {
  const mode = readMode(options);
  const trustVersion = readTrustVersion(options);
  const maxTimestampSkewSec = readMaxTimestampSkewSec(options);
  const logger = options.logger ?? DEFAULT_POLICY_LOGGER;
  const { trustedKeys, configError } = readTrustedKeys(options);
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

  const verification = verifyReceipt(receipt, trustedKeys, {
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
    warnReceiptPolicy(logger, mode, trustVersion, reason, receipt);
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
