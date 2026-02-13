import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  computeTransparencyHead,
  loadTransparencyLog,
  TransparencyCheckpointEntry,
  TransparencyEntryType,
  TransparencyHead,
  TransparencyLogEntry,
  TransparencyProof
} from "./trust-transparency";

export type TrustDistributionMode = "off" | "fs" | "http";
type TrustSnapshotPolicyMode = "off" | "warn" | "enforce";

export interface TrustDistributionSnapshot {
  readonly bundlePath?: string;
  readonly revocationsPath?: string;
  readonly identityAnchorsPath?: string;
  readonly transparencyLogPath?: string;
  readonly transparencyHead?: TransparencyHead;
  readonly checkpoint?: TransparencyCheckpointEntry;
  readonly transparencyProof?: TransparencyProof;
}

export interface TrustDistributionAdapter {
  resolveSnapshot(): TrustDistributionSnapshot;
}

type FetchJsonText = (url: string, timeoutMs: number, envKey: string) => string;

const DEFAULT_HTTP_TIMEOUT_MS = 5000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeNonEmptyString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function parseTransparencyHead(raw: unknown): TransparencyHead {
  if (!isPlainObject(raw)) {
    throw new Error("trust_distribution_transparency_head_must_be_object");
  }
  if (!Number.isInteger(raw.size) || (raw.size as number) < 0) {
    throw new Error("trust_distribution_transparency_head_size_invalid");
  }
  const chainHash = normalizeNonEmptyString(raw.chainHash);
  if (!chainHash) {
    throw new Error("trust_distribution_transparency_head_chain_hash_missing");
  }
  return {
    size: raw.size as number,
    chainHash
  };
}

function parseTransparencyCheckpoint(raw: unknown): TransparencyCheckpointEntry {
  if (!isPlainObject(raw)) {
    throw new Error("trust_distribution_checkpoint_must_be_object");
  }
  const allowedKeys = new Set(["kind", "size", "chainHash", "createdAt", "signer", "signature"]);
  const unknownKeys = Object.keys(raw).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`trust_distribution_checkpoint_unknown_keys:${unknownKeys.join(",")}`);
  }
  if (raw.kind !== "checkpoint") {
    throw new Error("trust_distribution_checkpoint_kind_invalid");
  }
  if (!Number.isInteger(raw.size) || (raw.size as number) < 0) {
    throw new Error("trust_distribution_checkpoint_size_invalid");
  }
  const chainHash = normalizeNonEmptyString(raw.chainHash);
  const createdAt = normalizeNonEmptyString(raw.createdAt);
  const signer = normalizeNonEmptyString(raw.signer);
  const signature = normalizeNonEmptyString(raw.signature);
  if (!chainHash || !createdAt || !signer || !signature) {
    throw new Error("trust_distribution_checkpoint_missing_required_fields");
  }
  return {
    kind: "checkpoint",
    size: raw.size as number,
    chainHash,
    createdAt,
    signer,
    signature
  };
}

function parseTransparencyEntryType(raw: unknown): TransparencyEntryType {
  const normalized = normalizeNonEmptyString(raw);
  if (
    normalized === "bundle_loaded" ||
    normalized === "bundle_rejected" ||
    normalized === "revocation_applied" ||
    normalized === "policy_reject"
  ) {
    return normalized;
  }
  throw new Error("trust_distribution_logtail_entry_type_invalid");
}

function parseTransparencyLogEntry(raw: unknown, lineNumber: number): TransparencyLogEntry {
  if (!isPlainObject(raw)) {
    throw new Error(`trust_distribution_logtail_entry_must_be_object:${lineNumber}`);
  }
  const allowedKeys = new Set([
    "timestamp",
    "type",
    "bundleHash",
    "reason",
    "prevHash",
    "entryHash",
    "chainHash"
  ]);
  const unknownKeys = Object.keys(raw).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`trust_distribution_logtail_unknown_keys:${lineNumber}:${unknownKeys.join(",")}`);
  }
  const timestamp = normalizeNonEmptyString(raw.timestamp);
  const entryHash = normalizeNonEmptyString(raw.entryHash);
  const chainHash = normalizeNonEmptyString(raw.chainHash);
  if (!timestamp || !entryHash || !chainHash) {
    throw new Error(`trust_distribution_logtail_missing_required_fields:${lineNumber}`);
  }
  const prevHash = normalizeNonEmptyString(raw.prevHash);
  const bundleHash = normalizeNonEmptyString(raw.bundleHash);
  const reason = normalizeNonEmptyString(raw.reason);
  return {
    timestamp,
    type: parseTransparencyEntryType(raw.type),
    ...(bundleHash ? { bundleHash } : {}),
    ...(reason ? { reason } : {}),
    ...(prevHash ? { prevHash } : {}),
    entryHash,
    chainHash
  };
}

