import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  IDENTITY_ANCHOR_TYPE,
  IDENTITY_PROTOCOL_VERSION,
  type IdentityAnchor
} from "../../protocol/identity-anchor";
import {
  normalizeTrustDistributionMode,
  resolveTrustDistributionSnapshot,
  type TrustDistributionMode
} from "./trust-distribution";

type PolicyMode = "off" | "warn" | "enforce";

interface LoggerLike {
  warn(event: unknown): void;
}

const DEFAULT_LOGGER: LoggerLike = {
  warn(event: unknown): void {
    console.warn(JSON.stringify(event));
  }
};

export interface IdentityAnchorLoadResult {
  readonly skipped: boolean;
  readonly mode: TrustDistributionMode;
  readonly sourcePath: string | null;
  readonly anchorsByKey: ReadonlyMap<string, IdentityAnchor>;
  readonly anchorCount: number;
}

function normalizeNonEmptyString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizePolicyMode(value: unknown): PolicyMode {
  const normalized = normalizeNonEmptyString(value).toLowerCase();
  if (normalized === "warn" || normalized === "enforce" || normalized === "off") {
    return normalized;
  }
  return "off";
}

function identityDistributionEnabled(env: NodeJS.ProcessEnv, mode: TrustDistributionMode): boolean {
  return (
    env.INTENTOS_PROTOCOL_VERSION === "0.4" &&
    env.INTENTOS_IDENTITY === "on" &&
    (mode === "fs" || mode === "http")
  );
}

function ensureNonEmptyString(value: unknown, code: string): string {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) {
    throw new Error(code);
  }
  return normalized;
}

function parseIdentityAnchor(raw: unknown, index: number): IdentityAnchor {
  if (!isPlainObject(raw)) {
    throw new Error(`identity_anchor_distribution_anchor_must_be_object:${index}`);
  }
  const allowedKeys = new Set([
    "type",
    "protocolVersion",
    "anchorId",
    "peerId",
    "publicKeyPem",
    "timestamp"
  ]);
  const unknownKeys = Object.keys(raw).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`identity_anchor_distribution_anchor_unknown_keys:${index}:${unknownKeys.join(",")}`);
  }
  if (raw.type !== IDENTITY_ANCHOR_TYPE) {
    throw new Error(`identity_anchor_distribution_anchor_type_invalid:${index}`);
  }
  if (raw.protocolVersion !== IDENTITY_PROTOCOL_VERSION) {
    throw new Error(`identity_anchor_distribution_anchor_protocol_version_invalid:${index}`);
  }
  return {
    type: IDENTITY_ANCHOR_TYPE,
    protocolVersion: IDENTITY_PROTOCOL_VERSION,
    anchorId: ensureNonEmptyString(raw.anchorId, `identity_anchor_distribution_anchor_id_missing:${index}`),
    peerId: ensureNonEmptyString(raw.peerId, `identity_anchor_distribution_peer_id_missing:${index}`),
    publicKeyPem: ensureNonEmptyString(
      raw.publicKeyPem,
      `identity_anchor_distribution_public_key_missing:${index}`
    ),
    timestamp: ensureNonEmptyString(raw.timestamp, `identity_anchor_distribution_timestamp_missing:${index}`)
  };
}

interface IdentityAnchorSetArtifact {
  readonly type: "identity-anchors";
  readonly protocolVersion: "0.4";
  readonly anchors: ReadonlyArray<IdentityAnchor>;
}

function parseIdentityAnchorSet(raw: string, sourcePath: string): IdentityAnchorSetArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`identity_anchor_distribution_invalid_json:${sourcePath}:${message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`identity_anchor_distribution_payload_must_be_object:${sourcePath}`);
  }
  const allowedKeys = new Set(["type", "protocolVersion", "anchors"]);
  const unknownKeys = Object.keys(parsed).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`identity_anchor_distribution_payload_unknown_keys:${sourcePath}:${unknownKeys.join(",")}`);
  }
  if (parsed.type !== "identity-anchors") {
    throw new Error(`identity_anchor_distribution_payload_type_invalid:${sourcePath}`);
  }
  if (parsed.protocolVersion !== "0.4") {
    throw new Error(`identity_anchor_distribution_payload_protocol_version_invalid:${sourcePath}`);
  }
  if (!Array.isArray(parsed.anchors)) {
    throw new Error(`identity_anchor_distribution_payload_anchors_must_be_array:${sourcePath}`);
  }
  const anchors = parsed.anchors.map((anchor, index) => parseIdentityAnchor(anchor, index));
  return {
    type: "identity-anchors",
    protocolVersion: "0.4",
    anchors
  };
}

export function computeIdentityAnchorFingerprint(publicKeyPem: string): string {
  return `sha256:${createHash("sha256").update(publicKeyPem, "utf8").digest("hex")}`;
}

function buildAnchorKeyMap(anchors: ReadonlyArray<IdentityAnchor>): Map<string, IdentityAnchor> {
  const map = new Map<string, IdentityAnchor>();
  for (const anchor of anchors) {
    const fingerprint = computeIdentityAnchorFingerprint(anchor.publicKeyPem);
    const keys = [anchor.anchorId, fingerprint];
    for (const key of keys) {
      const existing = map.get(key);
      if (existing && existing.anchorId !== anchor.anchorId) {
        throw new Error(`identity_anchor_distribution_key_collision:${key}`);
      }
      map.set(key, anchor);
    }
  }
  return map;
}

function onAnchorLoadError(
  distributionMode: TrustDistributionMode,
  mode: PolicyMode,
  error: unknown,
  logger: LoggerLike
): IdentityAnchorLoadResult {
  const message = error instanceof Error ? error.message : String(error);
  if (mode === "enforce") {
    throw new Error(message);
  }
  if (mode === "warn") {
    logger.warn({
      event: "intentos_identity_anchor_distribution",
      mode,
      diagnostic: message
    });
  }
  return {
    skipped: false,
    mode: distributionMode,
    sourcePath: null,
    anchorsByKey: new Map<string, IdentityAnchor>(),
    anchorCount: 0
  };
}

export function loadIdentityAnchorsFromDistribution(
  env: NodeJS.ProcessEnv = {},
  logger: LoggerLike = DEFAULT_LOGGER
): IdentityAnchorLoadResult {
  const distributionMode = normalizeTrustDistributionMode(env.INTENTOS_TRUST_DISTRIBUTION);
  if (!identityDistributionEnabled(env, distributionMode)) {
    return {
      skipped: true,
      mode: distributionMode,
      sourcePath: null,
      anchorsByKey: new Map<string, IdentityAnchor>(),
      anchorCount: 0
    };
  }

  const policyMode = normalizePolicyMode(env.INTENTOS_RECEIPT_POLICY);
  try {
    const snapshot = resolveTrustDistributionSnapshot(env);
    const sourcePath = snapshot?.identityAnchorsPath ?? null;
    if (!sourcePath) {
      return {
        skipped: false,
        mode: distributionMode,
        sourcePath: null,
        anchorsByKey: new Map<string, IdentityAnchor>(),
        anchorCount: 0
      };
    }
    const artifact = parseIdentityAnchorSet(readFileSync(sourcePath, "utf8"), sourcePath);
    const anchorsByKey = buildAnchorKeyMap(artifact.anchors);
    return {
      skipped: false,
      mode: distributionMode,
      sourcePath,
      anchorsByKey,
      anchorCount: artifact.anchors.length
    };
  } catch (error) {
    return onAnchorLoadError(distributionMode, policyMode, error, logger);
  }
}
