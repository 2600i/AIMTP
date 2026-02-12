import { appendFileSync, readFileSync } from "node:fs";
import { createHash, createPrivateKey, createPublicKey, sign as signBytes, verify as verifyBytes } from "node:crypto";

export type TransparencyEntryType =
  | "bundle_loaded"
  | "bundle_rejected"
  | "revocation_applied"
  | "policy_reject";

export interface TransparencyEntryInput {
  readonly timestamp: string;
  readonly type: TransparencyEntryType;
  readonly bundleHash?: string;
  readonly reason?: string;
  readonly prevHash?: string;
}

export interface TransparencyLogEntry {
  readonly timestamp: string;
  readonly type: TransparencyEntryType;
  readonly bundleHash?: string;
  readonly reason?: string;
  readonly prevHash?: string;
  readonly entryHash: string;
  readonly chainHash: string;
}

export interface TransparencyCheckpointEntry {
  readonly kind: "checkpoint";
  readonly size: number;
  readonly chainHash: string;
  readonly createdAt: string;
  readonly signer: string;
  readonly signature: string;
}

export type TransparencyLogRecord = TransparencyLogEntry | TransparencyCheckpointEntry;

export interface AppendTransparencyEntryOptions {
  readonly path: string;
}

export interface CreateTransparencyCheckpointOptions {
  readonly logEntries: ReadonlyArray<TransparencyLogEntry>;
  readonly chainHash: string;
  readonly signer: string;
  readonly signingKeyPem: string;
  readonly createdAt?: string;
}

export interface VerifyTransparencyLogIncrementalOptions {
  readonly checkpointPublicKeyPem?: string;
}

export interface TransparencyLogVerificationResult {
  readonly valid: boolean;
  readonly brokenAt: number | null;
  readonly reason: string | null;
  readonly entryCount: number;
  readonly checkpointUsedSize?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
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

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function parseEntryType(value: unknown): TransparencyEntryType {
  const normalized = normalizeNonEmptyString(value);
  if (
    normalized === "bundle_loaded" ||
    normalized === "bundle_rejected" ||
    normalized === "revocation_applied" ||
    normalized === "policy_reject"
  ) {
    return normalized;
  }
  throw new Error("entry_type_invalid");
}

function parseCheckpointSize(value: unknown, lineNumber: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new Error(`line ${lineNumber}: checkpoint_size_invalid`);
  }
  return value;
}

function parseTransparencyEntry(raw: unknown, lineNumber: number): TransparencyLogEntry {
  if (!isPlainObject(raw)) {
    throw new Error(`line ${lineNumber}: entry_must_be_object`);
  }

  const timestamp = normalizeNonEmptyString(raw.timestamp);
  const entryHash = normalizeNonEmptyString(raw.entryHash);
  const chainHash = normalizeNonEmptyString(raw.chainHash);
  if (!timestamp || !entryHash || !chainHash) {
    throw new Error(`line ${lineNumber}: missing_required_fields`);
  }

  return {
    timestamp,
    type: parseEntryType(raw.type),
    ...(normalizeNonEmptyString(raw.bundleHash) ? { bundleHash: normalizeNonEmptyString(raw.bundleHash) } : {}),
    ...(normalizeNonEmptyString(raw.reason) ? { reason: normalizeNonEmptyString(raw.reason) } : {}),
    ...(normalizeNonEmptyString(raw.prevHash) ? { prevHash: normalizeNonEmptyString(raw.prevHash) } : {}),
    entryHash,
    chainHash
  };
}