function parseTransparencyLogTailJsonl(raw: string, source: string): ReadonlyArray<TransparencyLogEntry> {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const entries: TransparencyLogEntry[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[index]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`trust_distribution_invalid_jsonl:${source}:line_${index + 1}:${message}`);
    }
    entries.push(parseTransparencyLogEntry(parsed, index + 1));
  }
  return entries;
}

function writeJsonTempFile(prefix: string, filename: string, payload: unknown): string {
  const dirPath = mkdtempSync(path.join(tmpdir(), prefix));
  const filePath = path.join(dirPath, filename);
  writeFileSync(filePath, JSON.stringify(payload), "utf8");
  return filePath;
}

function parseJsonObject(raw: string, source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`trust_distribution_invalid_json:${source}:${message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`trust_distribution_json_must_be_object:${source}`);
  }
  return parsed;
}

const HTTP_FETCH_SCRIPT = [
  "const url = process.argv[1];",
  "const timeoutMs = Number(process.argv[2]);",
  "const controller = new AbortController();",
  "const timer = setTimeout(() => controller.abort(), timeoutMs);",
  "(async () => {",
  "  try {",
  "    const response = await fetch(url, {",
  "      method: 'GET',",
  "      headers: { 'accept': 'application/json' },",
  "      signal: controller.signal",
  "    });",
  "    if (!response.ok) {",
  "      throw new Error(`http_status_${response.status}`);",
  "    }",
  "    const body = await response.text();",
  "    process.stdout.write(body);",
  "  } catch (error) {",
  "    const message = error instanceof Error ? error.message : String(error);",
  "    process.stderr.write(message);",
  "    process.exit(1);",
  "  } finally {",
  "    clearTimeout(timer);",
  "  }",
  "})();"
].join("\n");

function defaultFetchJsonText(url: string, timeoutMs: number, envKey: string): string {
  try {
    return execFileSync(process.execPath, ["-e", HTTP_FETCH_SCRIPT, url, String(timeoutMs)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024
    });
  } catch (error) {
    const stderrValue = (error as { stderr?: string | Buffer } | null)?.stderr;
    const stderr = typeof stderrValue === "string" ? stderrValue.trim() : stderrValue?.toString("utf8").trim();
    const message =
      stderr && stderr.length > 0
        ? stderr
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`trust_distribution_http_fetch_failed:${envKey}:${message}`);
  }
}

export function normalizeTrustDistributionMode(value: unknown): TrustDistributionMode {
  const normalized = normalizeNonEmptyString(value).toLowerCase();
  if (normalized === "fs" || normalized === "http" || normalized === "off") {
    return normalized;
  }
  return "off";
}

function normalizeTrustSnapshotPolicyMode(value: unknown): TrustSnapshotPolicyMode {
  const normalized = normalizeNonEmptyString(value).toLowerCase();
  if (normalized === "warn" || normalized === "enforce" || normalized === "off") {
    return normalized;
  }
  return "off";
}

export function validateTrustDistributionHttpUrl(value: unknown, envKey: string): string {
  const raw = normalizeNonEmptyString(value);
  if (!raw) {
    throw new Error(`missing_trust_distribution_url:${envKey}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`invalid_trust_distribution_url:${envKey}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`invalid_trust_distribution_url:${envKey}`);
  }
  return parsed.toString();
}

export class LocalFilesystemTrustAdapter implements TrustDistributionAdapter {
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = {}) {
    this.env = env;
  }

  resolveSnapshot(): TrustDistributionSnapshot {
    const bundlePath = normalizeNonEmptyString(this.env.INTENTOS_TRUST_BUNDLE_PATH);
    const revocationsPath = normalizeNonEmptyString(this.env.INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH);
    const identityAnchorsPath = normalizeNonEmptyString(this.env.INTENTOS_TRUST_IDENTITY_ANCHORS_PATH);
    const transparencyLogPath = normalizeNonEmptyString(this.env.INTENTOS_TRANSPARENCY_LOG_PATH);
    const snapshot: TrustDistributionSnapshot = {
      ...(bundlePath ? { bundlePath } : {}),
      ...(revocationsPath ? { revocationsPath } : {}),
      ...(identityAnchorsPath ? { identityAnchorsPath } : {}),
      ...(transparencyLogPath ? { transparencyLogPath } : {})
    };

    if (!transparencyLogPath) {
      return snapshot;
    }

    try {
      const entries = loadTransparencyLog(transparencyLogPath);
      const transparencyHead = computeTransparencyHead(entries);
      return {
        ...snapshot,
        transparencyHead
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const snapshotPolicyMode = normalizeTrustSnapshotPolicyMode(this.env.INTENTOS_TRUST_SNAPSHOT_POLICY);
      const diagnostic = `trust_distribution_fs_transparency_head_failed:${message}`;
      if (snapshotPolicyMode === "enforce") {
        throw new Error(diagnostic);
      }
      console.warn(
        JSON.stringify({
          event: "intentos_trust_distribution",
          adapter: "fs",
          mode: snapshotPolicyMode,
          diagnostic,
          logPath: transparencyLogPath
        })
      );
      return snapshot;
    }
  }
}

export class HttpTrustAdapter implements TrustDistributionAdapter {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchJsonText: FetchJsonText;

  constructor(env: NodeJS.ProcessEnv = {}, fetchJsonText: FetchJsonText = defaultFetchJsonText) {
    this.env = env;
    this.fetchJsonText = fetchJsonText;
  }

  private fetchJsonObject(url: string, timeoutMs: number, envKey: string): Record<string, unknown> {
    let raw = "";
    try {
      raw = this.fetchJsonText(url, timeoutMs, envKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith(`trust_distribution_http_fetch_failed:${envKey}:`)) {
        throw new Error(message);
      }
      throw new Error(`trust_distribution_http_fetch_failed:${envKey}:${message}`);
    }
    return parseJsonObject(raw, envKey);
  }

  private fetchRawText(url: string, timeoutMs: number, envKey: string): string {
    let raw = "";
    try {
      raw = this.fetchJsonText(url, timeoutMs, envKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith(`trust_distribution_http_fetch_failed:${envKey}:`)) {
        throw new Error(message);
      }
      throw new Error(`trust_distribution_http_fetch_failed:${envKey}:${message}`);
    }
    return raw;
  }

  resolveSnapshot(): TrustDistributionSnapshot {
    const timeoutMs = DEFAULT_HTTP_TIMEOUT_MS;
    const bundleUrl = validateTrustDistributionHttpUrl(
      this.env.INTENTOS_TRUST_HTTP_BUNDLE_URL,
      "INTENTOS_TRUST_HTTP_BUNDLE_URL"
    );
    const bundlePayload = this.fetchJsonObject(
      bundleUrl,
      timeoutMs,
      "INTENTOS_TRUST_HTTP_BUNDLE_URL"
    );

    let revocationsPath: string | undefined;
    let identityAnchorsPath: string | undefined;
    let transparencyHead: TransparencyHead | undefined;
    let checkpoint: TransparencyCheckpointEntry | undefined;
    let transparencyProof: TransparencyProof | undefined;

    const revocationsUrlRaw = normalizeNonEmptyString(this.env.INTENTOS_TRUST_HTTP_REVOCATIONS_URL);
    if (revocationsUrlRaw) {
      const revocationsUrl = validateTrustDistributionHttpUrl(
        revocationsUrlRaw,
        "INTENTOS_TRUST_HTTP_REVOCATIONS_URL"
      );
      const revocationsPayload = this.fetchJsonObject(
        revocationsUrl,
        timeoutMs,
        "INTENTOS_TRUST_HTTP_REVOCATIONS_URL"
      );
      revocationsPath = writeJsonTempFile(
        "intentos-trust-revocations-http-",
        "trust-revocations.json",
        revocationsPayload
      );
    }

    const identityAnchorsUrlRaw = normalizeNonEmptyString(this.env.INTENTOS_TRUST_HTTP_IDENTITY_ANCHORS_URL);
    if (identityAnchorsUrlRaw) {
      const identityAnchorsUrl = validateTrustDistributionHttpUrl(
        identityAnchorsUrlRaw,
        "INTENTOS_TRUST_HTTP_IDENTITY_ANCHORS_URL"
      );
      const identityAnchorsPayload = this.fetchJsonObject(
        identityAnchorsUrl,
        timeoutMs,
        "INTENTOS_TRUST_HTTP_IDENTITY_ANCHORS_URL"
      );
      identityAnchorsPath = writeJsonTempFile(
        "intentos-identity-anchors-http-",
        "identity-anchors.json",
        identityAnchorsPayload
      );
    }

    const headUrlRaw = normalizeNonEmptyString(this.env.INTENTOS_TRUST_HTTP_HEAD_URL);
    if (headUrlRaw) {
      const headUrl = validateTrustDistributionHttpUrl(headUrlRaw, "INTENTOS_TRUST_HTTP_HEAD_URL");
      const headPayload = this.fetchJsonObject(headUrl, timeoutMs, "INTENTOS_TRUST_HTTP_HEAD_URL");
      if (isPlainObject(headPayload.head)) {
        transparencyHead = parseTransparencyHead(headPayload.head);
      } else {
        transparencyHead = parseTransparencyHead(headPayload);
      }
      if (headPayload.checkpoint !== undefined) {
        checkpoint = parseTransparencyCheckpoint(headPayload.checkpoint);
      }
    }

    const checkpointUrlRaw = normalizeNonEmptyString(this.env.INTENTOS_TRUST_HTTP_CHECKPOINT_URL);
    if (checkpointUrlRaw) {
      const checkpointUrl = validateTrustDistributionHttpUrl(
        checkpointUrlRaw,
        "INTENTOS_TRUST_HTTP_CHECKPOINT_URL"
      );
      const checkpointPayload = this.fetchJsonObject(
        checkpointUrl,
        timeoutMs,
        "INTENTOS_TRUST_HTTP_CHECKPOINT_URL"
      );
      checkpoint = parseTransparencyCheckpoint(checkpointPayload);
    }

    let proofEntries: ReadonlyArray<TransparencyLogEntry> | undefined;
    const logTailUrlRaw = normalizeNonEmptyString(this.env.INTENTOS_TRUST_HTTP_LOGTAIL_URL);
    if (logTailUrlRaw) {
      const logTailUrl = validateTrustDistributionHttpUrl(logTailUrlRaw, "INTENTOS_TRUST_HTTP_LOGTAIL_URL");
      proofEntries = parseTransparencyLogTailJsonl(
        this.fetchRawText(logTailUrl, timeoutMs, "INTENTOS_TRUST_HTTP_LOGTAIL_URL"),
        "INTENTOS_TRUST_HTTP_LOGTAIL_URL"
      );
    }

    if (proofEntries !== undefined || checkpoint !== undefined) {
      if (!transparencyHead) {
        throw new Error("trust_distribution_transparency_proof_requires_head");
      }
      transparencyProof = {
        head: transparencyHead,
        ...(checkpoint ? { checkpoint } : {}),
        entries: proofEntries ?? []
      };
    }

    const transparencyLogPath = normalizeNonEmptyString(this.env.INTENTOS_TRANSPARENCY_LOG_PATH);
    return {
      bundlePath: writeJsonTempFile("intentos-trust-bundle-http-", "trust-bundle.json", bundlePayload),
      ...(revocationsPath ? { revocationsPath } : {}),
      ...(identityAnchorsPath ? { identityAnchorsPath } : {}),
      ...(transparencyLogPath ? { transparencyLogPath } : {}),
      ...(transparencyHead ? { transparencyHead } : {}),
      ...(checkpoint ? { checkpoint } : {}),
      ...(transparencyProof ? { transparencyProof } : {})
    };
  }
}

export function resolveTrustDistributionSnapshot(env: NodeJS.ProcessEnv = {}): TrustDistributionSnapshot | null {
  const mode = normalizeTrustDistributionMode(env.INTENTOS_TRUST_DISTRIBUTION);
  if (mode === "off") {
    return null;
  }
  if (mode === "fs") {
    return new LocalFilesystemTrustAdapter(env).resolveSnapshot();
  }
  return new HttpTrustAdapter(env).resolveSnapshot();
}
