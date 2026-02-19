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
import { createHash } from "node:crypto";
import {
  TRUST_ANCHOR_REVOKED,
  TRUST_BUNDLE_INVALID,
  TRUST_SIGNATURE_INVALID
} from "./trust-bundle-apply";

interface TrustBundleKeyEntry {
  readonly kid?: string;
  readonly alg?: string;
  readonly publicKeyPem: string;
  readonly notBefore?: number;
  readonly notAfter?: number;
}

interface TrustBundleAnchorEntry {
  readonly anchorId: string;
  readonly peerId: string;
  readonly publicKeyPem: string;
  readonly timestamp: string;
  readonly alg?: string;
  readonly kid?: string;
  readonly signature?: string;
}

interface TrustBundleRevocationsModel {
  signers: string[];
  issuerKeys: Record<string, string[]>;
  anchors: string[];
  keys: string[];
}

interface TrustBundleModel {
  readonly issuers: Record<string, { readonly keys: TrustBundleKeyEntry[] }>;
  readonly anchors: TrustBundleAnchorEntry[];
  readonly revocations: TrustBundleRevocationsModel;
  readonly extra: Record<string, unknown>;
}

interface TrustBundleDeltaAddKeyEntry {
  readonly issuer: string;
  readonly key: TrustBundleKeyEntry;
}

interface TrustBundleDeltaRevokeKeyEntry {
  readonly issuer: string;
  readonly kid?: string;
  readonly fingerprint?: string;
  readonly publicKeyPem?: string;
}

interface TrustBundleDeltaRevokeAnchorEntry {
  readonly anchorId?: string;
  readonly fingerprint?: string;
  readonly publicKeyPem?: string;
}

interface TrustBundleDeltaRevocationsPatch {
  readonly addSigners: string[];
  readonly removeSigners: string[];
  readonly addIssuerKeys: Record<string, string[]>;
  readonly removeIssuerKeys: Record<string, string[]>;
  readonly addAnchors: string[];
  readonly removeAnchors: string[];
  readonly addKeys: string[];
  readonly removeKeys: string[];
}

interface TrustBundleDeltaModel {
  readonly version: "v1";
  readonly addKeys: TrustBundleDeltaAddKeyEntry[];
  readonly revokeKeys: TrustBundleDeltaRevokeKeyEntry[];
  readonly addAnchors: TrustBundleAnchorEntry[];
  readonly revokeAnchors: TrustBundleDeltaRevokeAnchorEntry[];
  readonly applyRevocations: TrustBundleDeltaRevocationsPatch;
}

interface TrustBundleDeltaApplyOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly nowMs?: number;
}

export interface ApplyTrustBundleDeltaResult {
  readonly applied: true;
  readonly pathWritten: string;
  readonly bundle: Readonly<Record<string, unknown>>;
}

