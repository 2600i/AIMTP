import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Receipt, signReceipt } from "../src/protocol/intentos-receipts";
import { processReceiptEnvelope, type ReceiptPolicyLogger } from "../src/runtime/intentos/receipt-policy";
import * as trustDistribution from "../src/runtime/intentos/trust-distribution";
import { evaluateTrustSnapshot } from "../src/runtime/intentos/trust-snapshot-policy";
import { FileTrustSnapshotStore } from "../src/runtime/intentos/trust-snapshot-store";
import {
  appendTransparencyEntry,
  createCheckpoint,
  loadTransparencyLog
} from "../src/runtime/intentos/trust-transparency";

function baseReceipt(): Receipt {
  return {
    receiptId: "receipt-policy-001",
    envelopeId: "env-policy-001",
    intentId: "intent-policy-001",
    type: "receipt.completed",
    timestamp: "2026-02-10T10:00:00.000Z",
    metadata: { outputHash: "abc123" }
  };
}

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

function canonicalizeTrustBundleForSigning(bundle: Record<string, unknown>): Buffer {
  return Buffer.from(
    stableStringifyJson({
      ...bundle,
      signature: undefined
    }),
    "utf8"
  );
}

function signTrustBundle(
  bundle: Record<string, unknown>,
  signer: string,
  privateKeyPem: string
): Record<string, unknown> {
  const signable = {
    ...bundle,
    signer,
    sigAlg: "ed25519",
    signature: undefined
  };
  const signature = signBytes(null, canonicalizeTrustBundleForSigning(signable), privateKeyPem).toString(
    "base64"
  );
  return {
    ...signable,
    signature
  };
}

function computeBundleKeyFingerprint(publicKeyPem: string): string {
  const normalizedPem = publicKeyPem.replace(/\r\n/g, "\n").trim();
  return createHash("sha256").update(normalizedPem).digest("hex").slice(0, 12);
}

