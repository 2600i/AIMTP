import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

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

export interface AppendTransparencyEntryOptions {
  readonly path: string;
}

export interface TransparencyLogVerificationResult {
  readonly valid: boolean;
  readonly brokenAt: number | null;
  readonly reason: string | null;
  readonly entryCount: number;
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

function toHashableEntry(entry: TransparencyEntryInput | TransparencyLogEntry): TransparencyEntryInput {
  return {
    timestamp: entry.timestamp,
    type: entry.type,
    ...(normalizeNonEmptyString(entry.bundleHash) ? { bundleHash: normalizeNonEmptyString(entry.bundleHash) } : {}),
    ...(normalizeNonEmptyString(entry.reason) ? { reason: normalizeNonEmptyString(entry.reason) } : {}),
    ...(normalizeNonEmptyString(entry.prevHash) ? { prevHash: normalizeNonEmptyString(entry.prevHash) } : {})
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

export function loadTransparencyLog(path: string): ReadonlyArray<TransparencyLogEntry> {
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
    try {
      return parseTransparencyEntry(JSON.parse(line), index + 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid_transparency_log_entry:${message}`);
    }
  });
}

export function verifyTransparencyLog(path: string): TransparencyLogVerificationResult {
  let entries: ReadonlyArray<TransparencyLogEntry>;
  try {
    entries = loadTransparencyLog(path);
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

  let previousChainHash: string | undefined;
  for (let index = 0; index < entries.length; index += 1) {
    const lineNumber = index + 1;
    const entry = entries[index];
    const expectedPrevHash = previousChainHash;
    const actualPrevHash = normalizeNonEmptyString(entry.prevHash);
    if ((expectedPrevHash ?? undefined) !== (actualPrevHash ?? undefined)) {
      return {
        valid: false,
        brokenAt: lineNumber,
        reason: "prev_hash_mismatch",
        entryCount: entries.length
      };
    }

    const expectedEntryHash = computeEntryHash(entry);
    if (entry.entryHash !== expectedEntryHash) {
      return {
        valid: false,
        brokenAt: lineNumber,
        reason: "entry_hash_mismatch",
        entryCount: entries.length
      };
    }

    const expectedChainHash = computeChainHash(actualPrevHash, entry.entryHash);
    if (entry.chainHash !== expectedChainHash) {
      return {
        valid: false,
        brokenAt: lineNumber,
        reason: "chain_hash_mismatch",
        entryCount: entries.length
      };
    }
    previousChainHash = entry.chainHash;
  }

  return {
    valid: true,
    brokenAt: null,
    reason: null,
    entryCount: entries.length
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
