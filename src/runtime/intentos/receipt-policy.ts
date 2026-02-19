import {
  Receipt,
  ReceiptVerificationResult,
  ReceiptTrustVersion,
  TrustedReceiptPublicKeys,
  normalizeReceiptTrustVersion,
  parseTrustedReceiptKeysJson,
  verifyReceipt
} from "../../protocol/intentos-receipts";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { createHash, createPublicKey, verify } from "node:crypto";
import {
  appendTransparencyEntry,
  type TransparencyEntryType,
  verifyTransparencyProof,
  verifyTransparencyLog,
  verifyTransparencyLogIncremental
} from "./trust-transparency";
import {
  normalizeTrustDistributionMode,
  resolveTrustDistributionSnapshot,
  type TrustDistributionSnapshot
} from "./trust-distribution";
import {
  evaluateTrustSnapshot,
  type SnapshotPolicyMode,
  type TrustSnapshotCandidate,
  type TrustSnapshotState
} from "./trust-snapshot-policy";
import {
  createTrustSnapshotStoreFromEnv,
  type TrustSnapshotStore
} from "./trust-snapshot-store";
import {
  canonicalizeTrustBundleForSigning,
  computeAppliedSnapshotId,
  computeBundleId,
  computeRevocationsId
} from "./trust-ids";
import {
  applyTrustBundleDeltaToPath,
  validateTrustStateShape
} from "./trust-bundle-delta";

export type ReceiptPolicyMode = "off" | "warn" | "enforce";

export interface ReceiptPolicyLogger {
  warn(event: Readonly<Record<string, unknown>>): void;
}

