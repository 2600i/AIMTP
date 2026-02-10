import {
  Receipt,
  TrustedReceiptPublicKeys,
  parseTrustedReceiptKeysJson,
  verifyReceipt
} from "../../protocol/intentos-receipts";

export type ReceiptPolicyMode = "off" | "warn" | "enforce";

export interface ReceiptPolicyLogger {
  warn(event: Readonly<Record<string, unknown>>): void;
}

export interface ProcessReceiptEnvelopeOptions {
  readonly mode?: ReceiptPolicyMode | string;
  readonly trustedReceiptKeysJson?: string;
  readonly trustedReceiptKeys?: TrustedReceiptPublicKeys;
  readonly logger?: ReceiptPolicyLogger;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ProcessReceiptEnvelopeResult {
  readonly accepted: boolean;
  readonly trusted: boolean;
  readonly mode: ReceiptPolicyMode;
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

function readTrustedKeys(
  options: ProcessReceiptEnvelopeOptions
): { trustedKeys: TrustedReceiptPublicKeys; configError: string | null } {
  if (options.trustedReceiptKeys) {
    return {
      trustedKeys: options.trustedReceiptKeys,
      configError: null
    };
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
  reason: string,
  receipt: Receipt | null
): void {
  logger.warn({
    event: "intentos_receipt_policy_warning",
    mode,
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
  const logger = options.logger ?? DEFAULT_POLICY_LOGGER;
  const { trustedKeys, configError } = readTrustedKeys(options);
  const receipt = extractReceiptEnvelope(envelope);
  if (!receipt) {
    const reason = "missing receipt";
    if (mode === "warn") {
      warnReceiptPolicy(logger, mode, reason, null);
    }
    return {
      accepted: mode !== "enforce",
      trusted: false,
      mode,
      reason,
      receipt: null
    };
  }

  const verification = verifyReceipt(receipt, trustedKeys);
  const reason =
    verification.verified || !configError
      ? verification.reason
      : `${verification.reason}; trusted key config: ${configError}`;

  if (verification.verified) {
    return {
      accepted: true,
      trusted: true,
      mode,
      reason,
      receipt
    };
  }

  if (mode === "warn") {
    warnReceiptPolicy(logger, mode, reason, receipt);
  }

  return {
    accepted: mode !== "enforce",
    trusted: false,
    mode,
    reason,
    receipt
  };
}
