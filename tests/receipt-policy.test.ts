import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Receipt, signReceipt } from "../src/protocol/intentos-receipts";
import { processReceiptEnvelope, type ReceiptPolicyLogger } from "../src/runtime/intentos/receipt-policy";

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

describe("IntentOS receipt policy enforcement", () => {
  const issuer = "relay://policy-test";
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
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

  function receiptWithNumericTimestampFixture(): Receipt {
    const fixturePath = path.join(__dirname, "fixtures", "intentos-receipt-numeric-timestamp.json");
    return JSON.parse(readFileSync(fixturePath, "utf8")) as Receipt;
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
