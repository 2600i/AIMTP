import { readFileSync } from "node:fs";
import type { IdentityAnchorSet } from "./identity-anchor";
import type { RevocationProofV04, RevocationSet } from "./revocation";

export const TRUST_BUNDLE_TYPE = "trust_bundle";
export const TRUST_BUNDLE_VERSION = "0.4";

export interface TrustBundleTransparencyHead {
  readonly size: number;
  readonly chainHash: string;
}

export interface TrustBundleTransparencyCheckpoint {
  readonly kind: "checkpoint";
  readonly size: number;
  readonly chainHash: string;
  readonly createdAt: string;
  readonly signer: string;
  readonly signature: string;
}

export interface TrustBundleTransparency {
  readonly head?: TrustBundleTransparencyHead;
  readonly latestCheckpoint?: TrustBundleTransparencyCheckpoint;
}

export interface TrustBundleIdentityAnchors {
  readonly set: IdentityAnchorSet;
  readonly proof?: Record<string, unknown>;
}

export interface TrustBundleRevocations {
  readonly set: RevocationSet;
  readonly proof?: RevocationProofV04;
}

export interface TrustBundleV04 {
  readonly type: typeof TRUST_BUNDLE_TYPE;
  readonly version: typeof TRUST_BUNDLE_VERSION;
  readonly createdAt: number;
  readonly issuer: string;
  readonly identityAnchors?: TrustBundleIdentityAnchors;
  readonly revocations?: TrustBundleRevocations;
  readonly transparency?: TrustBundleTransparency;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeNonEmptyString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function isUnixSeconds(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function hasOnlyKeys(obj: Record<string, unknown>, keys: ReadonlyArray<string>): boolean {
  const allowed = new Set(keys);
  return Object.keys(obj).every((key) => allowed.has(key));
}

function isIdentityAnchorSet(value: unknown): value is IdentityAnchorSet {
  if (!isPlainObject(value)) {
    return false;
  }
  if (!hasOnlyKeys(value, ["type", "protocolVersion", "setId", "anchors"])) {
    return false;
  }
  if (value.type !== "identity-anchors" || value.protocolVersion !== "0.4") {
    return false;
  }
  if (value.setId !== undefined && !normalizeNonEmptyString(value.setId)) {
    return false;
  }
  if (!Array.isArray(value.anchors)) {
    return false;
  }
  for (const anchor of value.anchors) {
    if (!isPlainObject(anchor)) {
      return false;
    }
    if (
      !hasOnlyKeys(anchor, [
        "type",
        "protocolVersion",
        "anchorId",
        "peerId",
        "publicKeyPem",
        "timestamp",
        "alg",
        "kid",
        "signature"
      ])
    ) {
      return false;
    }
    if (anchor.type !== "IdentityAnchor" || anchor.protocolVersion !== "0.4") {
      return false;
    }
    if (!normalizeNonEmptyString(anchor.anchorId)) {
      return false;
    }
    if (!normalizeNonEmptyString(anchor.peerId)) {
      return false;
    }
    if (!normalizeNonEmptyString(anchor.publicKeyPem)) {
      return false;
    }
    if (!normalizeNonEmptyString(anchor.timestamp)) {
      return false;
    }
    if (anchor.alg !== undefined && normalizeNonEmptyString(anchor.alg).toLowerCase() !== "ed25519") {
      return false;
    }
    if (anchor.kid !== undefined && !normalizeNonEmptyString(anchor.kid)) {
      return false;
    }
    if (anchor.signature !== undefined && !normalizeNonEmptyString(anchor.signature)) {
      return false;
    }
  }
  return true;
}

function isRevocationSet(value: unknown): value is RevocationSet {
  if (!isPlainObject(value)) {
    return false;
  }
  if (!hasOnlyKeys(value, ["type", "specVersion", "issuer", "issuedAt", "revocations"])) {
    return false;
  }
  if (value.type !== "revocations" || value.specVersion !== "0.4") {
    return false;
  }
  if (!normalizeNonEmptyString(value.issuer) || !isUnixSeconds(value.issuedAt)) {
    return false;
  }
  if (!Array.isArray(value.revocations)) {
    return false;
  }
  for (const entry of value.revocations) {
    if (!isPlainObject(entry)) {
      return false;
    }
    if (!hasOnlyKeys(entry, ["subject", "kind", "revokedAt", "reason", "evidence"])) {
      return false;
    }
    if (!normalizeNonEmptyString(entry.subject)) {
      return false;
    }
    if (entry.kind !== "peer" && entry.kind !== "key" && entry.kind !== "anchor") {
      return false;
    }
    if (!isUnixSeconds(entry.revokedAt)) {
      return false;
    }
    if (entry.reason !== undefined && !normalizeNonEmptyString(entry.reason)) {
      return false;
    }
    if (entry.evidence !== undefined && !normalizeNonEmptyString(entry.evidence)) {
      return false;
    }
  }
  return true;
}

function isRevocationProof(value: unknown): value is RevocationProofV04 {
  if (!isPlainObject(value)) {
    return false;
  }
  if (!hasOnlyKeys(value, ["type", "version", "keyId", "alg", "createdAt", "signature", "revocationSetId"])) {
    return false;
  }
  if (value.type !== "RevocationProof" || value.version !== "0.4") {
    return false;
  }
  if (!normalizeNonEmptyString(value.keyId)) {
    return false;
  }
  if (normalizeNonEmptyString(value.alg).toLowerCase() !== "ed25519") {
    return false;
  }
  if (!isUnixSeconds(value.createdAt)) {
    return false;
  }
  if (!normalizeNonEmptyString(value.signature)) {
    return false;
  }
  if (value.revocationSetId !== undefined && !normalizeNonEmptyString(value.revocationSetId)) {
    return false;
  }
  return true;
}

function isTransparencyHead(value: unknown): value is TrustBundleTransparencyHead {
  if (!isPlainObject(value)) {
    return false;
  }
  if (!hasOnlyKeys(value, ["size", "chainHash"])) {
    return false;
  }
  return isUnixSeconds(value.size) && normalizeNonEmptyString(value.chainHash).length > 0;
}

function isTransparencyCheckpoint(value: unknown): value is TrustBundleTransparencyCheckpoint {
  if (!isPlainObject(value)) {
    return false;
  }
  if (!hasOnlyKeys(value, ["kind", "size", "chainHash", "createdAt", "signer", "signature"])) {
    return false;
  }
  if (value.kind !== "checkpoint") {
    return false;
  }
  if (!isUnixSeconds(value.size)) {
    return false;
  }
  if (!normalizeNonEmptyString(value.chainHash)) {
    return false;
  }
  if (!normalizeNonEmptyString(value.createdAt)) {
    return false;
  }
  if (!normalizeNonEmptyString(value.signer)) {
    return false;
  }
  if (!normalizeNonEmptyString(value.signature)) {
    return false;
  }
  return true;
}

function isTransparency(value: unknown): value is TrustBundleTransparency {
  if (!isPlainObject(value)) {
    return false;
  }
  if (!hasOnlyKeys(value, ["head", "latestCheckpoint"])) {
    return false;
  }
  if (value.head !== undefined && !isTransparencyHead(value.head)) {
    return false;
  }
  if (value.latestCheckpoint !== undefined && !isTransparencyCheckpoint(value.latestCheckpoint)) {
    return false;
  }
  return true;
}

export function isTrustBundleV04(value: unknown): value is TrustBundleV04 {
  if (!isPlainObject(value)) {
    return false;
  }
  if (!hasOnlyKeys(value, ["type", "version", "createdAt", "issuer", "identityAnchors", "revocations", "transparency"])) {
    return false;
  }
  if (value.type !== TRUST_BUNDLE_TYPE || value.version !== TRUST_BUNDLE_VERSION) {
    return false;
  }
  if (!isUnixSeconds(value.createdAt)) {
    return false;
  }
  if (!normalizeNonEmptyString(value.issuer)) {
    return false;
  }

  if (value.identityAnchors !== undefined) {
    if (!isPlainObject(value.identityAnchors)) {
      return false;
    }
    if (!hasOnlyKeys(value.identityAnchors, ["set", "proof"])) {
      return false;
    }
    if (!isIdentityAnchorSet(value.identityAnchors.set)) {
      return false;
    }
    if (value.identityAnchors.proof !== undefined && !isPlainObject(value.identityAnchors.proof)) {
      return false;
    }
  }

  if (value.revocations !== undefined) {
    if (!isPlainObject(value.revocations)) {
      return false;
    }
    if (!hasOnlyKeys(value.revocations, ["set", "proof"])) {
      return false;
    }
    if (!isRevocationSet(value.revocations.set)) {
      return false;
    }
    if (value.revocations.proof !== undefined && !isRevocationProof(value.revocations.proof)) {
      return false;
    }
  }

  if (value.transparency !== undefined && !isTransparency(value.transparency)) {
    return false;
  }

  return true;
}

export function loadTrustBundleFromFile(filePath: string): TrustBundleV04 {
  const raw = readFileSync(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`trust_bundle_invalid_json:${message}`);
  }

  if (!isTrustBundleV04(parsed)) {
    throw new Error("trust_bundle_invalid");
  }

  return parsed;
}