function normalizeNonEmptyString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizeTrustVersion(value: unknown): "v1" | "v2" {
  return normalizeNonEmptyString(value).toLowerCase() === "v2" ? "v2" : "v1";
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

function resolveTimestamp(nowMs?: number): number {
  if (typeof nowMs === "number" && Number.isFinite(nowMs) && nowMs >= 0) {
    return Math.trunc(nowMs);
  }
  return Date.now();
}

function resolveIdentityTimestampSkewSec(env: NodeJS.ProcessEnv): number {
  return parseOptionalNonNegativeInt(env.INTENTOS_IDENTITY_MAX_TIMESTAMP_SKEW_SEC) ?? 300;
}

function throwTrustError(code: string, detail: string): never {
  throw new Error(`${code}:${detail}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function computeBundleKeyFingerprint(publicKeyPem: string): string {
  const normalizedPem = publicKeyPem.replace(/\r\n/g, "\n").trim();
  return createHash("sha256").update(normalizedPem).digest("hex").slice(0, 12);
}

function computeAnchorFingerprint(publicKeyPem: string): string {
  return `sha256:${createHash("sha256").update(publicKeyPem, "utf8").digest("hex")}`;
}

function parseStringArray(value: unknown, code: string, lowerCase = false): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throwTrustError(TRUST_BUNDLE_INVALID, code);
  }
  const output: string[] = [];
  for (const entry of value) {
    const normalized = normalizeNonEmptyString(entry);
    if (!normalized) {
      throwTrustError(TRUST_BUNDLE_INVALID, code);
    }
    output.push(lowerCase ? normalized.toLowerCase() : normalized);
  }
  return output;
}

function parseUnixSeconds(value: unknown, code: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || (value as number) < 0) {
    throwTrustError(TRUST_BUNDLE_INVALID, code);
  }
  return value as number;
}

function parseBundleKey(raw: unknown, codePrefix: string): TrustBundleKeyEntry {
  if (!isPlainObject(raw)) {
    throwTrustError(TRUST_BUNDLE_INVALID, `${codePrefix}_must_be_object`);
  }
  const publicKeyPem = normalizeNonEmptyString(raw.publicKeyPem);
  if (!publicKeyPem) {
    throwTrustError(TRUST_BUNDLE_INVALID, `${codePrefix}_public_key_missing`);
  }
  const kid = normalizeNonEmptyString(raw.kid);
  const alg = normalizeNonEmptyString(raw.alg).toLowerCase();
  const notBefore = parseUnixSeconds(raw.notBefore, `${codePrefix}_not_before_invalid`);
  const notAfter = parseUnixSeconds(raw.notAfter, `${codePrefix}_not_after_invalid`);
  if (notBefore !== undefined && notAfter !== undefined && notBefore >= notAfter) {
    throwTrustError(TRUST_BUNDLE_INVALID, `${codePrefix}_window_invalid`);
  }
  if (alg && alg !== "ed25519") {
    throwTrustError(TRUST_BUNDLE_INVALID, `${codePrefix}_alg_invalid`);
  }
  return {
    ...(kid ? { kid } : {}),
    ...(alg ? { alg: "ed25519" } : {}),
    publicKeyPem,
    ...(notBefore !== undefined ? { notBefore } : {}),
    ...(notAfter !== undefined ? { notAfter } : {})
  };
}

function parseAnchor(raw: unknown, codePrefix: string): TrustBundleAnchorEntry {
  if (!isPlainObject(raw)) {
    throwTrustError(TRUST_BUNDLE_INVALID, `${codePrefix}_must_be_object`);
  }
  const anchorId = normalizeNonEmptyString(raw.anchorId);
  const peerId = normalizeNonEmptyString(raw.peerId);
  const publicKeyPem = normalizeNonEmptyString(raw.publicKeyPem);
  const timestamp = normalizeNonEmptyString(raw.timestamp);
  if (!anchorId || !peerId || !publicKeyPem || !timestamp) {
    throwTrustError(TRUST_BUNDLE_INVALID, `${codePrefix}_required_fields_missing`);
  }
  const alg = normalizeNonEmptyString(raw.alg).toLowerCase();
  if (alg && alg !== "ed25519") {
    throwTrustError(TRUST_BUNDLE_INVALID, `${codePrefix}_alg_invalid`);
  }
  const kid = normalizeNonEmptyString(raw.kid);
  const signature = normalizeNonEmptyString(raw.signature);
  return {
    anchorId,
    peerId,
    publicKeyPem,
    timestamp,
    ...(alg ? { alg: "ed25519" } : {}),
    ...(kid ? { kid } : {}),
    ...(signature ? { signature } : {})
  };
}

function parseIssuerKeyRevocations(value: unknown, code: string): Record<string, string[]> {
  if (value === undefined) {
    return {};
  }
  if (!isPlainObject(value)) {
    throwTrustError(TRUST_BUNDLE_INVALID, code);
  }
  const output: Record<string, string[]> = {};
  for (const [issuerRaw, fingerprintsRaw] of Object.entries(value)) {
    const issuer = normalizeNonEmptyString(issuerRaw);
    if (!issuer || !Array.isArray(fingerprintsRaw)) {
      throwTrustError(TRUST_BUNDLE_INVALID, code);
    }
    output[issuer] = parseStringArray(fingerprintsRaw, code, true);
  }
  return output;
}

function parseRevocations(raw: unknown): TrustBundleRevocationsModel {
  if (raw === undefined) {
    return {
      signers: [],
      issuerKeys: {},
      anchors: [],
      keys: []
    };
  }
  if (!isPlainObject(raw)) {
    throwTrustError(TRUST_BUNDLE_INVALID, "delta_revocations_must_be_object");
  }
  return {
    signers: parseStringArray(raw.signers, "delta_revocation_signers_invalid"),
    issuerKeys: parseIssuerKeyRevocations(raw.issuerKeys, "delta_revocation_issuer_keys_invalid"),
    anchors: parseStringArray(raw.anchors, "delta_revocation_anchors_invalid"),
    keys: parseStringArray(raw.keys, "delta_revocation_keys_invalid", true)
  };
}

function parseBundle(raw: unknown): TrustBundleModel {
  if (!isPlainObject(raw)) {
    throwTrustError(TRUST_BUNDLE_INVALID, "delta_bundle_must_be_object");
  }
  if (!isPlainObject(raw.issuers)) {
    throwTrustError(TRUST_BUNDLE_INVALID, "delta_bundle_issuers_missing");
  }

  const issuers: Record<string, { keys: TrustBundleKeyEntry[] }> = {};
  for (const [issuerRaw, issuerEntryRaw] of Object.entries(raw.issuers)) {
    const issuer = normalizeNonEmptyString(issuerRaw);
    if (!issuer || !isPlainObject(issuerEntryRaw) || !Array.isArray(issuerEntryRaw.keys)) {
      throwTrustError(TRUST_BUNDLE_INVALID, "delta_bundle_issuer_invalid");
    }
    const keys = issuerEntryRaw.keys.map((entry, index) =>
      parseBundleKey(entry, `delta_bundle_key_${issuer}_${index}`)
    );
    if (keys.length === 0) {
      throwTrustError(TRUST_BUNDLE_INVALID, "delta_bundle_issuer_keys_empty");
    }
    issuers[issuer] = { keys };
  }

  const anchors: TrustBundleAnchorEntry[] = Array.isArray(raw.anchors)
    ? raw.anchors.map((entry, index) => parseAnchor(entry, `delta_bundle_anchor_${index}`))
    : [];
  const revocations = parseRevocations(raw.revocations);
  const { issuers: _discardIssuers, anchors: _discardAnchors, revocations: _discardRevocations, ...extra } = raw;
  return {
    issuers,
    anchors,
    revocations,
    extra
  };
}

function parseDeltaAddKeyEntry(raw: unknown, index: number): TrustBundleDeltaAddKeyEntry {
  if (!isPlainObject(raw)) {
    throwTrustError(TRUST_BUNDLE_INVALID, `delta_add_key_invalid:${index}`);
  }
  const issuer = normalizeNonEmptyString(raw.issuer);
  if (!issuer) {
    throwTrustError(TRUST_BUNDLE_INVALID, `delta_add_key_issuer_missing:${index}`);
  }
  return {
    issuer,
    key: parseBundleKey(raw.key, `delta_add_key_${index}`)
  };
}

function parseDeltaRevokeKeyEntry(raw: unknown, index: number): TrustBundleDeltaRevokeKeyEntry {
  if (!isPlainObject(raw)) {
    throwTrustError(TRUST_BUNDLE_INVALID, `delta_revoke_key_invalid:${index}`);
  }
  const issuer = normalizeNonEmptyString(raw.issuer);
  if (!issuer) {
    throwTrustError(TRUST_BUNDLE_INVALID, `delta_revoke_key_issuer_missing:${index}`);
  }
  const kid = normalizeNonEmptyString(raw.kid);
  const fingerprint = normalizeNonEmptyString(raw.fingerprint).toLowerCase();
  const publicKeyPem = normalizeNonEmptyString(raw.publicKeyPem);
  if (!kid && !fingerprint && !publicKeyPem) {
    throwTrustError(TRUST_BUNDLE_INVALID, `delta_revoke_key_selector_missing:${index}`);
  }
  return {
    issuer,
    ...(kid ? { kid } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    ...(publicKeyPem ? { publicKeyPem } : {})
  };
}

function parseDeltaRevokeAnchorEntry(raw: unknown, index: number): TrustBundleDeltaRevokeAnchorEntry {
  if (!isPlainObject(raw)) {
    throwTrustError(TRUST_BUNDLE_INVALID, `delta_revoke_anchor_invalid:${index}`);
  }
  const anchorId = normalizeNonEmptyString(raw.anchorId);
  const fingerprint = normalizeNonEmptyString(raw.fingerprint);
  const publicKeyPem = normalizeNonEmptyString(raw.publicKeyPem);
  if (!anchorId && !fingerprint && !publicKeyPem) {
    throwTrustError(TRUST_BUNDLE_INVALID, `delta_revoke_anchor_selector_missing:${index}`);
  }
  return {
    ...(anchorId ? { anchorId } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    ...(publicKeyPem ? { publicKeyPem } : {})
  };
}

function parseDeltaRevocationsPatch(raw: unknown): TrustBundleDeltaRevocationsPatch {
  if (raw === undefined) {
    return {
      addSigners: [],
      removeSigners: [],
      addIssuerKeys: {},
      removeIssuerKeys: {},
      addAnchors: [],
      removeAnchors: [],
      addKeys: [],
      removeKeys: []
    };
  }
  if (!isPlainObject(raw)) {
    throwTrustError(TRUST_BUNDLE_INVALID, "delta_revocation_patch_invalid");
  }
  return {
    addSigners: parseStringArray(raw.addSigners, "delta_revocation_patch_add_signers_invalid"),
    removeSigners: parseStringArray(raw.removeSigners, "delta_revocation_patch_remove_signers_invalid"),
    addIssuerKeys: parseIssuerKeyRevocations(
      raw.addIssuerKeys,
      "delta_revocation_patch_add_issuer_keys_invalid"
    ),
    removeIssuerKeys: parseIssuerKeyRevocations(
      raw.removeIssuerKeys,
      "delta_revocation_patch_remove_issuer_keys_invalid"
    ),
    addAnchors: parseStringArray(raw.addAnchors, "delta_revocation_patch_add_anchors_invalid"),
    removeAnchors: parseStringArray(raw.removeAnchors, "delta_revocation_patch_remove_anchors_invalid"),
    addKeys: parseStringArray(raw.addKeys, "delta_revocation_patch_add_keys_invalid", true),
    removeKeys: parseStringArray(raw.removeKeys, "delta_revocation_patch_remove_keys_invalid", true)
  };
}

function parseDeltaArray<T>(
  raw: Record<string, unknown>,
  field: string,
  parser: (value: unknown, index: number) => T
): T[] {
  const value = raw[field];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throwTrustError(TRUST_BUNDLE_INVALID, `delta_${field}_must_be_array`);
  }
  return value.map(parser);
}

function parseDelta(raw: unknown): TrustBundleDeltaModel {
  if (!isPlainObject(raw)) {
    throwTrustError(TRUST_BUNDLE_INVALID, "delta_payload_must_be_object");
  }
  const version = normalizeNonEmptyString(raw.version || "v1");
  if (version !== "v1") {
    throwTrustError(TRUST_BUNDLE_INVALID, "delta_version_unsupported");
  }
  const addKeys = parseDeltaArray(raw, "addKeys", parseDeltaAddKeyEntry);
  const revokeKeys = [
    ...parseDeltaArray(raw, "revokeKeys", parseDeltaRevokeKeyEntry),
    ...parseDeltaArray(raw, "removeKeys", parseDeltaRevokeKeyEntry)
  ];
  const addAnchors = parseDeltaArray(
    raw,
    "addAnchors",
    (entry, index) => parseAnchor(entry, `delta_add_anchor_${index}`)
  );
  const revokeAnchors = [
    ...parseDeltaArray(raw, "revokeAnchors", parseDeltaRevokeAnchorEntry),
    ...parseDeltaArray(raw, "removeAnchors", parseDeltaRevokeAnchorEntry)
  ];
  return {
    version: "v1",
    addKeys,
    revokeKeys,
    addAnchors,
    revokeAnchors,
    applyRevocations: parseDeltaRevocationsPatch(raw.applyRevocations)
  };
}

function addUnique(target: string[], items: ReadonlyArray<string>): void {
  for (const item of items) {
    if (!target.includes(item)) {
      target.push(item);
    }
  }
}

function removeMany(target: string[], items: ReadonlyArray<string>): string[] {
  const removalSet = new Set(items);
  return target.filter((item) => !removalSet.has(item));
}

function ensureStrictAnchorValidity(
  anchor: TrustBundleAnchorEntry,
  env: NodeJS.ProcessEnv,
  nowMs: number
): void {
  const alg = normalizeNonEmptyString(anchor.alg).toLowerCase();
  const kid = normalizeNonEmptyString(anchor.kid);
  const signature = normalizeNonEmptyString(anchor.signature);
  if (alg !== "ed25519" || !kid || !signature || !looksLikeBase64(signature)) {
    throwTrustError(TRUST_SIGNATURE_INVALID, "delta_anchor_signature_invalid");
  }

  const timestampMs = Date.parse(anchor.timestamp);
  const maxSkewMs = resolveIdentityTimestampSkewSec(env) * 1000;
  if (!Number.isFinite(timestampMs) || Math.abs(nowMs - timestampMs) > maxSkewMs) {
    throwTrustError(TRUST_BUNDLE_INVALID, "delta_anchor_timestamp_invalid");
  }
}

function toSerializableBundle(model: TrustBundleModel): Readonly<Record<string, unknown>> {
  return {
    ...model.extra,
    issuers: model.issuers,
    ...(model.anchors.length > 0 ? { anchors: model.anchors } : {}),
    ...(model.revocations.signers.length > 0 ||
    Object.keys(model.revocations.issuerKeys).length > 0 ||
    model.revocations.anchors.length > 0 ||
    model.revocations.keys.length > 0
      ? { revocations: model.revocations }
      : {})
  };
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
    throwTrustError(TRUST_BUNDLE_INVALID, `delta_write_failed:${message}`);
  }
}

export function applyTrustBundleDelta(
  bundle: unknown,
  delta: unknown,
  options: TrustBundleDeltaApplyOptions = {}
): Readonly<Record<string, unknown>> {
  const trustVersion = normalizeTrustVersion(options.env?.INTENTOS_TRUST_VERSION);
  const nowMs = resolveTimestamp(options.nowMs);
  const model = parseBundle(bundle);
  const parsedDelta = parseDelta(delta);

  const addedKeys: Array<{ issuer: string; fingerprint: string }> = [];

  for (const entry of parsedDelta.addKeys) {
    const issuerEntry = model.issuers[entry.issuer] ?? { keys: [] };
    issuerEntry.keys.push(entry.key);
    model.issuers[entry.issuer] = issuerEntry;
    addedKeys.push({
      issuer: entry.issuer,
      fingerprint: computeBundleKeyFingerprint(entry.key.publicKeyPem)
    });
  }

  for (const entry of parsedDelta.revokeKeys) {
    const issuerEntry = model.issuers[entry.issuer];
    if (!issuerEntry) {
      throwTrustError(TRUST_BUNDLE_INVALID, "delta_revoke_key_issuer_unknown");
    }
    const target = issuerEntry.keys.find((key) => {
      const keyKid = normalizeNonEmptyString(key.kid);
      const keyFingerprint = computeBundleKeyFingerprint(key.publicKeyPem);
      return (
        (entry.kid !== undefined && keyKid === entry.kid) ||
        (entry.fingerprint !== undefined && keyFingerprint === entry.fingerprint) ||
        (entry.publicKeyPem !== undefined &&
          key.publicKeyPem.replace(/\r\n/g, "\n").trim() ===
            entry.publicKeyPem.replace(/\r\n/g, "\n").trim())
      );
    });
    if (!target) {
      throwTrustError(TRUST_BUNDLE_INVALID, "delta_revoke_key_target_missing");
    }
    const fingerprint = computeBundleKeyFingerprint(target.publicKeyPem).toLowerCase();
    addUnique(model.revocations.keys, [fingerprint]);
    const issuerRevocations = model.revocations.issuerKeys[entry.issuer] ?? [];
    addUnique(issuerRevocations, [fingerprint]);
    model.revocations.issuerKeys[entry.issuer] = issuerRevocations;
  }

  for (const entry of parsedDelta.addAnchors) {
    const fingerprint = computeAnchorFingerprint(entry.publicKeyPem);
    if (
      model.anchors.some(
        (anchor) => anchor.anchorId === entry.anchorId || computeAnchorFingerprint(anchor.publicKeyPem) === fingerprint
      )
    ) {
      throwTrustError(TRUST_BUNDLE_INVALID, "delta_add_anchor_duplicate");
    }
    model.anchors.push(entry);
  }

  for (const entry of parsedDelta.revokeAnchors) {
    const target = model.anchors.find((anchor) => {
      const fingerprint = computeAnchorFingerprint(anchor.publicKeyPem);
      return (
        (entry.anchorId !== undefined && anchor.anchorId === entry.anchorId) ||
        (entry.fingerprint !== undefined && fingerprint === entry.fingerprint) ||
        (entry.publicKeyPem !== undefined &&
          anchor.publicKeyPem.replace(/\r\n/g, "\n").trim() ===
            entry.publicKeyPem.replace(/\r\n/g, "\n").trim())
      );
    });
    if (!target) {
      throwTrustError(TRUST_BUNDLE_INVALID, "delta_revoke_anchor_target_missing");
    }
    const fingerprint = computeAnchorFingerprint(target.publicKeyPem);
    addUnique(model.revocations.anchors, [target.anchorId, fingerprint]);
  }

  const patch = parsedDelta.applyRevocations;
  addUnique(model.revocations.signers, patch.addSigners);
  model.revocations.signers = removeMany(model.revocations.signers, patch.removeSigners);

  for (const [issuer, fingerprints] of Object.entries(patch.addIssuerKeys)) {
    const existing = model.revocations.issuerKeys[issuer] ?? [];
    addUnique(existing, fingerprints.map((entry) => entry.toLowerCase()));
    model.revocations.issuerKeys[issuer] = existing;
  }
  for (const [issuer, fingerprints] of Object.entries(patch.removeIssuerKeys)) {
    const existing = model.revocations.issuerKeys[issuer];
    if (!existing) {
      continue;
    }
    const next = removeMany(existing, fingerprints.map((entry) => entry.toLowerCase()));
    if (next.length === 0) {
      delete model.revocations.issuerKeys[issuer];
    } else {
      model.revocations.issuerKeys[issuer] = next;
    }
  }

  addUnique(model.revocations.anchors, patch.addAnchors);
  model.revocations.anchors = removeMany(model.revocations.anchors, patch.removeAnchors);
  addUnique(model.revocations.keys, patch.addKeys.map((entry) => entry.toLowerCase()));
  model.revocations.keys = removeMany(model.revocations.keys, patch.removeKeys.map((entry) => entry.toLowerCase()));

  if (trustVersion === "v2") {
    for (const anchor of model.anchors) {
      ensureStrictAnchorValidity(anchor, options.env ?? {}, nowMs);
      const fingerprint = computeAnchorFingerprint(anchor.publicKeyPem);
      if (
        model.revocations.anchors.includes(anchor.anchorId) ||
        model.revocations.anchors.includes(fingerprint)
      ) {
        throwTrustError(TRUST_ANCHOR_REVOKED, "delta_anchor_revoked");
      }
    }

    for (const addedKey of addedKeys) {
      if (model.revocations.keys.includes(addedKey.fingerprint)) {
        throwTrustError(TRUST_ANCHOR_REVOKED, "delta_key_revoked");
      }
      const issuerRevocations = model.revocations.issuerKeys[addedKey.issuer] ?? [];
      if (issuerRevocations.includes(addedKey.fingerprint)) {
        throwTrustError(TRUST_ANCHOR_REVOKED, "delta_issuer_key_revoked");
      }
    }
  }

  return toSerializableBundle(model);
}

export function applyTrustBundleDeltaToPath(
  bundlePath: string,
  delta: unknown,
  options: TrustBundleDeltaApplyOptions = {}
): ApplyTrustBundleDeltaResult {
  const normalizedPath = normalizeNonEmptyString(bundlePath);
  if (!normalizedPath) {
    throwTrustError(TRUST_BUNDLE_INVALID, "delta_bundle_path_missing");
  }
  const resolvedPath = path.resolve(normalizedPath);
  let parsedBundle: unknown;
  try {
    parsedBundle = JSON.parse(readFileSync(resolvedPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throwTrustError(TRUST_BUNDLE_INVALID, `delta_bundle_load_failed:${message}`);
  }

  const nextBundle = applyTrustBundleDelta(parsedBundle, delta, options);
  atomicWriteJson(resolvedPath, nextBundle);
  return {
    applied: true,
    pathWritten: resolvedPath,
    bundle: nextBundle
  };
}