function parseTransparencyCheckpoint(raw: unknown, lineNumber: number): TransparencyCheckpointEntry {
  if (!isPlainObject(raw)) {
    throw new Error(`line ${lineNumber}: checkpoint_must_be_object`);
  }
  const allowedKeys = new Set(["kind", "size", "chainHash", "createdAt", "signer", "signature"]);
  const unknownKeys = Object.keys(raw).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`line ${lineNumber}: checkpoint_unknown_keys:${unknownKeys.join(",")}`);
  }
  if (typeof raw.kind !== "string") {
    throw new Error(`line ${lineNumber}: checkpoint_kind_type_invalid`);
  }
  if (typeof raw.chainHash !== "string") {
    throw new Error(`line ${lineNumber}: checkpoint_chain_hash_type_invalid`);
  }
  if (typeof raw.createdAt !== "string") {
    throw new Error(`line ${lineNumber}: checkpoint_created_at_type_invalid`);
  }
  if (typeof raw.signer !== "string") {
    throw new Error(`line ${lineNumber}: checkpoint_signer_type_invalid`);
  }
  if (typeof raw.signature !== "string") {
    throw new Error(`line ${lineNumber}: checkpoint_signature_type_invalid`);
  }

  const kind = normalizeNonEmptyString(raw.kind);
  const chainHash = normalizeNonEmptyString(raw.chainHash);
  const createdAt = normalizeNonEmptyString(raw.createdAt);
  const signer = normalizeNonEmptyString(raw.signer);
  const signature = normalizeNonEmptyString(raw.signature);
  if (kind !== "checkpoint") {
    throw new Error(`line ${lineNumber}: checkpoint_kind_invalid`);
  }
  if (!chainHash || !createdAt || !signer || !signature) {
    throw new Error(`line ${lineNumber}: checkpoint_missing_required_fields`);
  }

  return {
    kind: "checkpoint",
    size: parseCheckpointSize(raw.size, lineNumber),
    chainHash,
    createdAt,
    signer,
    signature
  };
}

function isCheckpointRecord(record: TransparencyLogRecord): record is TransparencyCheckpointEntry {
  return (record as { kind?: string }).kind === "checkpoint";
}

function toHashableEntry(entry: TransparencyEntryInput | TransparencyLogEntry): TransparencyEntryInput {
  return {
    timestamp: entry.timestamp,
    type: entry.type,
    ...(normalizeNonEmptyString(entry.bundleHash) ? { bundleHash: normalizeNonEmptyString(entry.bundleHash) } : {}),
    ...(normalizeNonEmptyString(entry.reason) ? { reason: normalizeNonEmptyString(entry.reason) } : {}),
    ...(normalizeNonEmptyString(entry.prevHash) ? { prevHash: normalizeNonEmptyString(entry.prevHash) } : {})
  };
}

function toCheckpointPayload(checkpoint: Omit<TransparencyCheckpointEntry, "signature">): Record<string, unknown> {
  return {
    kind: checkpoint.kind,
    size: checkpoint.size,
    chainHash: checkpoint.chainHash,
    createdAt: checkpoint.createdAt,
    signer: checkpoint.signer
  };
}

function canonicalizeCheckpointPayload(checkpoint: Omit<TransparencyCheckpointEntry, "signature">): Buffer {
  return Buffer.from(stableStringifyJson(toCheckpointPayload(checkpoint)), "utf8");
}

interface IndexedTransparencyRecord {
  readonly lineNumber: number;
  readonly record: TransparencyLogRecord;
}

interface IndexedTransparencyEntry {
  readonly lineNumber: number;
  readonly entry: TransparencyLogEntry;
}

interface IndexedTransparencyCheckpoint {
  readonly lineNumber: number;
  readonly checkpoint: TransparencyCheckpointEntry;
  readonly entriesSeenAtLine: number;
}

