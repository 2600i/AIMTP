import { generateKeyPairSync } from "node:crypto";
import {
  Receipt,
  canonicalizeReceiptForSigning,
  signReceipt,
  verifyReceipt
} from "../src/protocol/intentos-receipts";

function baseReceipt(): Receipt {
  return {
    receiptId: "receipt-001",
    envelopeId: "env-001",
    intentId: "intent-001",
    type: "receipt.denied",
    timestamp: "2026-02-10T10:00:00.000Z",
    metadata: { reason: "capability-expired" }
  };
}

describe("IntentOS federation receipt signing", () => {
  const issuer = "relay://north-1";
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const trustedKeys = Object.freeze({ [issuer]: publicKeyPem });

  test("signing produces verifiable signature", () => {
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer);
    expect(signed.issuer).toBe(issuer);
    expect(signed.sigAlg).toBe("ed25519");
    expect(typeof signed.signature).toBe("string");
    expect((signed.signature || "").length).toBeGreaterThan(0);

    const verification = verifyReceipt(signed, trustedKeys);
    expect(verification.verified).toBe(true);
    expect(verification.reason).toBe("signature valid");
    expect(verification.trustVersion).toBe("v1");
  });

  test("tampering any signed field fails verification", () => {
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer);
    const mutations: Array<(receipt: Receipt) => Receipt> = [
      (receipt) => ({ ...receipt, receiptId: "receipt-002" }),
      (receipt) => ({ ...receipt, envelopeId: "env-002" }),
      (receipt) => ({ ...receipt, intentId: "intent-002" }),
      (receipt) => ({ ...receipt, type: "receipt.failed" }),
      (receipt) => ({ ...receipt, timestamp: "2026-02-10T10:01:00.000Z" }),
      (receipt) => ({ ...receipt, metadata: { reason: "subject-mismatch" } }),
      (receipt) => ({ ...receipt, issuer: "relay://other-issuer" }),
      (receipt) => ({ ...receipt, sigAlg: "ed448" })
    ];

    mutations.forEach((mutate) => {
      const tampered = mutate(signed);
      const verification = verifyReceipt(tampered, trustedKeys);
      expect(verification.verified).toBe(false);
    });
  });

  test("unsigned receipt returns UNVERIFIED (missing signature) without throwing", () => {
    const verification = verifyReceipt(baseReceipt(), trustedKeys);
    expect(verification.verified).toBe(false);
    expect(verification.reason).toBe("missing signature");
  });

  test("canonicalization is stable for equivalent receipt objects", () => {
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer);
    const reordered: Receipt = {
      intentId: signed.intentId,
      receiptId: signed.receiptId,
      signature: signed.signature,
      timestamp: signed.timestamp,
      type: signed.type,
      metadata: signed.metadata,
      envelopeId: signed.envelopeId,
      issuer: signed.issuer,
      sigAlg: signed.sigAlg
    };

    const canonicalA = canonicalizeReceiptForSigning(signed).toString("utf8");
    const canonicalB = canonicalizeReceiptForSigning(reordered).toString("utf8");
    expect(canonicalA).toBe(canonicalB);
  });

  test("v2 canonicalization is stable for equivalent receipt objects", () => {
    const signed = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const reordered: Receipt = {
      timestamp: signed.timestamp,
      metadata: signed.metadata,
      trustVersion: signed.trustVersion,
      intentId: signed.intentId,
      type: signed.type,
      envelopeId: signed.envelopeId,
      issuer: signed.issuer,
      sigAlg: signed.sigAlg,
      receiptId: signed.receiptId,
      signature: signed.signature
    };

    const canonicalA = canonicalizeReceiptForSigning(signed, { trustVersion: "v2" }).toString("utf8");
    const canonicalB = canonicalizeReceiptForSigning(reordered, { trustVersion: "v2" }).toString("utf8");
    expect(canonicalA).toBe(canonicalB);

    const verification = verifyReceipt(signed, trustedKeys, { trustVersion: "v2" });
    expect(verification.verified).toBe(true);
    expect(verification.trustVersion).toBe("v2");
  });
});
