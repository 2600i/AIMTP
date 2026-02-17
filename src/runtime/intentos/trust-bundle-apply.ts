import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  TRUST_BUNDLE_TYPE,
  TRUST_BUNDLE_VERSION,
  isTrustBundleV04,
  type TrustBundleV04
} from "../../protocol/trust-bundle";
import {
  verifyRevocationProof,
  type RevocationProofVerificationResult
} from "./revocation-distribution";

export type TrustBundleApplyPolicy = "off" | "warn" | "enforce";

export interface ApplyTrustBundleOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly storePath?: string;
  readonly policy?: TrustBundleApplyPolicy;
  readonly nowMs?: number;
}

export interface ApplyTrustBundleResult {
  readonly applied: boolean;
  readonly warnings: ReadonlyArray<string>;
  readonly pathsWritten: ReadonlyArray<string>;
  readonly revocationProofVerification: RevocationProofVerificationResult | null;
}

interface ResolvedStorePaths {
  readonly rootDir: string;
  readonly statePath: string;
  readonly artifactsDir: string;
}

function normalizeNonEmptyString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizePolicyMode(value: unknown): TrustBundleApplyPolicy {
  const normalized = normalizeNonEmptyString(value).toLowerCase();
  if (normalized === "off" || normalized === "warn" || normalized === "enforce") {
    return normalized;
  }
  return "warn";
}

function resolveStorePaths(storePath: string): ResolvedStorePaths {
  const normalized = normalizeNonEmptyString(storePath);
  if (!normalized) {
    throw new Error("trust_bundle_apply_store_missing");
  }

  const resolved = path.resolve(normalized);
  const statePath = path.extname(resolved).toLowerCase() === ".json"
    ? resolved
    : path.join(resolved, "snapshot-state.json");

  const rootDir = path.dirname(statePath);
  return {
    rootDir,
    statePath,
    artifactsDir: path.join(rootDir, "bundle-artifacts")
  };
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
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((key) => obj[key] !== undefined)
      .sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${stableStringifyJson(obj[key])}`);
    return `{${parts.join(",")}}`;
  }
  throw new Error(`unsupported_value_type:${typeof value}`);
}

function computeTrustBundleId(bundle: TrustBundleV04): string {
  return `sha256:${createHash("sha256").update(stableStringifyJson(bundle), "utf8").digest("hex")}`;
}

function normalizeApplyTimestamp(nowMs?: number): number {
  if (typeof nowMs === "number" && Number.isFinite(nowMs) && nowMs >= 0) {
    return Math.trunc(nowMs);
  }
  return Date.now();
}

function deriveTransparencyHead(bundle: TrustBundleV04): { size: number; chainHash: string } | undefined {
  if (bundle.transparency?.head) {
    return {
      size: bundle.transparency.head.size,
      chainHash: bundle.transparency.head.chainHash
    };
  }
  if (bundle.transparency?.latestCheckpoint) {
    return {
      size: bundle.transparency.latestCheckpoint.size,
      chainHash: bundle.transparency.latestCheckpoint.chainHash
    };
  }
  return undefined;
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
      chmodSync(filePath, 0o600);
    } catch {
      // Best-effort hardening.
    }

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
    throw new Error(`trust_bundle_apply_atomic_write_failed:${message}`);
  }
}

function assertTrustBundleV04(bundle: unknown): asserts bundle is TrustBundleV04 {
  if (!isTrustBundleV04(bundle)) {
    throw new Error("trust_bundle_invalid");
  }
  if (bundle.type !== TRUST_BUNDLE_TYPE || bundle.version !== TRUST_BUNDLE_VERSION) {
    throw new Error("trust_bundle_invalid");
  }
}

export function applyTrustBundleToSnapshotStore(
  bundle: unknown,
  opts: ApplyTrustBundleOptions = {}
): ApplyTrustBundleResult {
  const env = opts.env ?? {};
  const policy = normalizePolicyMode(opts.policy);

  if (policy === "off") {
    return {
      applied: false,
      warnings: [],
      pathsWritten: [],
      revocationProofVerification: null
    };
  }

  assertTrustBundleV04(bundle);

  let revocationProofVerification: RevocationProofVerificationResult | null = null;
  if (normalizeNonEmptyString(env.INTENTOS_REVOCATION_PROOF).toLowerCase() === "on" && bundle.revocations) {
    revocationProofVerification = verifyRevocationProof(
      bundle.revocations.set,
      bundle.revocations.proof,
      env.INTENTOS_TRUSTED_REVOCATION_KEYS_JSON
    );
    if (!revocationProofVerification.verified) {
      throw new Error(revocationProofVerification.code);
    }
  }

  const storePath = normalizeNonEmptyString(opts.storePath) || normalizeNonEmptyString(env.INTENTOS_TRUST_SNAPSHOT_STATE_PATH);
  const paths = resolveStorePaths(storePath);
  mkdirSync(paths.artifactsDir, { recursive: true });

  const pathsWritten: string[] = [];

  const bundlePath = path.join(paths.artifactsDir, "trust-bundle-v0.4.json");
  atomicWriteJson(bundlePath, bundle);
  pathsWritten.push(bundlePath);

  if (bundle.identityAnchors) {
    const anchorsPath = path.join(paths.artifactsDir, "identity-anchors-v0.4.json");
    atomicWriteJson(anchorsPath, bundle.identityAnchors.set);
    pathsWritten.push(anchorsPath);

    if (bundle.identityAnchors.proof) {
      const anchorProofPath = path.join(paths.artifactsDir, "identity-anchors-proof-v0.4.json");
      atomicWriteJson(anchorProofPath, bundle.identityAnchors.proof);
      pathsWritten.push(anchorProofPath);
    }
  }

  if (bundle.revocations) {
    const revocationsPath = path.join(paths.artifactsDir, "revocations-v0.4.json");
    atomicWriteJson(revocationsPath, bundle.revocations.set);
    pathsWritten.push(revocationsPath);

    if (bundle.revocations.proof) {
      const revocationProofPath = path.join(paths.artifactsDir, "revocations-proof-v0.4.json");
      atomicWriteJson(revocationProofPath, bundle.revocations.proof);
      pathsWritten.push(revocationProofPath);
    }
  }

  if (bundle.transparency?.head) {
    const headPath = path.join(paths.artifactsDir, "transparency-head-v0.4.json");
    atomicWriteJson(headPath, bundle.transparency.head);
    pathsWritten.push(headPath);
  }

  if (bundle.transparency?.latestCheckpoint) {
    const checkpointPath = path.join(paths.artifactsDir, "transparency-checkpoint-v0.4.json");
    atomicWriteJson(checkpointPath, bundle.transparency.latestCheckpoint);
    pathsWritten.push(checkpointPath);
  }

  const transparencyHead = deriveTransparencyHead(bundle);
  const bundleId = computeTrustBundleId(bundle);
  const appliedSnapshotId = `sha256:${createHash("sha256")
    .update(
      stableStringifyJson({
        bundleId,
        transparencyHeadChainHash: transparencyHead?.chainHash ?? null,
        transparencyHeadSize: transparencyHead?.size ?? null
      }),
      "utf8"
    )
    .digest("hex")}`;

  atomicWriteJson(paths.statePath, {
    ...(transparencyHead ? { transparencyHead } : {}),
    bundleId,
    appliedSnapshotId,
    fetchedAtMs: normalizeApplyTimestamp(opts.nowMs),
    source: "trust_bundle_apply"
  });
  pathsWritten.push(paths.statePath);

  return {
    applied: true,
    warnings: [],
    pathsWritten,
    revocationProofVerification
  };
}
