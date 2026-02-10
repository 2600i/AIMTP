import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export type ReceiptType =
  | "receipt.admitted"
  | "receipt.denied"
  | "receipt.completed"
  | "receipt.failed";

export type ReceiptTrustVersion = "v1" | "v2";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
export interface JsonArray extends ReadonlyArray<JsonValue> {}

export type ReceiptMetadata =
  | Readonly<Record<string, never>>
  | Readonly<{ reason: string }>
  | Readonly<{ outputHash: string }>
  | Readonly<{ error: string }>;

// A receipt is a protocol artifact emitted by runtime state transitions.
export interface Receipt {
  readonly receiptId: string;
  readonly envelopeId: string;
  readonly intentId: string;
  readonly type: ReceiptType;
  readonly timestamp: string;
  readonly metadata: ReceiptMetadata;
  readonly trustVersion?: ReceiptTrustVersion;
  readonly issuer?: string;
  readonly sigAlg?: string;
  readonly signature?: string;
}

// A receipt message is routable AIMTP payload for requester-facing delivery.
export interface ReceiptMessage {
  readonly id: string;
  readonly recipient: string;
  readonly createdAtSec: number;
  readonly receipt: Receipt;
  readonly traceId?: string;
}

export interface ReceiptEmitter {
  emit(receipt: Receipt): void;
}

export type TrustedReceiptPublicKeys = Readonly<Record<string, string>>;

export interface ReceiptVerificationResult {
  readonly verified: boolean;
  readonly reason: string;
  readonly trustVersion: ReceiptTrustVersion;
}

export interface ReceiptCanonicalizationOptions {
  readonly trustVersion?: ReceiptTrustVersion | string;
}

export interface SignReceiptOptions extends ReceiptCanonicalizationOptions {}

export interface VerifyReceiptOptions extends ReceiptCanonicalizationOptions {
  readonly maxTimestampSkewSec?: number;
  readonly nowMs?: number;
}

interface CreateReceiptInput {
  readonly envelopeId: string;
  readonly intentId: string;
  readonly type: ReceiptType;
  readonly timestamp?: string;
  readonly metadata: ReceiptMetadata;
  readonly trustVersion?: ReceiptTrustVersion;
}

interface CreateReceiptMessageInput {
  readonly receipt: Receipt;
  readonly requester: string;
  readonly createdAtSec?: number;
  readonly traceId?: string;
}

interface CanonicalReceiptPayloadV1 {
  readonly receiptId: string;
  readonly envelopeId: string;
  readonly intentId: string;
  readonly type: ReceiptType;
  readonly timestamp: string;
  readonly metadata: ReceiptMetadata;
  readonly issuer?: string;
  readonly sigAlg?: string;
}

interface CanonicalReceiptPayloadV2 {
  readonly envelopeId: string;
  readonly intentId: string;
  readonly issuer?: string;
  readonly type: ReceiptType;
  readonly timestamp: string;
  readonly metadata: ReceiptMetadata;
  readonly sigAlg?: string;
  readonly trustVersion: "v2";
}

