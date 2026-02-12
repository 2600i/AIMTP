import { createHash } from "node:crypto";
import type { TransparencyHead } from "./trust-transparency";

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

export function canonicalizeTrustBundleForSigning(bundleObj: Record<string, unknown>): Buffer {
  return Buffer.from(
    stableStringifyJson({
      ...bundleObj,
      signature: undefined
    }),
    "utf8"
  );
}

function canonicalizeForId(value: unknown): Buffer {
  return Buffer.from(stableStringifyJson(value), "utf8");
}

export function sha256Hex(bytesOrString: string | Buffer | Uint8Array): string {
  return createHash("sha256").update(bytesOrString).digest("hex");
}

export function computeBundleId(bundleObj: Record<string, unknown>): string {
  return `sha256:${sha256Hex(canonicalizeTrustBundleForSigning(bundleObj))}`;
}

export function computeRevocationsId(revocationsObj: unknown): string {
  return `sha256:${sha256Hex(canonicalizeForId(revocationsObj))}`;
}

export interface AppliedSnapshotIdInput {
  readonly bundleId?: string;
  readonly revocationsId?: string;
  readonly transparencyHead?: TransparencyHead;
}

export function computeAppliedSnapshotId(input: AppliedSnapshotIdInput): string {
  const payload = {
    bundleId: input.bundleId ?? null,
    revocationsId: input.revocationsId ?? null,
    transparencyHeadChainHash: input.transparencyHead?.chainHash ?? null,
    transparencyHeadSize: input.transparencyHead?.size ?? null
  };
  return `sha256:${sha256Hex(canonicalizeForId(payload))}`;
}
