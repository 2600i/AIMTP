import { generateKeyPairSync } from "node:crypto";
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

