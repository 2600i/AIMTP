import {
  type TrustBundleV04,
  loadTrustBundleFromFile
} from "../../protocol/trust-bundle";
import {
  type RevocationProofVerificationResult,
  verifyRevocationProof
} from "./revocation-distribution";
import {
  normalizeTrustDistributionMode,
  resolveTrustDistributionSnapshot,
  type TrustDistributionMode
} from "./trust-distribution";

export type TrustBundleDistributionMode = "off" | "on";
export type TrustBundlePolicyMode = "off" | "warn" | "enforce";

const TRUST_BUNDLE_INVALID = "TRUST_BUNDLE_INVALID";

interface LoggerLike {
  warn(event: unknown): void;
}

const DEFAULT_LOGGER: LoggerLike = {
  warn(event: unknown): void {
    console.warn(JSON.stringify(event));
  }
};

export interface TrustBundleDistributionResult {
  readonly skipped: boolean;
  readonly mode: TrustDistributionMode;
  readonly distributionEnabled: boolean;
  readonly policyMode: TrustBundlePolicyMode;
  readonly sourcePath: string | null;
  readonly accepted: boolean;
  readonly warnings: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<string>;
  readonly bundle: TrustBundleV04 | null;
  readonly revocationProofVerification: RevocationProofVerificationResult | null;
}

function normalizeNonEmptyString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizeBundleMode(value: unknown): TrustBundleDistributionMode {
  const normalized = normalizeNonEmptyString(value).toLowerCase();
  if (normalized === "off" || normalized === "on") {
    return normalized;
  }
  return "off";
}

function normalizePolicyMode(value: unknown): TrustBundlePolicyMode {
  const normalized = normalizeNonEmptyString(value).toLowerCase();
  if (normalized === "off" || normalized === "warn" || normalized === "enforce") {
    return normalized;
  }
  return "off";
}

function normalizeTrustVersion(value: unknown): "v1" | "v2" {
  return normalizeNonEmptyString(value).toLowerCase() === "v2" ? "v2" : "v1";
}

function shouldLoadBundle(env: NodeJS.ProcessEnv, mode: TrustDistributionMode): boolean {
  return (
    env.INTENTOS_PROTOCOL_VERSION === "0.4" &&
    normalizeBundleMode(env.INTENTOS_TRUST_BUNDLE) === "on" &&
    (mode === "fs" || mode === "http")
  );
}

function toEmptyResult(
  mode: TrustDistributionMode,
  distributionEnabled: boolean,
  policyMode: TrustBundlePolicyMode,
  sourcePath: string | null
): TrustBundleDistributionResult {
  return {
    skipped: !distributionEnabled,
    mode,
    distributionEnabled,
    policyMode,
    sourcePath,
    accepted: true,
    warnings: [],
    errors: [],
    bundle: null,
    revocationProofVerification: null
  };
}

function applyInvalidByPolicy(
  mode: TrustDistributionMode,
  policyMode: TrustBundlePolicyMode,
  sourcePath: string | null,
  code: string,
  logger: LoggerLike
): TrustBundleDistributionResult {
  if (policyMode === "warn") {
    logger.warn({
      event: "intentos_trust_bundle_distribution",
      mode: policyMode,
      code,
      sourcePath
    });
    return {
      ...toEmptyResult(mode, true, policyMode, sourcePath),
      skipped: false,
      accepted: false,
      warnings: [code]
    };
  }

  return {
    ...toEmptyResult(mode, true, policyMode, sourcePath),
    skipped: false,
    accepted: false,
    errors: [code]
  };
}

function normalizeBundleDiagnostic(error: unknown, strictTrustV2: boolean): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message === "revocation_proof_missing" ||
    message === "revocation_proof_key_unknown" ||
    message === "revocation_proof_invalid"
  ) {
    return message;
  }
  return strictTrustV2 ? TRUST_BUNDLE_INVALID : "trust_bundle_invalid";
}

export function loadTrustBundleFromDistribution(
  env: NodeJS.ProcessEnv = {},
  logger: LoggerLike = DEFAULT_LOGGER
): TrustBundleDistributionResult {
  const mode = normalizeTrustDistributionMode(env.INTENTOS_TRUST_DISTRIBUTION);
  const distributionEnabled = shouldLoadBundle(env, mode);
  const strictTrustV2 = normalizeTrustVersion(env.INTENTOS_TRUST_VERSION) === "v2";
  const policyMode = strictTrustV2 ? "enforce" : normalizePolicyMode(env.INTENTOS_TRUST_BUNDLE_POLICY);

  if (!distributionEnabled) {
    return toEmptyResult(mode, false, policyMode, null);
  }

  if (policyMode === "off") {
    return {
      ...toEmptyResult(mode, true, policyMode, null),
      skipped: false
    };
  }

  let sourcePath: string | null = null;
  try {
    const snapshot = resolveTrustDistributionSnapshot(env);
    sourcePath = snapshot?.bundlePath ?? null;
    if (!sourcePath) {
      throw new Error("trust_bundle_invalid");
    }

    const bundle = loadTrustBundleFromFile(sourcePath);

    let revocationProofVerification: RevocationProofVerificationResult | null = null;
    const proofMode = normalizeBundleMode(env.INTENTOS_REVOCATION_PROOF);
    if (proofMode === "on" && bundle.revocations) {
      revocationProofVerification = verifyRevocationProof(
        bundle.revocations.set,
        bundle.revocations.proof,
        env.INTENTOS_TRUSTED_REVOCATION_KEYS_JSON
      );
      if (!revocationProofVerification.verified) {
        throw new Error(revocationProofVerification.code);
      }
    }

    return {
      skipped: false,
      mode,
      distributionEnabled: true,
      policyMode,
      sourcePath,
      accepted: true,
      warnings: [],
      errors: [],
      bundle,
      revocationProofVerification
    };
  } catch (error) {
    return applyInvalidByPolicy(
      mode,
      policyMode,
      sourcePath,
      normalizeBundleDiagnostic(error, strictTrustV2),
      logger
    );
  }
}