describe("IntentOS receipt policy enforcement", () => {
  const issuer = "relay://policy-test";
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const bundleSigner = "signer://policy-admin";
  const { publicKey: bundleSignerPublicKey, privateKey: bundleSignerPrivateKey } =
    generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const bundleSignerPrivateKeyPem = bundleSignerPrivateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const bundleSignerPublicKeyPem = bundleSignerPublicKey.export({ type: "spki", format: "pem" }).toString();
  const trustedKeys = Object.freeze({ [issuer]: publicKeyPem });
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dirPath = tempDirs.pop();
      if (dirPath) {
        rmSync(dirPath, { recursive: true, force: true });
      }
    }
  });

  function writeTrustBundle(bundle: unknown): string {
    const dirPath = mkdtempSync(path.join(tmpdir(), "intentos-trust-bundle-"));
    tempDirs.push(dirPath);
    const filePath = path.join(dirPath, "trust-bundle.json");
    writeFileSync(filePath, JSON.stringify(bundle), "utf8");
    return filePath;
  }

  function writeTransparencyLog(lines: ReadonlyArray<unknown>): string {
    const dirPath = mkdtempSync(path.join(tmpdir(), "intentos-transparency-log-"));
    tempDirs.push(dirPath);
    const filePath = path.join(dirPath, "trust-log.jsonl");
    const content =
      lines.length > 0 ? `${lines.map((line) => JSON.stringify(line)).join("\n")}\n` : "";
    writeFileSync(filePath, content, "utf8");
    return filePath;
  }

  function writeTrustRevocations(payload: unknown): string {
    const dirPath = mkdtempSync(path.join(tmpdir(), "intentos-trust-revocations-"));
    tempDirs.push(dirPath);
    const filePath = path.join(dirPath, "trust-revocations.json");
    writeFileSync(filePath, JSON.stringify(payload), "utf8");
    return filePath;
  }

  function receiptWithNumericTimestampFixture(): Receipt {
    const fixturePath = path.join(__dirname, "fixtures", "intentos-receipt-numeric-timestamp.json");
    return JSON.parse(readFileSync(fixturePath, "utf8")) as Receipt;
  }

  function parseWarnJsonPayload(warnArg: unknown): Record<string, unknown> {
    expect(typeof warnArg).toBe("string");
    return JSON.parse(String(warnArg)) as Record<string, unknown>;
  }

  function baseUnsignedV3Bundle(): Record<string, unknown> {
    return {
      bundleVersion: "v3",
      bundleId: "trust-bundle-policy-v3",
      issuedAtSec: 1767225600,
      issuers: {
        [issuer]: {
          keys: [
            {
              kid: "relay-a",
              alg: "ed25519",
              publicKeyPem
            }
          ]
        }
      }
    };
  }

  test("default behavior remains v1/off when trust version is not set", () => {
    const logger = { warn: jest.fn() } satisfies ReceiptPolicyLogger;
    const result = processReceiptEnvelope({ receipt: baseReceipt() }, { logger });
    expect(result.mode).toBe("off");
    expect(result.trustVersion).toBe("v1");
    expect(result.accepted).toBe(true);
    expect(result.trusted).toBe(false);
    expect(result.reason).toBe("missing signature");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("off mode: unverified receipt passes", () => {
    const logger = { warn: jest.fn() } satisfies ReceiptPolicyLogger;
    const result = processReceiptEnvelope({ receipt: baseReceipt() }, { mode: "off", logger });
    expect(result.accepted).toBe(true);
    expect(result.trusted).toBe(false);
    expect(result.reason).toBe("missing signature");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("warn mode: unverified receipt passes and warning is emitted", () => {
    const logger = { warn: jest.fn() } satisfies ReceiptPolicyLogger;
    const result = processReceiptEnvelope({ receipt: baseReceipt() }, { mode: "warn", logger });
    expect(result.accepted).toBe(true);
    expect(result.trusted).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "intentos_receipt_policy_warning",
        mode: "warn",
        reason: "missing signature"
      })
    );
  });

  test("enforce mode: unverified receipt is rejected", () => {
    const logger = { warn: jest.fn() } satisfies ReceiptPolicyLogger;
    const result = processReceiptEnvelope({ receipt: baseReceipt() }, { mode: "enforce", logger });
    expect(result.accepted).toBe(false);
    expect(result.trusted).toBe(false);
    expect(result.reason).toBe("missing signature");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("verified receipt passes in off, warn, and enforce modes", () => {
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer);
    (["off", "warn", "enforce"] as const).forEach((mode) => {
      const logger = { warn: jest.fn() } satisfies ReceiptPolicyLogger;
      const result = processReceiptEnvelope(
        { receipt: signed },
        { mode, trustedReceiptKeys: trustedKeys, logger }
      );
      expect(result.accepted).toBe(true);
      expect(result.trusted).toBe(true);
      expect(result.reason).toBe("signature valid");
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  test("v2 enforce rejects unsigned terminal receipts", () => {
    const logger = { warn: jest.fn() } satisfies ReceiptPolicyLogger;
    const result = processReceiptEnvelope(
      { receipt: baseReceipt() },
      { mode: "enforce", trustVersion: "v2", logger }
    );
    expect(result.accepted).toBe(false);
    expect(result.trusted).toBe(false);
    expect(result.trustVersion).toBe("v2");
    expect(result.reason).toBe("missing signature for terminal receipt");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("v2 warn emits warnings for unsigned/untrusted receipts", () => {
    const logger = { warn: jest.fn() } satisfies ReceiptPolicyLogger;
    const result = processReceiptEnvelope(
      { receipt: baseReceipt() },
      { mode: "warn", trustVersion: "v2", logger }
    );
    expect(result.accepted).toBe(true);
    expect(result.trusted).toBe(false);
    expect(result.reason).toBe("missing signature for terminal receipt");
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test("v2 enforce accepts signed and verified receipts", () => {
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const logger = { warn: jest.fn() } satisfies ReceiptPolicyLogger;
    const result = processReceiptEnvelope(
      { receipt: signed },
      { mode: "enforce", trustVersion: "v2", trustedReceiptKeys: trustedKeys, logger }
    );
    expect(result.accepted).toBe(true);
    expect(result.trusted).toBe(true);
    expect(result.reason).toBe("signature valid");
    expect(result.trustVersion).toBe("v2");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("loads trusted keys from bundle path when provided", () => {
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const trustBundlePath = writeTrustBundle({
      bundleVersion: "intentos-trust-bundle/v1",
      issuers: {
        [issuer]: {
          keys: [
            {
              kid: "relay-a",
              alg: "ed25519",
              publicKeyPem
            }
          ]
        }
      }
    });
    const logger = { warn: jest.fn() } satisfies ReceiptPolicyLogger;
    const result = processReceiptEnvelope(
      { receipt: signed },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: { INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath },
        logger
      }
    );
    expect(result.accepted).toBe(true);
    expect(result.trusted).toBe(true);
    expect(result.reason).toBe("signature valid");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("loads unsigned bundle when signature requirement is off", () => {
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const trustBundlePath = writeTrustBundle(baseUnsignedV3Bundle());
    const result = processReceiptEnvelope(
      { receipt: signed },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: {
          INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath,
          INTENTOS_TRUST_BUNDLE_REQUIRE_SIGNATURE: "off"
        }
      }
    );
    expect(result.accepted).toBe(true);
    expect(result.trusted).toBe(true);
    expect(result.reason).toBe("signature valid");
  });

  test("rejects unsigned bundle when signature requirement is on", () => {
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const trustBundlePath = writeTrustBundle(baseUnsignedV3Bundle());
    const result = processReceiptEnvelope(
      { receipt: signed },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: {
          INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath,
          INTENTOS_TRUST_BUNDLE_REQUIRE_SIGNATURE: "on",
          INTENTOS_TRUST_BUNDLE_TRUSTED_SIGNERS_JSON: JSON.stringify({
            [bundleSigner]: bundleSignerPublicKeyPem
          })
        }
      }
    );
    expect(result.accepted).toBe(false);
    expect(result.trusted).toBe(false);
    expect(result.reason).toContain("trusted key config: bundle signature required");
  });

  test("accepts signed bundle when trusted signer is configured", () => {
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const trustBundle = signTrustBundle(baseUnsignedV3Bundle(), bundleSigner, bundleSignerPrivateKeyPem);
    const trustBundlePath = writeTrustBundle(trustBundle);
    const result = processReceiptEnvelope(
      { receipt: signed },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: {
          INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath,
          INTENTOS_TRUST_BUNDLE_REQUIRE_SIGNATURE: "on",
          INTENTOS_TRUST_BUNDLE_TRUSTED_SIGNERS_JSON: JSON.stringify({
            [bundleSigner]: bundleSignerPublicKeyPem
          })
        }
      }
    );
    expect(result.accepted).toBe(true);
    expect(result.trusted).toBe(true);
    expect(result.reason).toBe("signature valid");
  });

  test("rejects signed bundle when signer is not trusted", () => {
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const trustBundle = signTrustBundle(baseUnsignedV3Bundle(), bundleSigner, bundleSignerPrivateKeyPem);
    const trustBundlePath = writeTrustBundle(trustBundle);
    const result = processReceiptEnvelope(
      { receipt: signed },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: {
          INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath,
          INTENTOS_TRUST_BUNDLE_REQUIRE_SIGNATURE: "on",
          INTENTOS_TRUST_BUNDLE_TRUSTED_SIGNERS_JSON: JSON.stringify({
            "signer://someone-else": bundleSignerPublicKeyPem
          })
        }
      }
    );
    expect(result.accepted).toBe(false);
    expect(result.trusted).toBe(false);
    expect(result.reason).toContain("trusted key config: unknown bundle signer");
  });

  test("rejects tampered signed bundle", () => {
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const trustBundle = signTrustBundle(baseUnsignedV3Bundle(), bundleSigner, bundleSignerPrivateKeyPem);
    const tamperedTrustBundle = {
      ...trustBundle,
      bundleId: "trust-bundle-policy-v3-tampered"
    };
    const trustBundlePath = writeTrustBundle(tamperedTrustBundle);
    const result = processReceiptEnvelope(
      { receipt: signed },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: {
          INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath,
          INTENTOS_TRUST_BUNDLE_REQUIRE_SIGNATURE: "on",
          INTENTOS_TRUST_BUNDLE_TRUSTED_SIGNERS_JSON: JSON.stringify({
            [bundleSigner]: bundleSignerPublicKeyPem
          })
        }
      }
    );
    expect(result.accepted).toBe(false);
    expect(result.trusted).toBe(false);
    expect(result.reason).toContain("trusted key config: bundle signature invalid");
  });

  test("rejects signer not in allowlist", () => {
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const trustBundle = signTrustBundle(baseUnsignedV3Bundle(), bundleSigner, bundleSignerPrivateKeyPem);
    const trustBundlePath = writeTrustBundle(trustBundle);
    const result = processReceiptEnvelope(
      { receipt: signed },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: {
          INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath,
          INTENTOS_TRUST_BUNDLE_REQUIRE_SIGNATURE: "on",
          INTENTOS_TRUST_BUNDLE_TRUSTED_SIGNERS_JSON: JSON.stringify({
            [bundleSigner]: bundleSignerPublicKeyPem
          }),
          INTENTOS_TRUST_BUNDLE_SIGNER_ALLOWLIST: "signer://another-admin"
        }
      }
    );
    expect(result.accepted).toBe(false);
    expect(result.trusted).toBe(false);
    expect(result.reason).toContain("trusted key config: bundle signer not allowed");
  });

  test("rejects bundle when signer is revoked and signature is required", () => {
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const trustBundle = signTrustBundle(baseUnsignedV3Bundle(), bundleSigner, bundleSignerPrivateKeyPem);
    const trustBundlePath = writeTrustBundle({
      ...trustBundle,
      revocations: {
        signers: [bundleSigner]
      }
    });
    const result = processReceiptEnvelope(
      { receipt: signed },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: {
          INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath,
          INTENTOS_TRUST_BUNDLE_REQUIRE_SIGNATURE: "on",
          INTENTOS_TRUST_BUNDLE_TRUSTED_SIGNERS_JSON: JSON.stringify({
            [bundleSigner]: bundleSignerPublicKeyPem
          })
        }
      }
    );
    expect(result.accepted).toBe(false);
    expect(result.trusted).toBe(false);
    expect(result.reason).toContain("trusted key config: bundle signer revoked");
  });

  test("revoked signer does not block when signature requirement is off", () => {
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const trustBundlePath = writeTrustBundle({
      ...baseUnsignedV3Bundle(),
      signer: bundleSigner,
      revocations: {
        signers: [bundleSigner]
      }
    });
    const result = processReceiptEnvelope(
      { receipt: signed },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: {
          INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath,
          INTENTOS_TRUST_BUNDLE_REQUIRE_SIGNATURE: "off"
        }
      }
    );
    expect(result.accepted).toBe(true);
    expect(result.trusted).toBe(true);
    expect(result.reason).toBe("signature valid");
  });

  test("canonicalization is deterministic for signed bundle verification", () => {
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const signedBundle = signTrustBundle(baseUnsignedV3Bundle(), bundleSigner, bundleSignerPrivateKeyPem);
    const reorderedBundle: Record<string, unknown> = {
      signer: signedBundle.signer,
      issuedAtSec: signedBundle.issuedAtSec,
      sigAlg: signedBundle.sigAlg,
      bundleId: signedBundle.bundleId,
      signature: signedBundle.signature,
      bundleVersion: signedBundle.bundleVersion,
      issuers: {
        [issuer]: {
          keys: [
            {
              publicKeyPem,
              kid: "relay-a",
              alg: "ed25519"
            }
          ]
        }
      }
    };
    const trustBundlePath = writeTrustBundle(reorderedBundle);
    const result = processReceiptEnvelope(
      { receipt: signed },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: {
          INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath,
          INTENTOS_TRUST_BUNDLE_REQUIRE_SIGNATURE: "on",
          INTENTOS_TRUST_BUNDLE_TRUSTED_SIGNERS_JSON: JSON.stringify({
            [bundleSigner]: bundleSignerPublicKeyPem
          })
        }
      }
    );
    expect(result.accepted).toBe(true);
    expect(result.trusted).toBe(true);
    expect(result.reason).toBe("signature valid");
  });

  test("bundle validity window: active key accepts", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const trustBundlePath = writeTrustBundle({
      bundleVersion: "intentos-trust-bundle/v1",
      issuers: {
        [issuer]: {
          keys: [
            {
              kid: "relay-a",
              alg: "ed25519",
              notBefore: nowSec - 60,
              notAfter: nowSec + 60,
              publicKeyPem
            }
          ]
        }
      }
    });

    const result = processReceiptEnvelope(
      { receipt: signed },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: { INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath }
      }
    );
    expect(result.accepted).toBe(true);
    expect(result.trusted).toBe(true);
    expect(result.reason).toBe("signature valid");
  });

  test("bundle validity window: not-yet-valid key rejects with no active key", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const trustBundlePath = writeTrustBundle({
      bundleVersion: "intentos-trust-bundle/v1",
      issuers: {
        [issuer]: {
          keys: [
            {
              kid: "relay-a",
              alg: "ed25519",
              notBefore: nowSec + 300,
              notAfter: nowSec + 900,
              publicKeyPem
            }
          ]
        }
      }
    });

    const result = processReceiptEnvelope(
      { receipt: signed },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: { INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath }
      }
    );
    expect(result.accepted).toBe(false);
    expect(result.trusted).toBe(false);
    expect(result.reason).toBe("no active key for issuer");
  });

  test("bundle validity window: expired key rejects with no active key", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const trustBundlePath = writeTrustBundle({
      bundleVersion: "intentos-trust-bundle/v1",
      issuers: {
        [issuer]: {
          keys: [
            {
              kid: "relay-a",
              alg: "ed25519",
              notBefore: nowSec - 900,
              notAfter: nowSec - 300,
              publicKeyPem
            }
          ]
        }
      }
    });

    const result = processReceiptEnvelope(
      { receipt: signed },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: { INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath }
      }
    );
    expect(result.accepted).toBe(false);
    expect(result.trusted).toBe(false);
    expect(result.reason).toBe("no active key for issuer");
  });

  test("bundle verification rejects unknown issuer", () => {
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const trustBundlePath = writeTrustBundle({
      bundleVersion: "intentos-trust-bundle/v1",
      issuers: {
        "relay://other-issuer": {
          keys: [
            {
              kid: "relay-other",
              alg: "ed25519",
              publicKeyPem
            }
          ]
        }
      }
    });

    const result = processReceiptEnvelope(
      { receipt: signed },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: { INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath }
      }
    );
    expect(result.accepted).toBe(false);
    expect(result.trusted).toBe(false);
    expect(result.reason).toBe("unknown issuer");
  });

  test("bundle validity window: expired old key plus active new key succeeds", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const { publicKey: oldPublicKey } = generateKeyPairSync("ed25519");
    const oldPublicKeyPem = oldPublicKey.export({ type: "spki", format: "pem" }).toString();
    const trustBundlePath = writeTrustBundle({
      bundleVersion: "intentos-trust-bundle/v1",
      issuers: {
        [issuer]: {
          keys: [
            {
              kid: "relay-old",
              alg: "ed25519",
              notBefore: nowSec - 900,
              notAfter: nowSec - 300,
              publicKeyPem: oldPublicKeyPem
            },
            {
              kid: "relay-new",
              alg: "ed25519",
              notBefore: nowSec - 60,
              notAfter: nowSec + 900,
              publicKeyPem
            }
          ]
        }
      }
    });

    const result = processReceiptEnvelope(
      { receipt: signed },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: { INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath }
      }
    );
    expect(result.accepted).toBe(true);
    expect(result.trusted).toBe(true);
    expect(result.reason).toBe("signature valid");
  });

  test("bundle key rotation succeeds when first active key fails and second active key verifies", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const { publicKey: wrongPublicKey } = generateKeyPairSync("ed25519");
    const wrongPublicKeyPem = wrongPublicKey.export({ type: "spki", format: "pem" }).toString();
    const trustBundlePath = writeTrustBundle({
      bundleVersion: "intentos-trust-bundle/v1",
      issuers: {
        [issuer]: {
          keys: [
            {
              kid: "relay-rotation-old",
              alg: "ed25519",
              notBefore: nowSec - 120,
              notAfter: nowSec + 120,
              publicKeyPem: wrongPublicKeyPem
            },
            {
              kid: "relay-rotation-new",
              alg: "ed25519",
              notBefore: nowSec - 120,
              notAfter: nowSec + 120,
              publicKeyPem
            }
          ]
        }
      }
    });

    const result = processReceiptEnvelope(
      { receipt: signed },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: { INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath }
      }
    );
    expect(result.accepted).toBe(true);
    expect(result.trusted).toBe(true);
    expect(result.reason).toBe("signature valid");
  });

  test("revoked issuer key is excluded and rotation still succeeds with alternate key", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const { publicKey: revokedPublicKey, privateKey: revokedPrivateKey } = generateKeyPairSync("ed25519");
    const { publicKey: alternatePublicKey, privateKey: alternatePrivateKey } = generateKeyPairSync("ed25519");
    const revokedPublicKeyPem = revokedPublicKey.export({ type: "spki", format: "pem" }).toString();
    const revokedPrivateKeyPem = revokedPrivateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const alternatePublicKeyPem = alternatePublicKey.export({ type: "spki", format: "pem" }).toString();
    const alternatePrivateKeyPem = alternatePrivateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const revokedFingerprint = computeBundleKeyFingerprint(revokedPublicKeyPem);
    const trustBundlePath = writeTrustBundle({
      bundleVersion: "v3",
      bundleId: "trust-bundle-revocation-rotation",
      issuedAtSec: nowSec - 30,
      issuers: {
        [issuer]: {
          keys: [
            {
              kid: "relay-revoked",
              alg: "ed25519",
              notBefore: nowSec - 120,
              notAfter: nowSec + 120,
              publicKeyPem: revokedPublicKeyPem
            },
            {
              kid: "relay-alternate",
              alg: "ed25519",
              notBefore: nowSec - 120,
              notAfter: nowSec + 120,
              publicKeyPem: alternatePublicKeyPem
            }
          ]
        }
      },
      revocations: {
        issuerKeys: {
          [issuer]: [revokedFingerprint]
        }
      }
    });

    const revokedSigned = signReceipt(baseReceipt(), revokedPrivateKeyPem, issuer, { trustVersion: "v2" });
    const revokedResult = processReceiptEnvelope(
      { receipt: revokedSigned },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: { INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath }
      }
    );
    expect(revokedResult.accepted).toBe(false);
    expect(revokedResult.trusted).toBe(false);
    expect(revokedResult.reason).toBe("signature invalid for all active keys");

    const alternateSigned = signReceipt(baseReceipt(), alternatePrivateKeyPem, issuer, { trustVersion: "v2" });
    const alternateResult = processReceiptEnvelope(
      { receipt: alternateSigned },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: { INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath }
      }
    );
    expect(alternateResult.accepted).toBe(true);
    expect(alternateResult.trusted).toBe(true);
    expect(alternateResult.reason).toBe("signature valid");
  });

  test("bundle verification returns specific reason when all active keys fail", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const { publicKey: wrongPublicKeyA } = generateKeyPairSync("ed25519");
    const { publicKey: wrongPublicKeyB } = generateKeyPairSync("ed25519");
    const wrongPublicKeyPemA = wrongPublicKeyA.export({ type: "spki", format: "pem" }).toString();
    const wrongPublicKeyPemB = wrongPublicKeyB.export({ type: "spki", format: "pem" }).toString();
    const trustBundlePath = writeTrustBundle({
      bundleVersion: "intentos-trust-bundle/v1",
      issuers: {
        [issuer]: {
          keys: [
            {
              kid: "relay-a",
              alg: "ed25519",
              notBefore: nowSec - 120,
              notAfter: nowSec + 120,
              publicKeyPem: wrongPublicKeyPemA
            },
            {
              kid: "relay-b",
              alg: "ed25519",
              notBefore: nowSec - 120,
              notAfter: nowSec + 120,
              publicKeyPem: wrongPublicKeyPemB
            }
          ]
        }
      }
    });

    const result = processReceiptEnvelope(
      { receipt: signed },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: { INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath }
      }
    );
    expect(result.accepted).toBe(false);
    expect(result.trusted).toBe(false);
    expect(result.reason).toBe("signature invalid for all active keys");
  });

  test("bundle evaluation time uses numeric receipt.timestamp when present", () => {
    const fixtureReceipt = receiptWithNumericTimestampFixture();
    const signed = signReceipt(fixtureReceipt, privateKeyPem, issuer, { trustVersion: "v2" });
    const timestampSec = Number((fixtureReceipt as { timestamp?: unknown }).timestamp);
    const trustBundlePath = writeTrustBundle({
      bundleVersion: "intentos-trust-bundle/v1",
      issuers: {
        [issuer]: {
          keys: [
            {
              kid: "relay-a",
              alg: "ed25519",
              notBefore: timestampSec - 10,
              notAfter: timestampSec + 10,
              publicKeyPem
            }
          ]
        }
      }
    });

    const result = processReceiptEnvelope(
      { receipt: signed },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: { INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath }
      }
    );
    expect(result.accepted).toBe(true);
    expect(result.trusted).toBe(true);
    expect(result.reason).toBe("signature valid");
  });

  test("warn mode emits bundle diagnostics event with expected fields", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const wrongPublicKeys = Array.from({ length: 4 }, () => generateKeyPairSync("ed25519").publicKey);
    const trustBundlePath = writeTrustBundle({
      bundleVersion: "intentos-trust-bundle/v1",
      issuers: {
        [issuer]: {
          keys: wrongPublicKeys.map((wrongPublicKey, index) => ({
            kid: `relay-warn-${index + 1}`,
            alg: "ed25519",
            notBefore: nowSec - 120,
            notAfter: nowSec + 120,
            publicKeyPem: wrongPublicKey.export({ type: "spki", format: "pem" }).toString()
          }))
        }
      }
    });

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = processReceiptEnvelope(
        { receipt: signed },
        {
          mode: "warn",
          trustVersion: "v2",
          env: { INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath }
        }
      );
      expect(result.accepted).toBe(true);
      expect(result.trusted).toBe(false);
      expect(result.reason).toBe("signature invalid for all active keys");

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const event = parseWarnJsonPayload(warnSpy.mock.calls[0][0]);
      expect(event.event).toBe("intentos_trust_bundle_verify_attempts");
      expect(event.reason).toBe("signature invalid for all active keys");
      expect(event.issuer).toBe(issuer);
      expect(event.trustVersion).toBe("v2");
      expect(event.keysTotal).toBe(4);
      expect(event.keysActive).toBe(4);
      expect(event.attemptReasons).toEqual(expect.any(Array));
      expect((event.attemptReasons as unknown[]).length).toBe(3);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("bundle diagnostics logs only in warn mode", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const { publicKey: wrongPublicKey } = generateKeyPairSync("ed25519");
    const wrongPublicKeyPem = wrongPublicKey.export({ type: "spki", format: "pem" }).toString();
    const trustBundlePath = writeTrustBundle({
      bundleVersion: "intentos-trust-bundle/v1",
      issuers: {
        [issuer]: {
          keys: [
            {
              kid: "relay-only-warn",
              alg: "ed25519",
              notBefore: nowSec - 120,
              notAfter: nowSec + 120,
              publicKeyPem: wrongPublicKeyPem
            }
          ]
        }
      }
    });

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      processReceiptEnvelope(
        { receipt: signed },
        {
          mode: "off",
          trustVersion: "v2",
          env: { INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath }
        }
      );
      processReceiptEnvelope(
        { receipt: signed },
        {
          mode: "enforce",
          trustVersion: "v2",
          env: { INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath }
        }
      );
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("bundle key fingerprint remains stable across repeated evaluations", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const { publicKey: wrongPublicKey } = generateKeyPairSync("ed25519");
    const wrongPublicKeyPem = wrongPublicKey.export({ type: "spki", format: "pem" }).toString();
    const trustBundlePath = writeTrustBundle({
      bundleVersion: "intentos-trust-bundle/v1",
      issuers: {
        [issuer]: {
          keys: [
            {
              kid: "relay-fingerprint",
              alg: "ed25519",
              notBefore: nowSec - 120,
              notAfter: nowSec + 120,
              publicKeyPem: wrongPublicKeyPem
            }
          ]
        }
      }
    });

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      processReceiptEnvelope(
        { receipt: signed },
        {
          mode: "warn",
          trustVersion: "v2",
          env: { INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath }
        }
      );
      processReceiptEnvelope(
        { receipt: signed },
        {
          mode: "warn",
          trustVersion: "v2",
          env: { INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath }
        }
      );
      expect(warnSpy).toHaveBeenCalledTimes(2);

      const firstEvent = parseWarnJsonPayload(warnSpy.mock.calls[0][0]);
      const secondEvent = parseWarnJsonPayload(warnSpy.mock.calls[1][0]);
      const firstAttempts = firstEvent.attempts as Array<Record<string, unknown>>;
      const secondAttempts = secondEvent.attempts as Array<Record<string, unknown>>;
      expect(firstAttempts).toHaveLength(1);
      expect(secondAttempts).toHaveLength(1);
      expect(firstAttempts[0].fingerprint).toBe(secondAttempts[0].fingerprint);
      expect(String(firstAttempts[0].fingerprint)).toMatch(/^[a-f0-9]{12}$/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("env revocations override bundle revocations", () => {
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const revokedFingerprint = computeBundleKeyFingerprint(publicKeyPem);
    const trustBundlePath = writeTrustBundle({
      bundleVersion: "v3",
      bundleId: "trust-bundle-revocation-override",
      issuedAtSec: Math.floor(Date.now() / 1000) - 30,
      issuers: {
        [issuer]: {
          keys: [
            {
              kid: "relay-primary",
              alg: "ed25519",
              publicKeyPem
            }
          ]
        }
      },
      revocations: {
        issuerKeys: {
          [issuer]: [revokedFingerprint]
        }
      }
    });

    const withoutOverride = processReceiptEnvelope(
      { receipt: signed },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: { INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath }
      }
    );
    expect(withoutOverride.accepted).toBe(false);
    expect(withoutOverride.trusted).toBe(false);
    expect(withoutOverride.reason).toBe("no active key for issuer");

    const withOverride = processReceiptEnvelope(
      { receipt: signed },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: {
          INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath,
          INTENTOS_TRUST_BUNDLE_REVOCATIONS_JSON: JSON.stringify({
            signers: [],
            issuerKeys: {}
          })
        }
      }
    );
    expect(withOverride.accepted).toBe(true);
    expect(withOverride.trusted).toBe(true);
    expect(withOverride.reason).toBe("signature valid");
  });

  test("revoked key selection remains deterministic across repeated evaluations", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const revokedFingerprint = computeBundleKeyFingerprint(publicKeyPem);
    const { publicKey: alternatePublicKey } = generateKeyPairSync("ed25519");
    const alternatePublicKeyPem = alternatePublicKey.export({ type: "spki", format: "pem" }).toString();
    const trustBundlePath = writeTrustBundle({
      bundleVersion: "v3",
      bundleId: "trust-bundle-revocation-determinism",
      issuedAtSec: nowSec - 30,
      issuers: {
        [issuer]: {
          keys: [
            {
              kid: "relay-revoked",
              alg: "ed25519",
              notBefore: nowSec - 120,
              notAfter: nowSec + 120,
              publicKeyPem
            },
            {
              kid: "relay-alternate",
              alg: "ed25519",
              notBefore: nowSec - 120,
              notAfter: nowSec + 120,
              publicKeyPem: alternatePublicKeyPem
            }
          ]
        }
      },
      revocations: {
        issuerKeys: {
          [issuer]: [revokedFingerprint]
        }
      }
    });

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const firstResult = processReceiptEnvelope(
        { receipt: signed },
        {
          mode: "warn",
          trustVersion: "v2",
          env: { INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath }
        }
      );
      const secondResult = processReceiptEnvelope(
        { receipt: signed },
        {
          mode: "warn",
          trustVersion: "v2",
          env: { INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath }
        }
      );

      expect(firstResult.reason).toBe("signature invalid for all active keys");
      expect(secondResult.reason).toBe("signature invalid for all active keys");
      expect(warnSpy).toHaveBeenCalledTimes(2);

      const firstEvent = parseWarnJsonPayload(warnSpy.mock.calls[0][0]);
      const secondEvent = parseWarnJsonPayload(warnSpy.mock.calls[1][0]);
      expect(firstEvent.attempts).toEqual(secondEvent.attempts);

      const attempts = firstEvent.attempts as Array<Record<string, unknown>>;
      expect(attempts[0].reasonSkipped).toBe("revoked");
      expect(attempts[0].active).toBe(false);
      expect(attempts[0].fingerprint).toBe(revokedFingerprint);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("rejects malformed trust bundle structure", () => {
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const trustBundlePath = writeTrustBundle({
      bundleVersion: "intentos-trust-bundle/v1",
      issuers: {
        [issuer]: {
          keys: "not-an-array"
        }
      }
    });
    const logger = { warn: jest.fn() } satisfies ReceiptPolicyLogger;
    const result = processReceiptEnvelope(
      { receipt: signed },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: { INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath },
        logger
      }
    );
    expect(result.accepted).toBe(false);
    expect(result.trusted).toBe(false);
    expect(result.reason).toContain("trusted key config: trust_bundle_keys_must_be_array");
    expect(result.reason).toContain(issuer);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("rejects trust bundle key windows where notBefore is not less than notAfter", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const trustBundlePath = writeTrustBundle({
      bundleVersion: "intentos-trust-bundle/v1",
      issuers: {
        [issuer]: {
          keys: [
            {
              kid: "relay-a",
              alg: "ed25519",
              notBefore: nowSec + 10,
              notAfter: nowSec + 10,
              publicKeyPem
            }
          ]
        }
      }
    });
    const result = processReceiptEnvelope(
      { receipt: signed },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: { INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath }
      }
    );
    expect(result.accepted).toBe(false);
    expect(result.trusted).toBe(false);
    expect(result.reason).toContain(
      "trusted key config: trust_bundle_key_window_must_have_notBefore_lt_notAfter"
    );
  });

  test("bundle path keys override INTENTOS_TRUSTED_RECEIPT_KEYS_JSON", () => {
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const { publicKey: wrongPublicKey } = generateKeyPairSync("ed25519");
    const wrongPublicKeyPem = wrongPublicKey.export({ type: "spki", format: "pem" }).toString();
    const trustBundlePath = writeTrustBundle({
      bundleVersion: "intentos-trust-bundle/v1",
      issuers: {
        [issuer]: {
          keys: [
            {
              kid: "relay-a",
              alg: "ed25519",
              publicKeyPem
            }
          ]
        }
      }
    });
    const logger = { warn: jest.fn() } satisfies ReceiptPolicyLogger;
    const result = processReceiptEnvelope(
      { receipt: signed },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: {
          INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath,
          INTENTOS_TRUSTED_RECEIPT_KEYS_JSON: JSON.stringify({ [issuer]: wrongPublicKeyPem })
        },
        logger
      }
    );
    expect(result.accepted).toBe(true);
    expect(result.trusted).toBe(true);
    expect(result.reason).toBe("signature valid");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("fs trust distribution adapter applies revocations from file path", () => {
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const trustBundlePath = writeTrustBundle(baseUnsignedV3Bundle());
    const revocationsPath = writeTrustRevocations({
      issuerKeys: {
        [issuer]: [computeBundleKeyFingerprint(publicKeyPem)]
      }
    });
    const result = processReceiptEnvelope(
      { receipt: signed },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: {
          INTENTOS_TRUST_DISTRIBUTION: "fs",
          INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath,
          INTENTOS_TRUST_BUNDLE_REVOCATIONS_PATH: revocationsPath
        }
      }
    );
    expect(result.accepted).toBe(false);
    expect(result.trusted).toBe(false);
    expect(
      ["no active key for issuer", "signature invalid for all active keys"].some((part) =>
        result.reason.includes(part)
      )
    ).toBe(true);
  });

  test("trust distribution URL validation rejects non-http URLs", () => {
    expect(() =>
      trustDistribution.validateTrustDistributionHttpUrl(
        "file:///tmp/trust.json",
        "INTENTOS_TRUST_HTTP_BUNDLE_URL"
      )
    ).toThrow("invalid_trust_distribution_url:INTENTOS_TRUST_HTTP_BUNDLE_URL");
  });

  test("http trust distribution adapter surfaces fetch failures", () => {
    const adapter = new trustDistribution.HttpTrustAdapter(
      {
        INTENTOS_TRUST_HTTP_BUNDLE_URL: "https://example.invalid/trust-bundle.json"
      },
      () => {
        throw new Error("network_unreachable");
      }
    );
    expect(() => adapter.resolveSnapshot()).toThrow(
      "trust_distribution_http_fetch_failed:INTENTOS_TRUST_HTTP_BUNDLE_URL:network_unreachable"
    );
  });

  test("evaluateTrustSnapshot covers accept/warn/reject rules", () => {
    const current = {
      transparencyHead: { size: 3, chainHash: "h3" },
      source: "snapshot://current"
    };

    expect(evaluateTrustSnapshot(null, {}, "enforce")).toEqual({
      decision: "accept",
      reason: null,
      relation: null
    });
    expect(evaluateTrustSnapshot(current, { transparencyHead: { size: 3, chainHash: "h3" } }, "enforce")).toEqual({
      decision: "accept",
      reason: null,
      relation: "equal"
    });
    expect(evaluateTrustSnapshot(current, { transparencyHead: { size: 4, chainHash: "h4" } }, "enforce")).toEqual({
      decision: "accept",
      reason: null,
      relation: "ahead"
    });
    expect(evaluateTrustSnapshot(current, { transparencyHead: { size: 2, chainHash: "h2" } }, "warn")).toEqual({
      decision: "warn",
      reason: "snapshot_behind",
      relation: "behind"
    });
    expect(evaluateTrustSnapshot(current, { transparencyHead: { size: 2, chainHash: "h2" } }, "enforce")).toEqual({
      decision: "reject",
      reason: "snapshot_behind",
      relation: "behind"
    });
    expect(evaluateTrustSnapshot(current, { transparencyHead: { size: 2, chainHash: "h2" } }, "off")).toEqual({
      decision: "accept",
      reason: "snapshot_behind",
      relation: "behind"
    });
    expect(
      evaluateTrustSnapshot(current, { transparencyHead: { size: 3, chainHash: "other-h3" } }, "warn")
    ).toEqual({
      decision: "warn",
      reason: "snapshot_conflict",
      relation: "conflict"
    });
    expect(
      evaluateTrustSnapshot(current, { transparencyHead: { size: 3, chainHash: "other-h3" } }, "enforce")
    ).toEqual({
      decision: "reject",
      reason: "snapshot_conflict",
      relation: "conflict"
    });
    expect(
      evaluateTrustSnapshot(current, { transparencyHead: { size: 3, chainHash: "other-h3" } }, "off")
    ).toEqual({
      decision: "accept",
      reason: "snapshot_conflict",
      relation: "conflict"
    });
    expect(evaluateTrustSnapshot(current, {}, "warn")).toEqual({
      decision: "warn",
      reason: "snapshot_head_missing",
      relation: null
    });
    expect(evaluateTrustSnapshot(current, {}, "enforce")).toEqual({
      decision: "accept",
      reason: null,
      relation: null
    });
    expect(evaluateTrustSnapshot({ source: "snapshot://none" }, {}, "enforce")).toEqual({
      decision: "accept",
      reason: null,
      relation: null
    });
  });

  test("trust snapshot store save/load roundtrip", () => {
    const dirPath = mkdtempSync(path.join(tmpdir(), "intentos-trust-snapshot-store-"));
    tempDirs.push(dirPath);
    const statePath = path.join(dirPath, "snapshot-state.json");
    const store = new FileTrustSnapshotStore(statePath);
    const state = {
      transparencyHead: { size: 9, chainHash: "head-9" },
      bundleId: "bundle-9",
      fetchedAtMs: 1767225600000,
      source: "snapshot://source"
    };
    store.save(state);
    expect(store.load()).toEqual(state);
  });

  test("trust snapshot store corrupt file read fails", () => {
    const dirPath = mkdtempSync(path.join(tmpdir(), "intentos-trust-snapshot-store-"));
    tempDirs.push(dirPath);
    const statePath = path.join(dirPath, "snapshot-state.json");
    writeFileSync(statePath, "{not-json", "utf8");
    const store = new FileTrustSnapshotStore(statePath);
    expect(() => store.load()).toThrow();
  });

  test("trust snapshot store atomic write does not leave temp files", () => {
    const dirPath = mkdtempSync(path.join(tmpdir(), "intentos-trust-snapshot-store-"));
    tempDirs.push(dirPath);
    const statePath = path.join(dirPath, "snapshot-state.json");
    const store = new FileTrustSnapshotStore(statePath);
    store.save({
      transparencyHead: { size: 1, chainHash: "head-1" },
      source: "snapshot://source"
    });
    const entries = readdirSync(dirPath);
    expect(entries.some((entry) => entry.startsWith("snapshot-state.json.tmp-"))).toBe(false);
  });

  test("snapshot policy enforce rejects behind distribution head", () => {
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const trustBundlePath = writeTrustBundle(baseUnsignedV3Bundle());
    const logger = { warn: jest.fn() } satisfies ReceiptPolicyLogger;
    const snapshotSpy = jest
      .spyOn(trustDistribution, "resolveTrustDistributionSnapshot")
      .mockImplementationOnce(() => ({
        bundlePath: trustBundlePath,
        transparencyHead: { size: 5, chainHash: "head-5" }
      }))
      .mockImplementationOnce(() => ({
        bundlePath: trustBundlePath,
        transparencyHead: { size: 4, chainHash: "head-4" }
      }));

    try {
      const first = processReceiptEnvelope(
        { receipt: signed },
        {
          mode: "enforce",
          trustVersion: "v2",
          logger,
          env: {
            INTENTOS_TRUST_DISTRIBUTION: "fs",
            INTENTOS_TRUST_SNAPSHOT_POLICY: "enforce"
          }
        }
      );
      expect(first.accepted).toBe(true);
      expect(first.trusted).toBe(true);

      const second = processReceiptEnvelope(
        { receipt: signed },
        {
          mode: "enforce",
          trustVersion: "v2",
          logger,
          env: {
            INTENTOS_TRUST_DISTRIBUTION: "fs",
            INTENTOS_TRUST_SNAPSHOT_POLICY: "enforce"
          }
        }
      );
      expect(second.accepted).toBe(false);
      expect(second.trusted).toBe(false);
      expect(second.reason).toContain("trusted key config: trust snapshot policy rejected: snapshot_behind");
    } finally {
      snapshotSpy.mockRestore();
    }
  });

  test("snapshot policy warn logs conflict and continues", () => {
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const trustBundlePath = writeTrustBundle(baseUnsignedV3Bundle());
    const snapshotSpy = jest
      .spyOn(trustDistribution, "resolveTrustDistributionSnapshot")
      .mockImplementationOnce(() => ({
        bundlePath: trustBundlePath,
        transparencyHead: { size: 7, chainHash: "head-7-a" }
      }))
      .mockImplementationOnce(() => ({
        bundlePath: trustBundlePath,
        transparencyHead: { size: 7, chainHash: "head-7-b" }
      }));

    try {
      const first = processReceiptEnvelope(
        { receipt: signed },
        {
          mode: "enforce",
          trustVersion: "v2",
          env: {
            INTENTOS_TRUST_DISTRIBUTION: "fs",
            INTENTOS_TRUST_SNAPSHOT_POLICY: "warn"
          }
        }
      );
      expect(first.accepted).toBe(true);
      expect(first.trusted).toBe(true);

      const logger = { warn: jest.fn() } satisfies ReceiptPolicyLogger;
      const second = processReceiptEnvelope(
        { receipt: signed },
        {
          mode: "enforce",
          trustVersion: "v2",
          logger,
          env: {
            INTENTOS_TRUST_DISTRIBUTION: "fs",
            INTENTOS_TRUST_SNAPSHOT_POLICY: "warn"
          }
        }
      );
      expect(second.accepted).toBe(true);
      expect(second.trusted).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "intentos_trust_snapshot_policy",
          mode: "warn",
          decision: "warn",
          reason: "snapshot_conflict"
        })
      );
    } finally {
      snapshotSpy.mockRestore();
    }
  });

  test("snapshot policy enforce rejects when state save fails", () => {
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const trustBundlePath = writeTrustBundle(baseUnsignedV3Bundle());
    const stateDir = mkdtempSync(path.join(tmpdir(), "intentos-trust-snapshot-state-dir-"));
    tempDirs.push(stateDir);

    const snapshotSpy = jest.spyOn(trustDistribution, "resolveTrustDistributionSnapshot").mockReturnValue({
      bundlePath: trustBundlePath,
      transparencyHead: { size: 11, chainHash: "head-11" }
    });

    try {
      const logger = { warn: jest.fn() } satisfies ReceiptPolicyLogger;
      const result = processReceiptEnvelope(
        { receipt: signed },
        {
          mode: "enforce",
          trustVersion: "v2",
          logger,
          env: {
            INTENTOS_TRUST_DISTRIBUTION: "fs",
            INTENTOS_TRUST_SNAPSHOT_POLICY: "enforce",
            INTENTOS_TRUST_SNAPSHOT_STATE_PATH: stateDir
          }
        }
      );
      expect(result.accepted).toBe(false);
      expect(result.trusted).toBe(false);
      expect(result.reason).toContain("trust snapshot state save failed");
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "intentos_trust_snapshot_store",
          operation: "save",
          mode: "enforce"
        })
      );
    } finally {
      snapshotSpy.mockRestore();
    }
  });

  test("backward compatible env JSON loading when bundle path is not set", () => {
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const logger = { warn: jest.fn() } satisfies ReceiptPolicyLogger;
    const result = processReceiptEnvelope(
      { receipt: signed },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: {
          INTENTOS_TRUSTED_RECEIPT_KEYS_JSON: JSON.stringify({ [issuer]: publicKeyPem })
        },
        logger
      }
    );
    expect(result.accepted).toBe(true);
    expect(result.trusted).toBe(true);
    expect(result.reason).toBe("signature valid");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("append mode logs bundle load and enforce policy rejection", () => {
    const trustBundlePath = writeTrustBundle(baseUnsignedV3Bundle());
    const transparencyLogPath = writeTransparencyLog([]);
    const result = processReceiptEnvelope(
      { receipt: baseReceipt() },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: {
          INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath,
          INTENTOS_TRANSPARENCY_LOG_PATH: transparencyLogPath,
          INTENTOS_TRANSPARENCY_LOG_MODE: "append"
        }
      }
    );

    expect(result.accepted).toBe(false);
    expect(result.trusted).toBe(false);
    const entries = readFileSync(transparencyLogPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { type?: string });
    const types = entries.map((entry) => entry.type);
    expect(types).toContain("bundle_loaded");
    expect(types).toContain("policy_reject");
  });

  test("append mode logs revocation_applied when bundle revocations are present", () => {
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const trustBundlePath = writeTrustBundle({
      ...baseUnsignedV3Bundle(),
      revocations: {
        issuerKeys: {
          [issuer]: ["deadbeef"]
        }
      }
    });
    const transparencyLogPath = writeTransparencyLog([]);
    const result = processReceiptEnvelope(
      { receipt: signed },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: {
          INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath,
          INTENTOS_TRANSPARENCY_LOG_PATH: transparencyLogPath,
          INTENTOS_TRANSPARENCY_LOG_MODE: "append"
        }
      }
    );

    expect(result.accepted).toBe(true);
    expect(result.trusted).toBe(true);
    const types = readFileSync(transparencyLogPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { type?: string })
      .map((entry) => entry.type);
    expect(types).toContain("bundle_loaded");
    expect(types).toContain("revocation_applied");
  });

  test("verify mode rejects bundle load when transparency chain is broken", () => {
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const trustBundlePath = writeTrustBundle(baseUnsignedV3Bundle());
    const transparencyLogPath = writeTransparencyLog([
      {
        timestamp: "2026-02-11T12:00:00.000Z",
        type: "bundle_loaded",
        entryHash: "bad-entry-hash",
        chainHash: "bad-chain-hash"
      }
    ]);
    const result = processReceiptEnvelope(
      { receipt: signed },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: {
          INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath,
          INTENTOS_TRANSPARENCY_LOG_PATH: transparencyLogPath,
          INTENTOS_TRANSPARENCY_LOG_MODE: "verify"
        }
      }
    );

    expect(result.accepted).toBe(false);
    expect(result.trusted).toBe(false);
    expect(result.reason).toContain("trusted key config: transparency log chain broken at entry 1");
  });

  test("verify mode accepts valid checkpointed log when checkpoint verify is enabled", () => {
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const trustBundlePath = writeTrustBundle(baseUnsignedV3Bundle());
    const transparencyLogPath = writeTransparencyLog([]);
    appendTransparencyEntry(
      {
        timestamp: "2026-02-11T12:00:00.000Z",
        type: "bundle_loaded",
        bundleHash: "abc"
      },
      { path: transparencyLogPath }
    );
    const { publicKey: checkpointPublicKey, privateKey: checkpointPrivateKey } =
      generateKeyPairSync("ed25519");
    const checkpointPublicKeyPem = checkpointPublicKey.export({ type: "spki", format: "pem" }).toString();
    const checkpointPrivateKeyPem = checkpointPrivateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    const checkpoint = createCheckpoint({
      logEntries: loadTransparencyLog(transparencyLogPath),
      chainHash: loadTransparencyLog(transparencyLogPath)[0].chainHash,
      signer: "signer://checkpoint-ops",
      signingKeyPem: checkpointPrivateKeyPem
    });
    writeFileSync(
      transparencyLogPath,
      `${readFileSync(transparencyLogPath, "utf8")}${JSON.stringify(checkpoint)}\n`,
      "utf8"
    );

    const result = processReceiptEnvelope(
      { receipt: signed },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: {
          INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath,
          INTENTOS_TRANSPARENCY_LOG_PATH: transparencyLogPath,
          INTENTOS_TRANSPARENCY_LOG_MODE: "verify",
          INTENTOS_TRANSPARENCY_CHECKPOINT_MODE: "verify",
          INTENTOS_TRANSPARENCY_CHECKPOINT_PUBLIC_KEY: checkpointPublicKeyPem
        }
      }
    );

    expect(result.accepted).toBe(true);
    expect(result.trusted).toBe(true);
    expect(result.reason).toBe("signature valid");
  });

  test("verify mode rejects invalid checkpoint signature when checkpoint verify is enabled", () => {
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const trustBundlePath = writeTrustBundle(baseUnsignedV3Bundle());
    const transparencyLogPath = writeTransparencyLog([]);
    appendTransparencyEntry(
      {
        timestamp: "2026-02-11T12:00:00.000Z",
        type: "bundle_loaded",
        bundleHash: "abc"
      },
      { path: transparencyLogPath }
    );
    const { publicKey: checkpointPublicKey, privateKey: checkpointPrivateKey } =
      generateKeyPairSync("ed25519");
    const checkpointPublicKeyPem = checkpointPublicKey.export({ type: "spki", format: "pem" }).toString();
    const checkpointPrivateKeyPem = checkpointPrivateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    const checkpoint = createCheckpoint({
      logEntries: loadTransparencyLog(transparencyLogPath),
      chainHash: loadTransparencyLog(transparencyLogPath)[0].chainHash,
      signer: "signer://checkpoint-ops",
      signingKeyPem: checkpointPrivateKeyPem
    });
    const invalidCheckpoint = {
      ...checkpoint,
      signature: `${checkpoint.signature.slice(0, -2)}AA`
    };
    writeFileSync(
      transparencyLogPath,
      `${readFileSync(transparencyLogPath, "utf8")}${JSON.stringify(invalidCheckpoint)}\n`,
      "utf8"
    );

    const result = processReceiptEnvelope(
      { receipt: signed },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: {
          INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath,
          INTENTOS_TRANSPARENCY_LOG_PATH: transparencyLogPath,
          INTENTOS_TRANSPARENCY_LOG_MODE: "verify",
          INTENTOS_TRANSPARENCY_CHECKPOINT_MODE: "verify",
          INTENTOS_TRANSPARENCY_CHECKPOINT_PUBLIC_KEY: checkpointPublicKeyPem
        }
      }
    );

    expect(result.accepted).toBe(false);
    expect(result.trusted).toBe(false);
    expect(result.reason).toContain("trusted key config: transparency log chain broken at entry 2");
  });

  test("bundle signature env is ignored when bundle path is not set", () => {
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const result = processReceiptEnvelope(
      { receipt: signed },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: {
          INTENTOS_TRUST_BUNDLE_REQUIRE_SIGNATURE: "on",
          INTENTOS_TRUST_BUNDLE_TRUSTED_SIGNERS_JSON: "{not-json",
          INTENTOS_TRUSTED_RECEIPT_KEYS_JSON: JSON.stringify({ [issuer]: publicKeyPem })
        }
      }
    );
    expect(result.accepted).toBe(true);
    expect(result.trusted).toBe(true);
    expect(result.reason).toBe("signature valid");
  });

  test("v2 enforce rejects unknown issuer even when receipt is signed", () => {
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const logger = { warn: jest.fn() } satisfies ReceiptPolicyLogger;
    const result = processReceiptEnvelope(
      { receipt: signed },
      {
        mode: "enforce",
        trustVersion: "v2",
        trustedReceiptKeys: Object.freeze({}),
        logger
      }
    );
    expect(result.accepted).toBe(false);
    expect(result.trusted).toBe(false);
    expect(result.reason).toBe(`untrusted issuer: ${issuer}`);
    expect(result.trustVersion).toBe("v2");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("tampered signed receipt fails verification in enforce mode", () => {
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer);
    const tampered: Receipt = {
      ...signed,
      metadata: { outputHash: "tampered" }
    };

    const logger = { warn: jest.fn() } satisfies ReceiptPolicyLogger;
    const result = processReceiptEnvelope(
      { receipt: tampered },
      { mode: "enforce", trustedReceiptKeys: trustedKeys, logger }
    );

    expect(result.accepted).toBe(false);
    expect(result.trusted).toBe(false);
    expect(result.reason).toBe("invalid signature");
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