const DEFAULT_RECEIPT_TRUST_VERSION: ReceiptTrustVersion = "v1";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableStringifyJson(value: unknown): string {
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
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringifyJson(entry)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${stableStringifyJson(value[key])}`);
    return `{${parts.join(",")}}`;
  }
  throw new Error(`unsupported_value_type:${typeof value}`);
}

export function normalizeReceiptTrustVersion(
  value: unknown,
  fallback: ReceiptTrustVersion = DEFAULT_RECEIPT_TRUST_VERSION
): ReceiptTrustVersion {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "v2") {
    return "v2";
  }
  if (normalized === "v1") {
    return "v1";
  }
  return fallback;
}

export function isTerminalReceiptType(type: ReceiptType): boolean {
  return type === "receipt.denied" || type === "receipt.completed" || type === "receipt.failed";
}

function canonicalReceiptPayloadV1(receipt: Receipt): CanonicalReceiptPayloadV1 {
  return {
    receiptId: receipt.receiptId,
    envelopeId: receipt.envelopeId,
    intentId: receipt.intentId,
    type: receipt.type,
    timestamp: receipt.timestamp,
    metadata: receipt.metadata,
    issuer: receipt.issuer,
    sigAlg: receipt.sigAlg
  };
}

function canonicalReceiptPayloadV2(receipt: Receipt): CanonicalReceiptPayloadV2 {
  return {
    envelopeId: receipt.envelopeId,
    intentId: receipt.intentId,
    issuer: receipt.issuer,
    type: receipt.type,
    timestamp: receipt.timestamp,
    metadata: receipt.metadata,
    sigAlg: receipt.sigAlg,
    trustVersion: "v2"
  };
}

function normalizeNonEmptyString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function failVerification(
  reason: string,
  trustVersion: ReceiptTrustVersion
): ReceiptVerificationResult {
  return { verified: false, reason, trustVersion };
}

function parseTimestampMs(timestamp: string): number | null {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function validateTimestampSkew(
  receipt: Receipt,
  options: VerifyReceiptOptions
): string | null {
  const maxTimestampSkewSec = options.maxTimestampSkewSec;
  if (!Number.isFinite(maxTimestampSkewSec) || maxTimestampSkewSec === undefined) {
    return null;
  }
  if (maxTimestampSkewSec < 0) {
    return "invalid maxTimestampSkewSec";
  }
  const timestampMs = parseTimestampMs(receipt.timestamp);
  if (timestampMs === null) {
    return "invalid timestamp";
  }
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) {
    return "invalid nowMs";
  }
  const maxSkewMs = maxTimestampSkewSec * 1000;
  const skewMs = Math.abs(nowMs - timestampMs);
  if (skewMs > maxSkewMs) {
    return `timestamp outside allowed skew: ${maxTimestampSkewSec}s`;
  }
  return null;
}

export function canonicalizeReceiptForSigning(
  receipt: Receipt,
  options: ReceiptCanonicalizationOptions = {}
): Buffer {
  const trustVersion = normalizeReceiptTrustVersion(options.trustVersion ?? receipt.trustVersion);
  const payload =
    trustVersion === "v2" ? canonicalReceiptPayloadV2(receipt) : canonicalReceiptPayloadV1(receipt);
  return Buffer.from(stableStringifyJson(payload), "utf8");
}

export function signReceipt(
  receipt: Receipt,
  privateKeyPem: string,
  issuer: string,
  options: SignReceiptOptions = {}
): Receipt {
  const normalizedIssuer = normalizeNonEmptyString(issuer);
  if (!normalizedIssuer) {
    throw new Error("missing_issuer");
  }

  const normalizedPrivateKeyPem = normalizeNonEmptyString(privateKeyPem);
  if (!normalizedPrivateKeyPem) {
    throw new Error("missing_private_key");
  }

  const trustVersion = normalizeReceiptTrustVersion(options.trustVersion ?? receipt.trustVersion);
  const signable = {
    ...receipt,
    issuer: normalizedIssuer,
    sigAlg: "ed25519" as const,
    trustVersion: trustVersion === "v2" ? ("v2" as const) : undefined,
    signature: undefined
  };
  const payload = canonicalizeReceiptForSigning(signable, { trustVersion });
  const signature = sign(null, payload, createPrivateKey(normalizedPrivateKeyPem)).toString("base64");
  return Object.freeze({
    ...signable,
    signature
  });
}

export function verifyReceipt(
  receipt: Receipt,
  trustedPublicKeys: TrustedReceiptPublicKeys,
  options: VerifyReceiptOptions = {}
): ReceiptVerificationResult {
  const trustVersion = normalizeReceiptTrustVersion(options.trustVersion ?? receipt.trustVersion);
  if (trustVersion === "v2") {
    const timestampFailure = validateTimestampSkew(receipt, options);
    if (timestampFailure) {
      return failVerification(timestampFailure, trustVersion);
    }
  }

  const signature = normalizeNonEmptyString(receipt.signature);
  if (!signature) {
    if (trustVersion === "v2" && isTerminalReceiptType(receipt.type)) {
      return failVerification("missing signature for terminal receipt", trustVersion);
    }
    return failVerification("missing signature", trustVersion);
  }

  const issuer = normalizeNonEmptyString(receipt.issuer);
  if (!issuer) {
    return failVerification("missing issuer", trustVersion);
  }

  const sigAlg = normalizeNonEmptyString(receipt.sigAlg).toLowerCase();
  if (!sigAlg) {
    return failVerification("missing sigAlg", trustVersion);
  }
  if (sigAlg !== "ed25519") {
    return failVerification(`unsupported sigAlg: ${sigAlg}`, trustVersion);
  }

  const publicKeyPem = normalizeNonEmptyString(trustedPublicKeys[issuer]);
  if (!publicKeyPem) {
    return failVerification(`untrusted issuer: ${issuer}`, trustVersion);
  }

  try {
    const trustVersionField = trustVersion === "v2" ? ("v2" as const) : undefined;
    const payload = canonicalizeReceiptForSigning({
      ...receipt,
      issuer,
      sigAlg,
      trustVersion: trustVersionField,
      signature: undefined
    }, { trustVersion });
    const verified = verify(null, payload, createPublicKey(publicKeyPem), Buffer.from(signature, "base64"));
    return verified
      ? { verified: true, reason: "signature valid", trustVersion }
      : failVerification("invalid signature", trustVersion);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failVerification(`verification error: ${message}`, trustVersion);
  }
}

export function parseTrustedReceiptKeysJson(raw: string | undefined): TrustedReceiptPublicKeys {
  const input = typeof raw === "string" ? raw.trim() : "";
  if (!input) {
    return Object.freeze({});
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid_trusted_receipt_keys_json:${message}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error("trusted_receipt_keys_json_must_be_object");
  }

  const normalized: Record<string, string> = {};
  Object.entries(parsed).forEach(([issuer, value]) => {
    const normalizedIssuer = normalizeNonEmptyString(issuer);
    const normalizedPublicKey = normalizeNonEmptyString(value);
    if (!normalizedIssuer || !normalizedPublicKey) {
      return;
    }
    normalized[normalizedIssuer] = normalizedPublicKey;
  });
  return Object.freeze(normalized);
}

export function createReceipt(input: CreateReceiptInput): Receipt {
  const metadata = Object.freeze({ ...input.metadata }) as ReceiptMetadata;
  const trustVersion = normalizeReceiptTrustVersion(input.trustVersion);
  return Object.freeze({
    receiptId: randomUUID(),
    envelopeId: input.envelopeId,
    intentId: input.intentId,
    type: input.type,
    timestamp: input.timestamp ?? new Date().toISOString(),
    metadata,
    ...(trustVersion === "v2" ? { trustVersion } : {})
  });
}

export function createReceiptMessage(input: CreateReceiptMessageInput): ReceiptMessage {
  const requester = input.requester.trim();
  const traceId = input.traceId?.trim();
  return Object.freeze({
    id: `receipt-msg-${input.receipt.receiptId}`,
    recipient: `receipt://${requester}`,
    createdAtSec: input.createdAtSec ?? Math.floor(Date.now() / 1000),
    receipt: input.receipt,
    ...(traceId ? { traceId } : {})
  });
}

export function hashOutput(output: unknown): string {
  const serialized = JSON.stringify(output);
  return createHash("sha256")
    .update(serialized ?? "undefined", "utf8")
    .digest("hex");
}

export function createJsonlReceiptEmitter(filePath: string): ReceiptEmitter {
  const absolutePath = path.resolve(filePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });

  return {
    emit(receipt: Receipt): void {
      appendFileSync(absolutePath, `${JSON.stringify(receipt)}\n`, "utf8");
    }
  };
}
