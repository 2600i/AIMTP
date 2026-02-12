import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TrustSnapshotState } from "./trust-snapshot-policy";

export interface TrustSnapshotStore {
  load(): TrustSnapshotState | null;
  save(state: TrustSnapshotState): void;
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

function parseSnapshotState(raw: unknown): TrustSnapshotState {
  if (!isPlainObject(raw)) {
    throw new Error("trust_snapshot_state_must_be_object");
  }
  const allowedKeys = new Set(["transparencyHead", "bundleId", "fetchedAtMs", "source"]);
  const unknownKeys = Object.keys(raw).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`trust_snapshot_state_unknown_keys:${unknownKeys.join(",")}`);
  }

  let transparencyHead: TrustSnapshotState["transparencyHead"];
  if (raw.transparencyHead !== undefined) {
    if (!isPlainObject(raw.transparencyHead)) {
      throw new Error("trust_snapshot_state_head_must_be_object");
    }
    const headAllowedKeys = new Set(["size", "chainHash"]);
    const headUnknownKeys = Object.keys(raw.transparencyHead).filter((key) => !headAllowedKeys.has(key));
    if (headUnknownKeys.length > 0) {
      throw new Error(`trust_snapshot_state_head_unknown_keys:${headUnknownKeys.join(",")}`);
    }
    if (!Number.isInteger(raw.transparencyHead.size) || (raw.transparencyHead.size as number) < 0) {
      throw new Error("trust_snapshot_state_head_size_invalid");
    }
    const chainHash = normalizeNonEmptyString(raw.transparencyHead.chainHash);
    if (!chainHash) {
      throw new Error("trust_snapshot_state_head_chain_hash_missing");
    }
    transparencyHead = {
      size: raw.transparencyHead.size as number,
      chainHash
    };
  }

  if (raw.bundleId !== undefined && normalizeNonEmptyString(raw.bundleId) === undefined) {
    throw new Error("trust_snapshot_state_bundle_id_invalid");
  }
  if (
    raw.fetchedAtMs !== undefined &&
    (typeof raw.fetchedAtMs !== "number" || !Number.isFinite(raw.fetchedAtMs) || raw.fetchedAtMs < 0)
  ) {
    throw new Error("trust_snapshot_state_fetched_at_ms_invalid");
  }
  if (raw.source !== undefined && normalizeNonEmptyString(raw.source) === undefined) {
    throw new Error("trust_snapshot_state_source_invalid");
  }

  return {
    ...(transparencyHead ? { transparencyHead } : {}),
    ...(normalizeNonEmptyString(raw.bundleId) ? { bundleId: normalizeNonEmptyString(raw.bundleId) } : {}),
    ...(typeof raw.fetchedAtMs === "number" ? { fetchedAtMs: Math.trunc(raw.fetchedAtMs) } : {}),
    ...(normalizeNonEmptyString(raw.source) ? { source: normalizeNonEmptyString(raw.source) } : {})
  };
}

export class FileTrustSnapshotStore implements TrustSnapshotStore {
  private readonly statePath: string;

  constructor(statePath: string) {
    this.statePath = statePath;
  }

  load(): TrustSnapshotState | null {
    let raw = "";
    try {
      raw = readFileSync(this.statePath, "utf8");
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === "ENOENT") {
        return null;
      }
      throw error;
    }
    return parseSnapshotState(JSON.parse(raw));
  }

  save(state: TrustSnapshotState): void {
    const normalized = parseSnapshotState({
      ...(state.transparencyHead ? { transparencyHead: state.transparencyHead } : {}),
      ...(state.bundleId ? { bundleId: state.bundleId } : {}),
      ...(typeof state.fetchedAtMs === "number" ? { fetchedAtMs: state.fetchedAtMs } : {}),
      ...(state.source ? { source: state.source } : {})
    });
    const parentDir = path.dirname(this.statePath);
    mkdirSync(parentDir, { recursive: true });

    const tempPath = `${this.statePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(tempPath, `${JSON.stringify(normalized)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(tempPath, this.statePath);
      try {
        chmodSync(this.statePath, 0o600);
      } catch {
        // Best-effort permission hardening.
      }
    } catch (error) {
      try {
        rmSync(tempPath, { force: true });
      } catch {
        // Best-effort cleanup.
      }
      throw error;
    }
  }
}

export function createTrustSnapshotStoreFromEnv(env: NodeJS.ProcessEnv = {}): TrustSnapshotStore | null {
  const statePath = normalizeNonEmptyString(env.INTENTOS_TRUST_SNAPSHOT_STATE_PATH);
  if (!statePath) {
    return null;
  }
  return new FileTrustSnapshotStore(statePath);
}