function loadTransparencyLogRecords(path: string): ReadonlyArray<IndexedTransparencyRecord> {
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return lines.map((line, index) => {
    const lineNumber = index + 1;
    try {
      const parsed = JSON.parse(line);
      if (isPlainObject(parsed) && normalizeNonEmptyString(parsed.kind) === "checkpoint") {
        return {
          lineNumber,
          record: parseTransparencyCheckpoint(parsed, lineNumber)
        };
      }
      return {
        lineNumber,
        record: parseTransparencyEntry(parsed, lineNumber)
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid_transparency_log_entry:${message}`);
    }
  });
}

function extractIndexedLogEntries(
  records: ReadonlyArray<IndexedTransparencyRecord>
): ReadonlyArray<IndexedTransparencyEntry> {
  return records
    .filter((item) => !isCheckpointRecord(item.record))
    .map((item) => ({
      lineNumber: item.lineNumber,
      entry: item.record as TransparencyLogEntry
    }));
}

function extractIndexedCheckpoints(
  records: ReadonlyArray<IndexedTransparencyRecord>
): ReadonlyArray<IndexedTransparencyCheckpoint> {
  let entriesSeen = 0;
  const checkpoints: IndexedTransparencyCheckpoint[] = [];
  for (const item of records) {
    if (isCheckpointRecord(item.record)) {
      checkpoints.push({
        lineNumber: item.lineNumber,
        checkpoint: item.record,
        entriesSeenAtLine: entriesSeen
      });
      continue;
    }
    entriesSeen += 1;
  }
  return checkpoints;
}

function expectedChainHashAtSize(
  indexedEntries: ReadonlyArray<IndexedTransparencyEntry>,
  size: number
): string | null {
  if (size < 0 || size > indexedEntries.length) {
    return null;
  }
  if (size === 0) {
    return "";
  }
  return indexedEntries[size - 1].entry.chainHash;
}

interface CheckpointValidationResult {
  readonly valid: boolean;
  readonly reason: string | null;
}

function validateCheckpointAgainstIndexedEntries(
  checkpoint: TransparencyCheckpointEntry,
  indexedEntries: ReadonlyArray<IndexedTransparencyEntry>,
  entriesSeenAtLine: number,
  publicKeyPem: string
): CheckpointValidationResult {
  try {
    verifyCheckpoint(checkpoint, publicKeyPem);
  } catch (error) {
    return {
      valid: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }

  if (checkpoint.size > entriesSeenAtLine) {
    return {
      valid: false,
      reason: "checkpoint_size_exceeds_entries_at_line"
    };
  }

  const expectedChainHash = expectedChainHashAtSize(indexedEntries, checkpoint.size);
  if (expectedChainHash === null) {
    return {
      valid: false,
      reason: "checkpoint_size_out_of_range"
    };
  }
  if (checkpoint.chainHash !== expectedChainHash) {
    return {
      valid: false,
      reason: "checkpoint_chain_hash_mismatch"
    };
  }

  return {
    valid: true,
    reason: null
  };
}

interface VerifyEntriesResult {
  readonly valid: boolean;
  readonly brokenAt: number | null;
  readonly reason: string | null;
}

function verifyIndexedLogEntries(
  indexedEntries: ReadonlyArray<IndexedTransparencyEntry>,
  startIndex = 0,
  initialPrevHash: string | undefined = undefined
): VerifyEntriesResult {
  let previousChainHash = initialPrevHash;
  for (let index = startIndex; index < indexedEntries.length; index += 1) {
    const { lineNumber, entry } = indexedEntries[index];
    const actualPrevHash = normalizeNonEmptyString(entry.prevHash);
    if ((previousChainHash ?? undefined) !== (actualPrevHash ?? undefined)) {
      return {
        valid: false,
        brokenAt: lineNumber,
        reason: "prev_hash_mismatch"
      };
    }

    const expectedEntryHash = computeEntryHash(entry);
    if (entry.entryHash !== expectedEntryHash) {
      return {
        valid: false,
        brokenAt: lineNumber,
        reason: "entry_hash_mismatch"
      };
    }

    const expectedChainHash = computeChainHash(actualPrevHash, entry.entryHash);
    if (entry.chainHash !== expectedChainHash) {
      return {
        valid: false,
        brokenAt: lineNumber,
        reason: "chain_hash_mismatch"
      };
    }
    previousChainHash = entry.chainHash;
  }

  return {
    valid: true,
    brokenAt: null,
    reason: null
  };
}

export function computeEntryHash(entry: TransparencyEntryInput | TransparencyLogEntry): string {
  return sha256Hex(stableStringifyJson(toHashableEntry(entry)));
}

export function computeChainHash(prevHash: string | undefined, entryHash: string): string {
  return sha256Hex(
    stableStringifyJson({
      prevHash: normalizeNonEmptyString(prevHash) ?? null,
      entryHash: normalizeNonEmptyString(entryHash) ?? ""
    })
  );
}

export function createCheckpoint(
  options: CreateTransparencyCheckpointOptions
): TransparencyCheckpointEntry {
  const signer = normalizeNonEmptyString(options.signer);
  const signingKeyPem = normalizeNonEmptyString(options.signingKeyPem);
  const chainHash = normalizeNonEmptyString(options.chainHash);
  if (!signer || !signingKeyPem || !chainHash) {
    throw new Error("checkpoint_creation_requires_signer_key_and_chain_hash");
  }

  const checkpointBase: Omit<TransparencyCheckpointEntry, "signature"> = {
    kind: "checkpoint",
    size: options.logEntries.length,
    chainHash,
    createdAt: options.createdAt ?? new Date().toISOString(),
    signer
  };
  const signature = signBytes(
    null,
    canonicalizeCheckpointPayload(checkpointBase),
    createPrivateKey(signingKeyPem)
  ).toString("base64");

  return {
    ...checkpointBase,
    signature
  };
}

export function verifyCheckpoint(checkpoint: TransparencyCheckpointEntry, publicKeyPem: string): boolean {
  const key = normalizeNonEmptyString(publicKeyPem);
  if (!key) {
    throw new Error("checkpoint_public_key_missing");
  }
  if (checkpoint.kind !== "checkpoint") {
    throw new Error("checkpoint_kind_invalid");
  }
  if (!Number.isInteger(checkpoint.size) || checkpoint.size < 0) {
    throw new Error("checkpoint_size_invalid");
  }
  if (!normalizeNonEmptyString(checkpoint.chainHash)) {
    throw new Error("checkpoint_chain_hash_missing");
  }
  if (!normalizeNonEmptyString(checkpoint.createdAt)) {
    throw new Error("checkpoint_created_at_missing");
  }
  if (!normalizeNonEmptyString(checkpoint.signer)) {
    throw new Error("checkpoint_signer_missing");
  }
  if (!normalizeNonEmptyString(checkpoint.signature)) {
    throw new Error("checkpoint_signature_missing");
  }

  const checkpointBase: Omit<TransparencyCheckpointEntry, "signature"> = {
    kind: checkpoint.kind,
    size: checkpoint.size,
    chainHash: checkpoint.chainHash,
    createdAt: checkpoint.createdAt,
    signer: checkpoint.signer
  };
  const signature = Buffer.from(checkpoint.signature, "base64");
  const verified = verifyBytes(
    null,
    canonicalizeCheckpointPayload(checkpointBase),
    createPublicKey(key),
    signature
  );
  if (!verified) {
    throw new Error("checkpoint_signature_invalid");
  }
  return true;
}

export function findLatestValidCheckpoint(
  entries: ReadonlyArray<TransparencyLogRecord>,
  publicKeyPem: string
): { checkpoint: TransparencyCheckpointEntry; startIndex: number } | null {
  const indexedEntries = entries
    .filter((entry) => !isCheckpointRecord(entry))
    .map((entry, index) => ({
      lineNumber: index + 1,
      entry: entry as TransparencyLogEntry
    }));

  const checkpoints = entries
    .filter((entry) => isCheckpointRecord(entry))
    .map((entry) => entry as TransparencyCheckpointEntry);
  for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
    const checkpoint = checkpoints[index];
    try {
      verifyCheckpoint(checkpoint, publicKeyPem);
    } catch {
      continue;
    }
    const expectedChainHash = expectedChainHashAtSize(indexedEntries, checkpoint.size);
    if (expectedChainHash === null || expectedChainHash !== checkpoint.chainHash) {
      continue;
    }
    return {
      checkpoint,
      startIndex: checkpoint.size
    };
  }
  return null;
}

export function loadTransparencyLog(path: string): ReadonlyArray<TransparencyLogEntry> {
  const records = loadTransparencyLogRecords(path);
  return extractIndexedLogEntries(records).map((item) => item.entry);
}

export function verifyTransparencyLog(path: string): TransparencyLogVerificationResult {
  let records: ReadonlyArray<IndexedTransparencyRecord>;
  try {
    records = loadTransparencyLogRecords(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const lineMatch = message.match(/\bline (\d+)\b/);
    const brokenAt = lineMatch ? Number.parseInt(lineMatch[1], 10) : 1;
    return {
      valid: false,
      brokenAt: Number.isFinite(brokenAt) && brokenAt > 0 ? brokenAt : 1,
      reason: message,
      entryCount: 0
    };
  }

  const indexedEntries = extractIndexedLogEntries(records);
  const verified = verifyIndexedLogEntries(indexedEntries);
  if (!verified.valid) {
    return {
      valid: false,
      brokenAt: verified.brokenAt,
      reason: verified.reason,
      entryCount: indexedEntries.length
    };
  }

  return {
    valid: true,
    brokenAt: null,
    reason: null,
    entryCount: indexedEntries.length
  };
}

export function verifyTransparencyLogIncremental(
  path: string,
  options: VerifyTransparencyLogIncrementalOptions = {}
): TransparencyLogVerificationResult {
  const checkpointPublicKeyPem = normalizeNonEmptyString(options.checkpointPublicKeyPem);
  if (!checkpointPublicKeyPem) {
    return verifyTransparencyLog(path);
  }

  let records: ReadonlyArray<IndexedTransparencyRecord>;
  try {
    records = loadTransparencyLogRecords(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const lineMatch = message.match(/\bline (\d+)\b/);
    const brokenAt = lineMatch ? Number.parseInt(lineMatch[1], 10) : 1;
    return {
      valid: false,
      brokenAt: Number.isFinite(brokenAt) && brokenAt > 0 ? brokenAt : 1,
      reason: message,
      entryCount: 0
    };
  }

  const indexedEntries = extractIndexedLogEntries(records);
  const indexedCheckpoints = extractIndexedCheckpoints(records);
  if (indexedCheckpoints.length === 0) {
    return verifyTransparencyLog(path);
  }

  let latestInvalid: { lineNumber: number; reason: string } | null = null;
  for (let index = indexedCheckpoints.length - 1; index >= 0; index -= 1) {
    const checkpointEntry = indexedCheckpoints[index];
    const validation = validateCheckpointAgainstIndexedEntries(
      checkpointEntry.checkpoint,
      indexedEntries,
      checkpointEntry.entriesSeenAtLine,
      checkpointPublicKeyPem
    );
    if (!validation.valid) {
      if (!latestInvalid) {
        latestInvalid = {
          lineNumber: checkpointEntry.lineNumber,
          reason: validation.reason ?? "checkpoint_invalid"
        };
      }
      continue;
    }

    const verifyFromCheckpoint = verifyIndexedLogEntries(
      indexedEntries,
      checkpointEntry.checkpoint.size,
      checkpointEntry.checkpoint.size === 0 ? undefined : checkpointEntry.checkpoint.chainHash
    );
    if (!verifyFromCheckpoint.valid) {
      return {
        valid: false,
        brokenAt: verifyFromCheckpoint.brokenAt,
        reason: verifyFromCheckpoint.reason,
        entryCount: indexedEntries.length
      };
    }

    return {
      valid: true,
      brokenAt: null,
      reason: null,
      entryCount: indexedEntries.length,
      checkpointUsedSize: checkpointEntry.checkpoint.size
    };
  }

  return {
    valid: false,
    brokenAt: latestInvalid?.lineNumber ?? indexedCheckpoints[indexedCheckpoints.length - 1].lineNumber,
    reason: latestInvalid?.reason ?? "checkpoint_invalid",
    entryCount: indexedEntries.length
  };
}

export function appendTransparencyEntry(
  entry: TransparencyEntryInput,
  options: AppendTransparencyEntryOptions
): TransparencyLogEntry {
  const existing = loadTransparencyLog(options.path);
  const prevHash = existing.length > 0 ? existing[existing.length - 1].chainHash : undefined;
  const hashable = {
    ...entry,
    ...(prevHash ? { prevHash } : {})
  };
  const entryHash = computeEntryHash(hashable);
  const chainHash = computeChainHash(prevHash, entryHash);
  const next: TransparencyLogEntry = {
    ...hashable,
    entryHash,
    chainHash
  };
  appendFileSync(options.path, `${JSON.stringify(next)}\n`, "utf8");
  return next;
}
