import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Receipt, signReceipt } from "../src/protocol/intentos-receipts";
import { processReceiptEnvelope } from "../src/runtime/intentos/receipt-policy";
import {
  appendTransparencyEntry,
  computeEntryHash,
  loadTransparencyLog,
  verifyTransparencyLog
} from "../src/runtime/intentos/trust-transparency";

function baseReceipt(): Receipt {
  return {
    receiptId: "receipt-transparency-001",
    envelopeId: "env-transparency-001",
    intentId: "intent-transparency-001",
    type: "receipt.completed",
    timestamp: "2026-02-11T12:00:00.000Z",
    metadata: { outputHash: "abc123" }
  };
}

describe("IntentOS trust transparency log", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dirPath = tempDirs.pop();
      if (dirPath) {
        rmSync(dirPath, { recursive: true, force: true });
      }
    }
  });

  function makeTempLogPath(): string {
    const dirPath = mkdtempSync(path.join(tmpdir(), "intentos-transparency-log-"));
    tempDirs.push(dirPath);
    return path.join(dirPath, "trust-log.jsonl");
  }

  function makeTempBundlePath(bundle: unknown): string {
    const dirPath = mkdtempSync(path.join(tmpdir(), "intentos-transparency-bundle-"));
    tempDirs.push(dirPath);
    const bundlePath = path.join(dirPath, "trust-bundle.json");
    writeFileSync(bundlePath, JSON.stringify(bundle), "utf8");
    return bundlePath;
  }

  test("chain append produces valid log", () => {
    const logPath = makeTempLogPath();
    const first = appendTransparencyEntry(
      {
        timestamp: "2026-02-11T12:00:00.000Z",
        type: "bundle_loaded",
        bundleHash: "bundle-hash-1"
      },
      { path: logPath }
    );
    const second = appendTransparencyEntry(
      {
        timestamp: "2026-02-11T12:00:01.000Z",
        type: "policy_reject",
        reason: "invalid signature"
      },
      { path: logPath }
    );

    expect(second.prevHash).toBe(first.chainHash);
    const loaded = loadTransparencyLog(logPath);
    expect(loaded).toHaveLength(2);
    expect(verifyTransparencyLog(logPath)).toEqual({
      valid: true,
      brokenAt: null,
      reason: null,
      entryCount: 2
    });
  });

  test("tampered entry fails verification", () => {
    const logPath = makeTempLogPath();
    appendTransparencyEntry(
      {
        timestamp: "2026-02-11T12:00:00.000Z",
        type: "bundle_loaded",
        bundleHash: "bundle-hash-1"
      },
      { path: logPath }
    );
    appendTransparencyEntry(
      {
        timestamp: "2026-02-11T12:00:01.000Z",
        type: "bundle_rejected",
        reason: "unknown bundle signer"
      },
      { path: logPath }
    );

    const lines = readFileSync(logPath, "utf8")
      .trim()
      .split("\n");
    const tampered = JSON.parse(lines[1]) as Record<string, unknown>;
    tampered.reason = "tampered";
    lines[1] = JSON.stringify(tampered);
    writeFileSync(logPath, `${lines.join("\n")}\n`, "utf8");

    const verified = verifyTransparencyLog(logPath);
    expect(verified.valid).toBe(false);
    expect(verified.brokenAt).toBe(2);
  });

  test("deterministic hashing", () => {
    const hashA = computeEntryHash({
      timestamp: "2026-02-11T12:00:00.000Z",
      type: "bundle_loaded",
      bundleHash: "abc123",
      reason: "ok"
    });
    const hashB = computeEntryHash({
      reason: "ok",
      bundleHash: "abc123",
      type: "bundle_loaded",
      timestamp: "2026-02-11T12:00:00.000Z"
    });
    expect(hashA).toBe(hashB);
  });

  test("no log produced when mode=off", () => {
    const issuer = "relay://transparency-test";
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const receipt = signReceipt(baseReceipt(), privateKeyPem, issuer, { trustVersion: "v2" });
    const trustBundlePath = makeTempBundlePath({
      bundleVersion: "v3",
      bundleId: "bundle-transparency-off",
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
    });
    const logPath = makeTempLogPath();

    const result = processReceiptEnvelope(
      { receipt },
      {
        mode: "enforce",
        trustVersion: "v2",
        env: {
          INTENTOS_TRUST_BUNDLE_PATH: trustBundlePath,
          INTENTOS_TRANSPARENCY_LOG_PATH: logPath,
          INTENTOS_TRANSPARENCY_LOG_MODE: "off"
        }
      }
    );
    expect(result.accepted).toBe(true);
    expect(result.trusted).toBe(true);
    expect(existsSync(logPath)).toBe(false);
  });
});