export interface ProcessReceiptEnvelopeOptions {
  readonly mode?: ReceiptPolicyMode | string;
  readonly trustVersion?: ReceiptTrustVersion | string;
  readonly maxTimestampSkewSec?: number;
  readonly trustBundlePath?: string;
  readonly trustBundleRequireSignature?: boolean | string;
  readonly trustBundleTrustedSignersJson?: string;
  readonly trustBundleSignerAllowlist?: string;
  readonly trustBundleRevocationsJson?: string;
  readonly trustBridgeProofJson?: string;
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
  readonly errorCode?: string;
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
type TrustBundleSignerKeys = Readonly<Record<string, string>>;

interface ParsedTrustBundle {
  readonly bundle: Record<string, unknown>;
  readonly issuerKeys: TrustBundleIssuerKeySet;
  readonly revocations: TrustBundleRevocations;
}

interface TrustBundleSignaturePolicy {
  readonly requireSignature: boolean;
  readonly trustedSigners: TrustBundleSignerKeys;
  readonly signerAllowlist: ReadonlySet<string> | null;
  readonly configError: string | null;
}

interface TrustedKeyResolution {
  readonly trustedKeys: TrustedReceiptPublicKeys;
  readonly bundleIssuerKeys: TrustBundleIssuerKeySet | null;
  readonly bundleRevocations: TrustBundleRevocations | null;
  readonly bundleHash: string | null;
  readonly transparencyLog: TransparencyLogPolicy | null;
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

interface TrustBundleRevocations {
  readonly signers: ReadonlySet<string>;
  readonly issuerKeys: Readonly<Record<string, ReadonlySet<string>>>;
}

export interface BridgeProof {
  readonly issuer: string;
  readonly subject: string;
  readonly subjectPublicKeyPem: string;
  readonly subjectKeyFingerprint?: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly sigAlg: "ed25519";
  readonly signature: string;
}

export interface BridgeProofVerificationResult {
  readonly valid: boolean;
  readonly reason: string;
  readonly issuer?: string;
  readonly subject?: string;
  readonly subjectPublicKeyPem?: string;
}

type TransparencyLogMode = "off" | "append" | "verify";
type TransparencyCheckpointMode = "off" | "append" | "verify";

interface TransparencyLogPolicy {
  readonly mode: TransparencyLogMode;
  readonly path: string;
  readonly checkpointMode: TransparencyCheckpointMode;
  readonly checkpointPublicKeyPem: string;
}

const TRUST_BUNDLE_SIGNATURE_REQUIRED_REASON = "bundle signature required";
const TRUST_BUNDLE_UNKNOWN_SIGNER_REASON = "unknown bundle signer";
const TRUST_BUNDLE_SIGNATURE_INVALID_REASON = "bundle signature invalid";
const TRUST_BUNDLE_SIGNER_NOT_ALLOWED_REASON = "bundle signer not allowed";
const TRUST_BUNDLE_SIGNER_REVOKED_REASON = "bundle signer revoked";
const TRUST_BUNDLE_MALFORMED_REASON = "bundle malformed";
const TRUST_BUNDLE_INVALID_CODE = "TRUST_BUNDLE_INVALID";
const TRUST_ANCHOR_REVOKED_CODE = "TRUST_ANCHOR_REVOKED";
const TRUST_SIGNATURE_INVALID_CODE = "TRUST_SIGNATURE_INVALID";
const TRANSPARENCY_LOG_CHAIN_BROKEN_REASON = "transparency log chain broken";
const MAX_BRIDGE_PROOF_TTL_SEC = 300;
const TRUST_BUNDLE_DELTA_KEYS: ReadonlyArray<string> = Object.freeze([
  "addKeys",
  "revokeKeys",
  "addAnchors",
  "revokeAnchors",
  "removeKeys",
  "removeAnchors"
]);
const EMPTY_TRUST_BUNDLE_REVOCATIONS: TrustBundleRevocations = Object.freeze({
  signers: Object.freeze(new Set<string>()),
  issuerKeys: Object.freeze({})
});
const EMPTY_TRUST_BUNDLE_KEY_REVOCATIONS: ReadonlySet<string> = Object.freeze(new Set<string>());
let currentTrustSnapshotState: TrustSnapshotState | null = null;
let currentTrustSnapshotStore: TrustSnapshotStore | null = null;
let currentTrustSnapshotStorePath = "";

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

function looksLikeBase64(value: string): boolean {
  if (!value) {
    return false;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return false;
  }
  try {
    const roundTrip = Buffer.from(value, "base64").toString("base64");
    const normalize = (input: string): string => input.replace(/=+$/u, "");
    return normalize(roundTrip) === normalize(value);
  } catch {
    return false;
  }
}

function canonicalizeBridgeProofPayload(proof: Omit<BridgeProof, "signature">): Buffer {
  return Buffer.from(
    stableStringifyJson({
      issuer: proof.issuer,
      subject: proof.subject,
      subjectPublicKeyPem: proof.subjectPublicKeyPem,
      subjectKeyFingerprint: proof.subjectKeyFingerprint,
      issuedAt: proof.issuedAt,
      expiresAt: proof.expiresAt,
      sigAlg: proof.sigAlg
    }),
    "utf8"
  );
}

function normalizeBridgeProof(input: unknown): BridgeProof {
  if (!isPlainObject(input)) {
    throw new Error("bridge proof must be object");
  }

  const issuer = normalizeNonEmptyString(input.issuer);
  const subject = normalizeNonEmptyString(input.subject);
  const subjectPublicKeyPemRaw = typeof input.subjectPublicKeyPem === "string"
    ? input.subjectPublicKeyPem
    : "";
  const subjectPublicKeyPem = subjectPublicKeyPemRaw;
  const subjectKeyFingerprint = normalizeNonEmptyString(input.subjectKeyFingerprint).toLowerCase();
  const sigAlg = normalizeNonEmptyString(input.sigAlg).toLowerCase();
  const signature = normalizeNonEmptyString(input.signature);
  const issuedAt = parseOptionalUnixSeconds(input.issuedAt);
  const expiresAt = parseOptionalUnixSeconds(input.expiresAt);

  if (!issuer || !subject || !subjectPublicKeyPem.trim() || !signature) {
    throw new Error("bridge proof missing required fields");
  }
  if (issuedAt === undefined || expiresAt === undefined) {
    throw new Error("bridge proof issuedAt/expiresAt invalid");
  }
  if (!Number.isInteger(issuedAt) || !Number.isInteger(expiresAt)) {
    throw new Error("bridge proof issuedAt/expiresAt must be integer seconds");
  }
  if (expiresAt <= issuedAt) {
    throw new Error("bridge proof expiresAt must be greater than issuedAt");
  }
  if (expiresAt - issuedAt > MAX_BRIDGE_PROOF_TTL_SEC) {
    throw new Error("bridge proof ttl exceeds max");
  }
  if (sigAlg !== "ed25519") {
    throw new Error("bridge proof sigAlg invalid");
  }
  if (!looksLikeBase64(signature)) {
    throw new Error("bridge proof signature malformed");
  }

  const computedFingerprint = computeBundleKeyFingerprint(subjectPublicKeyPem).toLowerCase();
  if (subjectKeyFingerprint && subjectKeyFingerprint !== computedFingerprint) {
    throw new Error("bridge proof subject fingerprint mismatch");
  }

  return {
    issuer,
    subject,
    subjectPublicKeyPem,
    ...(subjectKeyFingerprint ? { subjectKeyFingerprint } : {}),
    issuedAt,
    expiresAt,
    sigAlg: "ed25519",
    signature
  };
}

function resolveBridgeProofInput(options: ProcessReceiptEnvelopeOptions): BridgeProof | null {
  const raw = options.trustBridgeProofJson ?? options.env?.INTENTOS_TRUST_BRIDGE_PROOF_JSON;
  if (raw === undefined) {
    return null;
  }
  if (isPlainObject(raw)) {
    return normalizeBridgeProof(raw);
  }
  const text = normalizeNonEmptyString(raw);
  if (!text) {
    throw new Error("bridge proof json empty");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`bridge proof json invalid:${message}`);
  }
  return normalizeBridgeProof(parsed);
}

function resolveBridgeTrustedKeys(
  trustedKeys: TrustedReceiptPublicKeys,
  bundleIssuerKeys: TrustBundleIssuerKeySet | null
): TrustedReceiptPublicKeys {
  const merged: Record<string, string> = {};
  for (const [issuer, value] of Object.entries(trustedKeys)) {
    const publicKeyPem = normalizeNonEmptyString(value);
    if (publicKeyPem) {
      merged[issuer] = publicKeyPem;
    }
  }
  if (bundleIssuerKeys) {
    for (const [issuer, keys] of Object.entries(bundleIssuerKeys)) {
      if (merged[issuer] || !Array.isArray(keys) || keys.length === 0) {
        continue;
      }
      const publicKeyPem = normalizeNonEmptyString(keys[0].publicKeyPem);
      if (publicKeyPem) {
        merged[issuer] = publicKeyPem;
      }
    }
  }
  return Object.freeze(merged);
}

export function verifyBridgeProof(
  bridgeProof: unknown,
  trustedKeysOfA: TrustedReceiptPublicKeys,
  now: number = Date.now() / 1000
): BridgeProofVerificationResult {
  let normalized: BridgeProof;
  try {
    normalized = normalizeBridgeProof(bridgeProof);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { valid: false, reason: `bridge proof invalid: ${message}` };
  }

  const nowSec = Number.isFinite(now) ? Math.trunc(now) : Math.trunc(Date.now() / 1000);
  if (nowSec < normalized.issuedAt || nowSec >= normalized.expiresAt) {
    return { valid: false, reason: "bridge proof expired" };
  }

  const signerKey = normalizeNonEmptyString(trustedKeysOfA[normalized.issuer]);
  if (!signerKey) {
    return { valid: false, reason: "bridge proof issuer not directly trusted" };
  }

  let signatureValid = false;
  try {
    signatureValid = verify(
      null,
      canonicalizeBridgeProofPayload({
        issuer: normalized.issuer,
        subject: normalized.subject,
        subjectPublicKeyPem: normalized.subjectPublicKeyPem,
        subjectKeyFingerprint: normalized.subjectKeyFingerprint,
        issuedAt: normalized.issuedAt,
        expiresAt: normalized.expiresAt,
        sigAlg: normalized.sigAlg
      }),
      createPublicKey(signerKey),
      Buffer.from(normalized.signature, "base64")
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return { valid: false, reason: "bridge proof signature invalid" };
  }

  return {
    valid: true,
    reason: "bridge proof valid",
    issuer: normalized.issuer,
    subject: normalized.subject,
    subjectPublicKeyPem: normalized.subjectPublicKeyPem
  };
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

function resolveModeForTrustVersion(
  mode: ReceiptPolicyMode,
  trustVersion: ReceiptTrustVersion
): ReceiptPolicyMode {
  return mode;
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

function normalizeBooleanOnOff(value: unknown, fallback = false): boolean {
  const normalized = normalizeNonEmptyString(value).toLowerCase();
  if (normalized === "on") {
    return true;
  }
  if (normalized === "off") {
    return false;
  }
  return fallback;
}

function normalizeTransparencyLogMode(value: unknown): TransparencyLogMode {
  const normalized = normalizeNonEmptyString(value).toLowerCase();
  if (normalized === "append" || normalized === "verify" || normalized === "off") {
    return normalized;
  }
  return "off";
}

function normalizeTransparencyCheckpointMode(value: unknown): TransparencyCheckpointMode {
  const normalized = normalizeNonEmptyString(value).toLowerCase();
  if (normalized === "append" || normalized === "verify" || normalized === "off") {
    return normalized;
  }
  return "off";
}

function normalizeTrustSnapshotPolicyMode(value: unknown): SnapshotPolicyMode {
  const normalized = normalizeNonEmptyString(value).toLowerCase();
  if (normalized === "warn" || normalized === "enforce" || normalized === "off") {
    return normalized;
  }
  return "off";
}

function warnTrustSnapshotStore(
  logger: ReceiptPolicyLogger,
  operation: "load" | "save",
  mode: SnapshotPolicyMode,
  message: string
): void {
  logger.warn({
    event: "intentos_trust_snapshot_store",
    operation,
    mode,
    message
  });
}

function readTransparencyLogPolicy(
  bundlePath: string,
  options: ProcessReceiptEnvelopeOptions,
  logPathOverride?: string
): TransparencyLogPolicy | null {
  if (!bundlePath) {
    return null;
  }
  const logPath = normalizeNonEmptyString(logPathOverride ?? options.env?.INTENTOS_TRANSPARENCY_LOG_PATH);
  if (!logPath) {
    return null;
  }
  return {
    mode: normalizeTransparencyLogMode(options.env?.INTENTOS_TRANSPARENCY_LOG_MODE),
    path: logPath,
    checkpointMode: normalizeTransparencyCheckpointMode(
      options.env?.INTENTOS_TRANSPARENCY_CHECKPOINT_MODE
    ),
    checkpointPublicKeyPem: normalizeNonEmptyString(
      options.env?.INTENTOS_TRANSPARENCY_CHECKPOINT_PUBLIC_KEY
    )
  };
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

function parseTrustedReceiptKeysBundleObject(bundle: Record<string, unknown>): TrustBundleIssuerKeySet {
  if (!isPlainObject(bundle.issuers)) {
    throw new Error("trust_bundle_issuers_must_be_object");
  }

  const normalized: Record<string, ReadonlyArray<TrustBundleKey>> = {};
  Object.entries(bundle.issuers).forEach(([issuerId, issuerEntry]) => {
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

function parseTrustedReceiptKeysBundle(raw: string): ParsedTrustBundle {
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
  validateTrustStateShape(parsed);

  return {
    bundle: parsed,
    issuerKeys: parseTrustedReceiptKeysBundleObject(parsed),
    revocations: parseTrustBundleRevocations(parsed.revocations)
  };
}

function loadTrustedReceiptKeysFromBundlePath(bundlePath: string): ParsedTrustBundle {
  let rawBundle = "";
  try {
    rawBundle = readFileSync(bundlePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid_trust_bundle_path:${message}`);
  }
  return parseTrustedReceiptKeysBundle(rawBundle);
}

function isTrustBundleDeltaPayload(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    return false;
  }
  return TRUST_BUNDLE_DELTA_KEYS.some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function atomicWriteJson(filePath: string, payload: unknown): void {
  const parentDir = path.dirname(filePath);
  mkdirSync(parentDir, { recursive: true });

  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  let tempFd = -1;
  let dirFd = -1;
  try {
    writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });

    tempFd = openSync(tempPath, "r");
    fsyncSync(tempFd);
    closeSync(tempFd);
    tempFd = -1;

    renameSync(tempPath, filePath);
    try {
      dirFd = openSync(parentDir, "r");
      fsyncSync(dirFd);
      closeSync(dirFd);
      dirFd = -1;
    } catch {
      // Best-effort directory fsync.
    }
  } catch (error) {
    if (tempFd !== -1) {
      try {
        closeSync(tempFd);
      } catch {
        // Best-effort cleanup.
      }
    }
    if (dirFd !== -1) {
      try {
        closeSync(dirFd);
      } catch {
        // Best-effort cleanup.
      }
    }
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Best-effort cleanup.
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`trust_bundle_state_write_failed:${message}`);
  }
}

function resolveEffectiveTrustBundlePath(
  sourcePath: string,
  statePath: string,
  env: NodeJS.ProcessEnv,
  nowMs: number
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(sourcePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid_trust_bundle_path:${message}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error("trust_bundle_must_be_object");
  }

  if (isTrustBundleDeltaPayload(parsed)) {
    if (!statePath) {
      throw new Error("trust_bundle_delta_requires_state_path");
    }
    applyTrustBundleDeltaToPath(statePath, parsed, { env, nowMs });
    return statePath;
  }
  validateTrustStateShape(parsed);

  if (!statePath) {
    return sourcePath;
  }

  const resolvedSourcePath = path.resolve(sourcePath);
  const resolvedStatePath = path.resolve(statePath);
  if (resolvedSourcePath === resolvedStatePath) {
    return sourcePath;
  }

  atomicWriteJson(resolvedStatePath, parsed);
  return resolvedStatePath;
}

function parseTrustBundleSignerAllowlist(raw: unknown): ReadonlySet<string> | null {
  const input = normalizeNonEmptyString(raw);
  if (!input) {
    return null;
  }

  const signers = input
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (signers.length === 0) {
    throw new Error("invalid_trust_bundle_signer_allowlist");
  }
  return new Set(signers);
}

function parseTrustBundleTrustedSignersJson(raw: unknown): TrustBundleSignerKeys {
  const input = normalizeNonEmptyString(raw);
  if (!input) {
    return Object.freeze({});
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid_trust_bundle_trusted_signers_json:${message}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error("trust_bundle_trusted_signers_json_must_be_object");
  }

  const normalized: Record<string, string> = {};
  Object.entries(parsed).forEach(([signer, value]) => {
    const normalizedSigner = normalizeNonEmptyString(signer);
    const normalizedPublicKey = normalizeNonEmptyString(value);
    if (!normalizedSigner || !normalizedPublicKey) {
      throw new Error("trust_bundle_trusted_signers_json_entries_must_be_non_empty_strings");
    }
    normalized[normalizedSigner] = normalizedPublicKey;
  });
  return Object.freeze(normalized);
}

function parseTrustBundleRevocations(raw: unknown): TrustBundleRevocations {
  if (raw === undefined) {
    return EMPTY_TRUST_BUNDLE_REVOCATIONS;
  }
  if (!isPlainObject(raw)) {
    throw new Error("trust_bundle_revocations_must_be_object");
  }

  const signers = new Set<string>();
  if (Object.prototype.hasOwnProperty.call(raw, "signers")) {
    if (!Array.isArray(raw.signers)) {
      throw new Error("trust_bundle_revocations_signers_must_be_array");
    }
    for (const signerEntry of raw.signers) {
      const signer = normalizeNonEmptyString(signerEntry);
      if (!signer) {
        throw new Error("trust_bundle_revocations_signers_entries_must_be_non_empty_strings");
      }
      signers.add(signer);
    }
  }

  const issuerKeys: Record<string, ReadonlySet<string>> = {};
  if (Object.prototype.hasOwnProperty.call(raw, "issuerKeys")) {
    if (!isPlainObject(raw.issuerKeys)) {
      throw new Error("trust_bundle_revocations_issuer_keys_must_be_object");
    }
    Object.entries(raw.issuerKeys).forEach(([issuerId, fingerprintsEntry]) => {
      const issuer = normalizeNonEmptyString(issuerId);
      if (!issuer) {
        throw new Error("trust_bundle_revocations_issuer_keys_issuer_must_be_non_empty_string");
      }
      if (!Array.isArray(fingerprintsEntry)) {
        throw new Error("trust_bundle_revocations_issuer_keys_entries_must_be_array");
      }
      const fingerprints = new Set<string>();
      for (const fingerprintEntry of fingerprintsEntry) {
        const fingerprint = normalizeNonEmptyString(fingerprintEntry).toLowerCase();
        if (!fingerprint) {
          throw new Error(
            "trust_bundle_revocations_issuer_keys_fingerprint_must_be_non_empty_string"
          );
        }
        fingerprints.add(fingerprint);
      }
      issuerKeys[issuer] = Object.freeze(fingerprints);
    });
  }

  return Object.freeze({
    signers: Object.freeze(signers),
    issuerKeys: Object.freeze(issuerKeys)
  });
}

function parseTrustBundleRevocationsJson(raw: unknown): TrustBundleRevocations {
  const input = normalizeNonEmptyString(raw);
  if (!input) {
    throw new Error("invalid_trust_bundle_revocations_json:empty");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid_trust_bundle_revocations_json:${message}`);
  }
  return parseTrustBundleRevocations(parsed);
}

function readTrustBundleRevocations(
  parsedBundle: ParsedTrustBundle,
  options: ProcessReceiptEnvelopeOptions,
  revocationsPathOverride?: string
): TrustBundleRevocations {
  const revocationsPath = normalizeNonEmptyString(revocationsPathOverride);
  if (revocationsPath) {
    try {
      const revocationsJson = readFileSync(revocationsPath, "utf8");
      return parseTrustBundleRevocationsJson(revocationsJson);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid_trust_bundle_revocations_path:${message}`);
    }
  }

  const overrideRevocationsJson =
    options.trustBundleRevocationsJson ?? options.env?.INTENTOS_TRUST_BUNDLE_REVOCATIONS_JSON;
  if (overrideRevocationsJson !== undefined) {
    return parseTrustBundleRevocationsJson(overrideRevocationsJson);
  }
  return parsedBundle.revocations;
}

function readTrustBundleSignaturePolicy(
  options: ProcessReceiptEnvelopeOptions,
  strictTrustV2: boolean
): TrustBundleSignaturePolicy {
  const requireSignature = strictTrustV2 || normalizeBooleanOnOff(
    options.trustBundleRequireSignature ?? options.env?.INTENTOS_TRUST_BUNDLE_REQUIRE_SIGNATURE
  );
  if (!requireSignature) {
    return {
      requireSignature,
      trustedSigners: Object.freeze({}),
      signerAllowlist: null,
      configError: null
    };
  }

  try {
    return {
      requireSignature,
      trustedSigners: parseTrustBundleTrustedSignersJson(
        options.trustBundleTrustedSignersJson ?? options.env?.INTENTOS_TRUST_BUNDLE_TRUSTED_SIGNERS_JSON
      ),
      signerAllowlist: parseTrustBundleSignerAllowlist(
        options.trustBundleSignerAllowlist ?? options.env?.INTENTOS_TRUST_BUNDLE_SIGNER_ALLOWLIST
      ),
      configError: null
    };
  } catch {
    return {
      requireSignature,
      trustedSigners: Object.freeze({}),
      signerAllowlist: null,
      configError: TRUST_BUNDLE_MALFORMED_REASON
    };
  }
}

function mapTrustBundleConfigErrorCode(reason: string): string {
  if (
    reason === TRUST_BUNDLE_INVALID_CODE ||
    reason === TRUST_ANCHOR_REVOKED_CODE ||
    reason === TRUST_SIGNATURE_INVALID_CODE
  ) {
    return reason;
  }
  if (
    reason === TRUST_BUNDLE_SIGNATURE_REQUIRED_REASON ||
    reason === TRUST_BUNDLE_UNKNOWN_SIGNER_REASON ||
    reason === TRUST_BUNDLE_SIGNATURE_INVALID_REASON ||
    reason === TRUST_BUNDLE_SIGNER_NOT_ALLOWED_REASON
  ) {
    return TRUST_SIGNATURE_INVALID_CODE;
  }
  if (reason === TRUST_BUNDLE_SIGNER_REVOKED_REASON) {
    return TRUST_ANCHOR_REVOKED_CODE;
  }
  return TRUST_BUNDLE_INVALID_CODE;
}

function verifyTrustBundleSignature(
  bundle: Record<string, unknown>,
  trustedSigners: TrustBundleSignerKeys,
  signerAllowlist: ReadonlySet<string> | null,
  revokedSigners: ReadonlySet<string>
): string | null {
  const bundleVersion = normalizeNonEmptyString(bundle.bundleVersion);
  const bundleId = normalizeNonEmptyString(bundle.bundleId);
  const issuedAtSec =
    typeof bundle.issuedAtSec === "number" && Number.isFinite(bundle.issuedAtSec)
      ? bundle.issuedAtSec
      : undefined;
  const signer = normalizeNonEmptyString(bundle.signer);
  const sigAlg = normalizeNonEmptyString(bundle.sigAlg).toLowerCase();
  const signature = normalizeNonEmptyString(bundle.signature);
  if (!signer || !sigAlg || !signature) {
    return TRUST_BUNDLE_SIGNATURE_REQUIRED_REASON;
  }
  if (revokedSigners.has(signer)) {
    return TRUST_BUNDLE_SIGNER_REVOKED_REASON;
  }
  if (bundleVersion !== "v3" || !bundleId || issuedAtSec === undefined || issuedAtSec < 0) {
    return TRUST_BUNDLE_MALFORMED_REASON;
  }
  if (signerAllowlist && !signerAllowlist.has(signer)) {
    return TRUST_BUNDLE_SIGNER_NOT_ALLOWED_REASON;
  }

  const signerPublicKeyPem = normalizeNonEmptyString(trustedSigners[signer]);
  if (!signerPublicKeyPem) {
    return TRUST_BUNDLE_UNKNOWN_SIGNER_REASON;
  }
  if (sigAlg !== "ed25519") {
    return TRUST_BUNDLE_MALFORMED_REASON;
  }

  try {
    const payload = canonicalizeTrustBundleForSigning(bundle);
    const isValid = verify(
      null,
      payload,
      createPublicKey(signerPublicKeyPem),
      Buffer.from(signature, "base64")
    );
    return isValid ? null : TRUST_BUNDLE_SIGNATURE_INVALID_REASON;
  } catch {
    return TRUST_BUNDLE_MALFORMED_REASON;
  }
}

function readMaxTimestampSkewSec(options: ProcessReceiptEnvelopeOptions): number | undefined {
  if (options.maxTimestampSkewSec !== undefined) {
    return parseOptionalNonNegativeInt(options.maxTimestampSkewSec);
  }
  return parseOptionalNonNegativeInt(options.env?.INTENTOS_TRUST_V2_MAX_TIMESTAMP_SKEW_SEC);
}

function computeTrustBundleHash(bundle: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringifyJson(bundle)).digest("hex");
}

function hasTrustBundleRevocations(revocations: TrustBundleRevocations): boolean {
  if (revocations.signers.size > 0) {
    return true;
  }
  return Object.values(revocations.issuerKeys).some((fingerprints) => fingerprints.size > 0);
}

function summarizeTrustBundleRevocations(revocations: TrustBundleRevocations): string {
  const issuerKeyCount = Object.values(revocations.issuerKeys).reduce(
    (sum, fingerprints) => sum + fingerprints.size,
    0
  );
  return `signers=${revocations.signers.size}; issuerKeys=${issuerKeyCount}`;
}

function canonicalizeTrustBundleRevocationsForId(revocations: TrustBundleRevocations): {
  readonly signers: ReadonlyArray<string>;
  readonly issuerKeys: Readonly<Record<string, ReadonlyArray<string>>>;
} {
  const signers = Array.from(revocations.signers).sort();
  const issuerKeys = Object.fromEntries(
    Object.entries(revocations.issuerKeys)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([issuer, fingerprints]) => [issuer, Array.from(fingerprints).sort()])
  );
  return {
    signers,
    issuerKeys
  };
}

function appendTransparencyPolicyEvent(
  transparencyLog: TransparencyLogPolicy | null,
  type: TransparencyEntryType,
  bundleHash?: string,
  reason?: string
): void {
  if (!transparencyLog || transparencyLog.mode !== "append") {
    return;
  }
  try {
    appendTransparencyEntry(
      {
        timestamp: new Date().toISOString(),
        type,
        ...(bundleHash ? { bundleHash } : {}),
        ...(reason ? { reason } : {})
      },
      { path: transparencyLog.path }
    );
  } catch {
    // Transparency logging is best-effort and must not alter receipt policy decisions.
  }
}

function readTrustedKeys(
  options: ProcessReceiptEnvelopeOptions,
  trustVersion: ReceiptTrustVersion
): TrustedKeyResolution {
  const strictTrustV2 = trustVersion === "v2";
  if (options.trustedReceiptKeys) {
    return {
      trustedKeys: options.trustedReceiptKeys,
      bundleIssuerKeys: null,
      bundleRevocations: null,
      bundleHash: null,
      transparencyLog: null,
      configError: null
    };
  }

  let distributionSnapshot: TrustDistributionSnapshot | null = null;
  const distributionMode = normalizeTrustDistributionMode(options.env?.INTENTOS_TRUST_DISTRIBUTION);
  if (distributionMode !== "off") {
    try {
      distributionSnapshot = resolveTrustDistributionSnapshot(options.env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        trustedKeys: EMPTY_TRUSTED_KEYS,
        bundleIssuerKeys: null,
        bundleRevocations: null,
        bundleHash: null,
        transparencyLog: null,
        configError: message
      };
    }
  }

  const configuredBundleStatePath = normalizeNonEmptyString(
    options.trustBundlePath ?? options.env?.INTENTOS_TRUST_BUNDLE_PATH
  );
  let bundlePath = normalizeNonEmptyString(
    distributionSnapshot?.bundlePath ?? configuredBundleStatePath
  );
  const transparencyLog = readTransparencyLogPolicy(
    bundlePath,
    options,
    distributionSnapshot?.transparencyLogPath
  );
  const logger = options.logger ?? DEFAULT_POLICY_LOGGER;
  const snapshotPolicyMode = normalizeTrustSnapshotPolicyMode(options.env?.INTENTOS_TRUST_SNAPSHOT_POLICY);
  const snapshotStorePath = normalizeNonEmptyString(options.env?.INTENTOS_TRUST_SNAPSHOT_STATE_PATH);
  if (snapshotStorePath) {
    if (!currentTrustSnapshotStore || currentTrustSnapshotStorePath !== snapshotStorePath) {
      currentTrustSnapshotStore = createTrustSnapshotStoreFromEnv(options.env);
      currentTrustSnapshotStorePath = snapshotStorePath;
      try {
        const loadedState = currentTrustSnapshotStore?.load() ?? null;
        currentTrustSnapshotState = loadedState;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnTrustSnapshotStore(logger, "load", snapshotPolicyMode, message);
      }
    }
  }
  let snapshotCandidate: TrustSnapshotCandidate | null = null;
  const commitSnapshotCandidate = (): string | null => {
    if (!snapshotCandidate?.transparencyHead) {
      return null;
    }

    const nextState: TrustSnapshotState = {
      transparencyHead: snapshotCandidate.transparencyHead,
      ...(snapshotCandidate.bundleId ? { bundleId: snapshotCandidate.bundleId } : {}),
      ...(snapshotCandidate.appliedSnapshotId
        ? { appliedSnapshotId: snapshotCandidate.appliedSnapshotId }
        : {}),
      ...(typeof snapshotCandidate.fetchedAtMs === "number"
        ? { fetchedAtMs: snapshotCandidate.fetchedAtMs }
        : {}),
      ...(snapshotCandidate.source ? { source: snapshotCandidate.source } : {})
    };
    const previousState = currentTrustSnapshotState;
    currentTrustSnapshotState = nextState;

    if (!currentTrustSnapshotStore || !snapshotStorePath) {
      return null;
    }

    try {
      currentTrustSnapshotStore.save(nextState);
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      currentTrustSnapshotState = previousState;
      warnTrustSnapshotStore(logger, "save", snapshotPolicyMode, message);
      if (snapshotPolicyMode === "enforce") {
        return `trust snapshot state save failed: ${message}`;
      }
      return null;
    }
    return null;
  };
  if (distributionMode !== "off" && distributionSnapshot) {
    snapshotCandidate = {
      ...(distributionSnapshot.transparencyHead
        ? { transparencyHead: distributionSnapshot.transparencyHead }
        : {}),
      source: `${distributionMode}:${distributionSnapshot.bundlePath ?? bundlePath ?? "none"}`,
      fetchedAtMs: Date.now()
    };
    const evaluation = evaluateTrustSnapshot(currentTrustSnapshotState, snapshotCandidate, snapshotPolicyMode);
    if (evaluation.reason) {
      logger.warn({
        event: "intentos_trust_snapshot_policy",
        mode: snapshotPolicyMode,
        decision: evaluation.decision,
        reason: evaluation.reason,
        relation: evaluation.relation,
        current: currentTrustSnapshotState ?? null,
        next: snapshotCandidate
      });
    }
    if (evaluation.decision === "reject") {
      return {
        trustedKeys: EMPTY_TRUSTED_KEYS,
        bundleIssuerKeys: null,
        bundleRevocations: null,
        bundleHash: null,
        transparencyLog,
        configError: `trust snapshot policy rejected: ${evaluation.reason ?? "snapshot_rejected"}`
      };
    }
  }

  if (distributionSnapshot?.bundlePath) {
    try {
      bundlePath = resolveEffectiveTrustBundlePath(
        distributionSnapshot.bundlePath,
        configuredBundleStatePath,
        options.env ?? {},
        Date.now()
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        trustedKeys: EMPTY_TRUSTED_KEYS,
        bundleIssuerKeys: null,
        bundleRevocations: null,
        bundleHash: null,
        transparencyLog,
        configError: strictTrustV2 ? TRUST_BUNDLE_INVALID_CODE : message
      };
    }
  }

  if (bundlePath) {
    if (transparencyLog?.mode === "verify") {
      const checkpointVerificationEnabled =
        transparencyLog.checkpointMode === "verify" && transparencyLog.checkpointPublicKeyPem.length > 0;
      const transparencyProof = distributionSnapshot?.transparencyProof;
      if (checkpointVerificationEnabled && transparencyProof) {
        const verification = verifyTransparencyProof(transparencyProof, {
          checkpointPublicKeyPem: transparencyLog.checkpointPublicKeyPem
        });
        if (!verification.ok) {
          return {
            trustedKeys: EMPTY_TRUSTED_KEYS,
            bundleIssuerKeys: null,
            bundleRevocations: null,
            bundleHash: null,
            transparencyLog,
            configError: `${TRANSPARENCY_LOG_CHAIN_BROKEN_REASON} at entry ${verification.brokenAt ?? 1}`
          };
        }
      } else {
        const verification = checkpointVerificationEnabled
          ? verifyTransparencyLogIncremental(transparencyLog.path, {
            checkpointPublicKeyPem: transparencyLog.checkpointPublicKeyPem
          })
          : verifyTransparencyLog(transparencyLog.path);
        if (!verification.valid) {
          return {
            trustedKeys: EMPTY_TRUSTED_KEYS,
            bundleIssuerKeys: null,
            bundleRevocations: null,
            bundleHash: null,
            transparencyLog,
            configError: `${TRANSPARENCY_LOG_CHAIN_BROKEN_REASON} at entry ${verification.brokenAt ?? 1}`
          };
        }
      }
    }

    const signaturePolicy = readTrustBundleSignaturePolicy(options, strictTrustV2);
    if (signaturePolicy.configError) {
      appendTransparencyPolicyEvent(transparencyLog, "bundle_rejected", undefined, signaturePolicy.configError);
      return {
        trustedKeys: EMPTY_TRUSTED_KEYS,
        bundleIssuerKeys: null,
        bundleRevocations: null,
        bundleHash: null,
        transparencyLog,
        configError: strictTrustV2
          ? mapTrustBundleConfigErrorCode(signaturePolicy.configError)
          : signaturePolicy.configError
      };
    }

    try {
      const parsedBundle = loadTrustedReceiptKeysFromBundlePath(bundlePath);
      const bundleHash = computeTrustBundleHash(parsedBundle.bundle);
      const bundleRevocations = readTrustBundleRevocations(
        parsedBundle,
        options,
        distributionSnapshot?.revocationsPath
      );
      if (signaturePolicy.requireSignature) {
        const signatureError = verifyTrustBundleSignature(
          parsedBundle.bundle,
          signaturePolicy.trustedSigners,
          signaturePolicy.signerAllowlist,
          bundleRevocations.signers
        );
        if (signatureError) {
          appendTransparencyPolicyEvent(transparencyLog, "bundle_rejected", bundleHash, signatureError);
          return {
            trustedKeys: EMPTY_TRUSTED_KEYS,
            bundleIssuerKeys: null,
            bundleRevocations: null,
            bundleHash,
            transparencyLog,
            configError: strictTrustV2 ? mapTrustBundleConfigErrorCode(signatureError) : signatureError
          };
        }
      }

      const revocationsOverrideJson = normalizeNonEmptyString(
        options.trustBundleRevocationsJson ?? options.env?.INTENTOS_TRUST_BUNDLE_REVOCATIONS_JSON
      );
      const revocationsPresent =
        Boolean(revocationsOverrideJson) ||
        Boolean(distributionSnapshot?.revocationsPath) ||
        parsedBundle.bundle.revocations !== undefined;
      const bundleId = computeBundleId(parsedBundle.bundle);
      const revocationsId = revocationsPresent
        ? computeRevocationsId(canonicalizeTrustBundleRevocationsForId(bundleRevocations))
        : undefined;
      const appliedHead = distributionSnapshot?.transparencyHead;
      const appliedSnapshotId = computeAppliedSnapshotId({
        bundleId,
        ...(revocationsId ? { revocationsId } : {}),
        ...(appliedHead ? { transparencyHead: appliedHead } : {})
      });
      if (distributionMode !== "off" && distributionSnapshot && snapshotCandidate) {
        snapshotCandidate = {
          ...snapshotCandidate,
          bundleId,
          appliedSnapshotId
        };
      }

      appendTransparencyPolicyEvent(transparencyLog, "bundle_loaded", bundleHash);
      if (hasTrustBundleRevocations(bundleRevocations)) {
        appendTransparencyPolicyEvent(
          transparencyLog,
          "revocation_applied",
          bundleHash,
          summarizeTrustBundleRevocations(bundleRevocations)
        );
      }

      const snapshotCommitError = commitSnapshotCandidate();
      if (snapshotCommitError) {
        return {
          trustedKeys: EMPTY_TRUSTED_KEYS,
          bundleIssuerKeys: null,
          bundleRevocations: null,
          bundleHash,
          transparencyLog,
          configError: snapshotCommitError
        };
      }
      if (distributionMode !== "off" && distributionSnapshot) {
        logger.warn({
          event: "intentos_trust_snapshot_applied",
          mode: distributionMode,
          bundleId,
          revocationsId: revocationsId ?? null,
          appliedSnapshotId,
          head: appliedHead ?? null,
          source: snapshotCandidate?.source ?? null
        });
      }
      return {
        trustedKeys: EMPTY_TRUSTED_KEYS,
        bundleIssuerKeys: parsedBundle.issuerKeys,
        bundleRevocations,
        bundleHash,
        transparencyLog,
        configError: null
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendTransparencyPolicyEvent(transparencyLog, "bundle_rejected", undefined, message);
      return {
        trustedKeys: EMPTY_TRUSTED_KEYS,
        bundleIssuerKeys: null,
        bundleRevocations: null,
        bundleHash: null,
        transparencyLog,
        configError: strictTrustV2
          ? TRUST_BUNDLE_INVALID_CODE
          : signaturePolicy.requireSignature
            ? TRUST_BUNDLE_MALFORMED_REASON
            : message
      };
    }
  }

  const trustedKeysJson =
    options.trustedReceiptKeysJson ?? options.env?.INTENTOS_TRUSTED_RECEIPT_KEYS_JSON;
  try {
    const parsedTrustedKeys = parseTrustedReceiptKeysJson(trustedKeysJson);
    const snapshotCommitError = commitSnapshotCandidate();
    if (snapshotCommitError) {
      return {
        trustedKeys: EMPTY_TRUSTED_KEYS,
        bundleIssuerKeys: null,
        bundleRevocations: null,
        bundleHash: null,
        transparencyLog: null,
        configError: snapshotCommitError
      };
    }
    return {
      trustedKeys: parsedTrustedKeys,
      bundleIssuerKeys: null,
      bundleRevocations: null,
      bundleHash: null,
      transparencyLog: null,
      configError: null
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      trustedKeys: EMPTY_TRUSTED_KEYS,
      bundleIssuerKeys: null,
      bundleRevocations: null,
      bundleHash: null,
      transparencyLog: null,
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

function resolveStrictTrustErrorCode(
  reason: string,
  configError: string | null,
  attemptReport: TrustBundleVerificationAttemptReport | null
): string | undefined {
  if (configError) {
    return mapTrustBundleConfigErrorCode(configError);
  }

  const normalizedReason = reason.toLowerCase();
  if (
    normalizedReason.includes("missing signature") ||
    normalizedReason.includes("invalid signature") ||
    normalizedReason.includes("signature invalid")
  ) {
    return TRUST_SIGNATURE_INVALID_CODE;
  }
  if (
    normalizedReason.includes("bridge proof expired") ||
    normalizedReason.includes("bridge proof issuer not directly trusted") ||
    normalizedReason.includes("bridge proof subject mismatch")
  ) {
    return TRUST_BUNDLE_INVALID_CODE;
  }

  if (attemptReport) {
    if (attemptReport.attempts.some((attempt) => attempt.reasonSkipped === "revoked")) {
      return TRUST_ANCHOR_REVOKED_CODE;
    }
    if (attemptReport.attempts.some((attempt) => attempt.reasonSkipped === "expired")) {
      return TRUST_BUNDLE_INVALID_CODE;
    }
  }

  if (normalizedReason.includes("no active key for issuer")) {
    return TRUST_BUNDLE_INVALID_CODE;
  }

  return undefined;
}

function verifyReceiptWithBundleIssuerKeys(
  receipt: Receipt,
  bundleIssuerKeys: TrustBundleIssuerKeySet,
  bundleRevocations: TrustBundleRevocations,
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
  const revokedIssuerKeys = bundleRevocations.issuerKeys[issuer] ?? EMPTY_TRUST_BUNDLE_KEY_REVOCATIONS;
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
    const fingerprint = computeBundleKeyFingerprint(key.publicKeyPem);
    const revoked = revokedIssuerKeys.has(fingerprint);
    const active = !revoked && isBundleKeyActiveAtTime(key, evaluationTimeSec);
    const attempt: TrustBundleVerificationAttempt = {
      index,
      fingerprint,
      active
    };

    if (!active) {
      attempts.push({
        ...attempt,
        reasonSkipped: revoked ? "revoked" : resolveBundleSkipReason(key, evaluationTimeSec)
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
  const trustVersion = readTrustVersion(options);
  const mode = resolveModeForTrustVersion(readMode(options), trustVersion);
  const failClosed = trustVersion === "v2";
  const maxTimestampSkewSec = readMaxTimestampSkewSec(options);
  const logger = options.logger ?? DEFAULT_POLICY_LOGGER;
  const { trustedKeys, bundleIssuerKeys, bundleRevocations, bundleHash, transparencyLog, configError } =
    readTrustedKeys(options, trustVersion);
  const receipt = extractReceiptEnvelope(envelope);
  if (!receipt) {
    const reason = "missing receipt";
    if (mode === "warn") {
      warnReceiptPolicy(logger, mode, trustVersion, reason, null);
    }
    if (mode === "enforce") {
      appendTransparencyPolicyEvent(transparencyLog, "policy_reject", bundleHash ?? undefined, reason);
    }
    return {
      accepted: failClosed ? false : mode !== "enforce",
      trusted: false,
      mode,
      trustVersion,
      reason,
      receipt: null,
      ...(trustVersion === "v2" ? { errorCode: TRUST_BUNDLE_INVALID_CODE } : {})
    };
  }

  const bundleVerification = bundleIssuerKeys
    ? verifyReceiptWithBundleIssuerKeys(
      receipt,
      bundleIssuerKeys,
      bundleRevocations ?? EMPTY_TRUST_BUNDLE_REVOCATIONS,
      trustVersion,
      maxTimestampSkewSec
    )
    : null;
  const verification = bundleVerification
    ? bundleVerification.verification
    : verifyReceipt(receipt, trustedKeys, {
      trustVersion,
      maxTimestampSkewSec: trustVersion === "v2" ? maxTimestampSkewSec : undefined
    });
  let effectiveVerification = verification;
  let bridgeProofFailureReason: string | null = null;

  if (trustVersion === "v2" && !verification.verified) {
    try {
      const bridgeProof = resolveBridgeProofInput(options);
      if (bridgeProof) {
        const bridgeResult = verifyBridgeProof(
          bridgeProof,
          resolveBridgeTrustedKeys(trustedKeys, bundleIssuerKeys),
          Date.now() / 1000
        );
        if (!bridgeResult.valid) {
          bridgeProofFailureReason = bridgeResult.reason;
        } else if (bridgeResult.subject !== normalizeNonEmptyString(receipt.issuer)) {
          bridgeProofFailureReason = "bridge proof subject mismatch";
        } else {
          const bridgeVerification = verifyReceipt(
            receipt,
            {
              [bridgeResult.subject!]: bridgeResult.subjectPublicKeyPem!
            },
            {
              trustVersion,
              maxTimestampSkewSec: trustVersion === "v2" ? maxTimestampSkewSec : undefined
            }
          );
          if (bridgeVerification.verified) {
            effectiveVerification = {
              ...bridgeVerification,
              reason: `${bridgeVerification.reason}; bridge proof valid`
            };
          } else {
            bridgeProofFailureReason = "bridge proof subject signature invalid";
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      bridgeProofFailureReason = `bridge proof invalid: ${message}`;
    }
  }

  const resolvedReason = bridgeProofFailureReason ?? effectiveVerification.reason;
  const reason =
    effectiveVerification.verified || !configError
      ? resolvedReason
      : `${resolvedReason}; trusted key config: ${configError}`;
  const strictErrorCode =
    trustVersion === "v2" && !effectiveVerification.verified
      ? resolveStrictTrustErrorCode(reason, configError, bundleVerification?.attemptReport ?? null)
      : undefined;

  if (effectiveVerification.verified) {
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

  if (mode === "enforce") {
    appendTransparencyPolicyEvent(transparencyLog, "policy_reject", bundleHash ?? undefined, reason);
  }

  return {
    accepted: failClosed ? false : mode !== "enforce",
    trusted: false,
    mode,
    trustVersion,
    reason,
    receipt,
    ...(strictErrorCode ? { errorCode: strictErrorCode } : {})
  };
}
