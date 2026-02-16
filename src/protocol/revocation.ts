import { createHash } from "node:crypto";

export const REVOCATION_SET_TYPE = "revocations";
export const REVOCATION_PROOF_TYPE = "RevocationProof";
export const REVOCATION_PROTOCOL_VERSION = "0.4";
export const REVOCATION_SIGNATURE_ALG = "ed25519";

export type RevocationKind = "peer" | "key" | "anchor";

export interface RevocationEntry {
  subject: string;
  kind: RevocationKind;
  revokedAt: number;
  reason?: string;
  evidence?: string;
}

export interface RevocationSet {
  type: typeof REVOCATION_SET_TYPE;
  specVersion: typeof REVOCATION_PROTOCOL_VERSION;
  issuer: string;
  issuedAt: number;
  revocations: ReadonlyArray<RevocationEntry>;
}

export interface RevocationProofV04 {
  type: typeof REVOCATION_PROOF_TYPE;
  version: typeof REVOCATION_PROTOCOL_VERSION;
  keyId: string;
  alg: typeof REVOCATION_SIGNATURE_ALG;
  createdAt: number;
  signature: string;
  revocationSetId?: string;
}

export type RevocationSetV04 = RevocationSet;

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

export function canonicalizeRevocationSetForSigning(set: RevocationSet): Buffer {
  return Buffer.from(
    stableStringifyJson({
      type: set.type,
      specVersion: set.specVersion,
      issuer: set.issuer,
      issuedAt: set.issuedAt,
      revocations: set.revocations
    }),
    "utf8"
  );
}

export function computeRevocationSetId(set: RevocationSet): string {
  return `sha256:${createHash("sha256").update(canonicalizeRevocationSetForSigning(set)).digest("hex")}`;
}
