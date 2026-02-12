import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Receipt, signReceipt } from "../src/protocol/intentos-receipts";
import { processReceiptEnvelope } from "../src/runtime/intentos/receipt-policy";
import {
  appendTransparencyEntry,
  compareTransparencyHeads,
  createCheckpoint,
  computeEntryHash,
  computeTransparencyHead,
  findLatestValidCheckpoint,
  loadTransparencyLog,
  verifyCheckpoint,
  verifyTransparencyLogIncremental,
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

  test("compute transparency head ignores checkpoints", () => {
    const logPath = makeTempLogPath();
    appendTransparencyEntry(
      {
        timestamp: "2026-02-11T12:00:00.000Z",
        type: "bundle_loaded",
        bundleHash: "bundle-a"
      },
      { path: logPath }
    );
    appendTransparencyEntry(
      {
        timestamp: "2026-02-11T12:00:01.000Z",
        type: "policy_reject",
        reason: "blocked"
      },
      { path: logPath }
    );

    const { privateKey } = generateKeyPairSync("ed25519");
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const entries = loadTransparencyLog(logPath);
    const checkpoint = createCheckpoint({
      logEntries: entries,
      chainHash: entries[entries.length - 1].chainHash,
      signer: "signer://transparency-ops",
      signingKeyPem: privateKeyPem
    });
    const records = [...entries, checkpoint];

    expect(computeTransparencyHead(records)).toEqual({
      size: 2,
      chainHash: entries[1].chainHash
    });
  });

  test("compare transparency heads equal/ahead/behind/conflict", () => {
    const equalA = { size: 2, chainHash: "hash-2" };
    const equalB = { size: 2, chainHash: "hash-2" };
    const ahead = { size: 3, chainHash: "hash-3" };
    const behind = { size: 1, chainHash: "hash-1" };
    const conflict = { size: 2, chainHash: "other-hash-2" };

    expect(compareTransparencyHeads(equalA, equalB)).toBe("equal");
    expect(compareTransparencyHeads(ahead, behind)).toBe("ahead");
    expect(compareTransparencyHeads(behind, ahead)).toBe("behind");
    expect(compareTransparencyHeads(equalA, conflict)).toBe("conflict");
  });

  test("compare transparency heads is symmetric for ahead/behind", () => {
    const a = { size: 7, chainHash: "hash-7" };
    const b = { size: 3, chainHash: "hash-3" };

    expect(compareTransparencyHeads(a, b)).toBe("ahead");
    expect(compareTransparencyHeads(b, a)).toBe("behind");
  });

  test("checkpoint signature verify pass/fail", () => {
    const logPath = makeTempLogPath();
    appendTransparencyEntry(
      {
        timestamp: "2026-02-11T12:00:00.000Z",
        type: "bundle_loaded",
        bundleHash: "bundle-a"
      },
      { path: logPath }
    );
    appendTransparencyEntry(
      {
        timestamp: "2026-02-11T12:00:01.000Z",
        type: "policy_reject",
        reason: "policy deny"
      },
      { path: logPath }
    );

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const entries = loadTransparencyLog(logPath);
    const checkpoint = createCheckpoint({
      logEntries: entries,
      chainHash: entries[entries.length - 1].chainHash,
      signer: "signer://transparency-ops",
      signingKeyPem: privateKeyPem
    });

    expect(verifyCheckpoint(checkpoint, publicKeyPem)).toBe(true);
    expect(() =>
      verifyCheckpoint(
        {
          ...checkpoint,
          signature: `${checkpoint.signature.slice(0, -2)}AA`
        },
        publicKeyPem
      )
    ).toThrow("checkpoint_signature_invalid");
  });

  test("incremental verify passes when checkpoint is valid", () => {
    const logPath = makeTempLogPath();
    appendTransparencyEntry(
      {
        timestamp: "2026-02-11T12:00:00.000Z",
        type: "bundle_loaded",
        bundleHash: "bundle-a"
      },
      { path: logPath }
    );
    appendTransparencyEntry(
      {
        timestamp: "2026-02-11T12:00:01.000Z",
        type: "bundle_rejected",
        reason: "unknown signer"
      },
      { path: logPath }
    );

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const entries = loadTransparencyLog(logPath);
    const checkpoint = createCheckpoint({
      logEntries: entries,
      chainHash: entries[entries.length - 1].chainHash,
      signer: "signer://transparency-ops",
      signingKeyPem: privateKeyPem
    });
    writeFileSync(logPath, `${readFileSync(logPath, "utf8")}${JSON.stringify(checkpoint)}\n`, "utf8");

    const result = verifyTransparencyLogIncremental(logPath, {
      checkpointPublicKeyPem: publicKeyPem
    });
    expect(result.valid).toBe(true);
    expect(result.checkpointUsedSize).toBe(2);
    const allRecords = [
      ...entries,
      checkpoint
    ];
    expect(findLatestValidCheckpoint(allRecords, publicKeyPem)?.startIndex).toBe(2);
  });

  test("incremental verify fails if checkpoint chainHash mismatched", () => {
    const logPath = makeTempLogPath();
    appendTransparencyEntry(
      {
        timestamp: "2026-02-11T12:00:00.000Z",
        type: "bundle_loaded",
        bundleHash: "bundle-a"
      },
      { path: logPath }
    );
    appendTransparencyEntry(
      {
        timestamp: "2026-02-11T12:00:01.000Z",
        type: "bundle_rejected",
        reason: "unknown signer"
      },
      { path: logPath }
    );

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const entries = loadTransparencyLog(logPath);
    const checkpoint = createCheckpoint({
      logEntries: entries,
      chainHash: "mismatched-chain-hash",
      signer: "signer://transparency-ops",
      signingKeyPem: privateKeyPem
    });
    writeFileSync(logPath, `${readFileSync(logPath, "utf8")}${JSON.stringify(checkpoint)}\n`, "utf8");

    const result = verifyTransparencyLogIncremental(logPath, {
      checkpointPublicKeyPem: publicKeyPem
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("checkpoint_chain_hash_mismatch");
  });

  test("incremental verify fails if checkpoint signature invalid", () => {
    const logPath = makeTempLogPath();
    appendTransparencyEntry(
      {
        timestamp: "2026-02-11T12:00:00.000Z",
        type: "bundle_loaded",
        bundleHash: "bundle-a"
      },
      { path: logPath }
    );

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const entries = loadTransparencyLog(logPath);
    const checkpoint = createCheckpoint({
      logEntries: entries,
      chainHash: entries[entries.length - 1].chainHash,
      signer: "signer://transparency-ops",
      signingKeyPem: privateKeyPem
    });
    const invalidCheckpoint = {
      ...checkpoint,
      signature: `${checkpoint.signature.slice(0, -2)}AA`
    };
    writeFileSync(logPath, `${readFileSync(logPath, "utf8")}${JSON.stringify(invalidCheckpoint)}\n`, "utf8");

    const result = verifyTransparencyLogIncremental(logPath, {
      checkpointPublicKeyPem: publicKeyPem
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("checkpoint_signature_invalid");
  });

  test("incremental verify rejects checkpoint entries with unknown keys", () => {
    const logPath = makeTempLogPath();
    appendTransparencyEntry(
      {
        timestamp: "2026-02-11T12:00:00.000Z",
        type: "bundle_loaded",
        bundleHash: "bundle-a"
      },
      { path: logPath }
    );

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const entries = loadTransparencyLog(logPath);
    const checkpoint = createCheckpoint({
      logEntries: entries,
      chainHash: entries[entries.length - 1].chainHash,
      signer: "signer://transparency-ops",
      signingKeyPem: privateKeyPem
    });
    const checkpointWithUnknownKey = {
      ...checkpoint,
      extraField: "not-allowed"
    };
    writeFileSync(
      logPath,
      `${readFileSync(logPath, "utf8")}${JSON.stringify(checkpointWithUnknownKey)}\n`,
      "utf8"
    );

    const result = verifyTransparencyLogIncremental(logPath, {
      checkpointPublicKeyPem: publicKeyPem
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("checkpoint_unknown_keys");
  });

  test("incremental verify rejects tampering after checkpoint", () => {
    const logPath = makeTempLogPath();
    appendTransparencyEntry(
      {
        timestamp: "2026-02-11T12:00:00.000Z",
        type: "bundle_loaded",
        bundleHash: "bundle-a"
      },
      { path: logPath }
    );
    appendTransparencyEntry(
      {
        timestamp: "2026-02-11T12:00:01.000Z",
        type: "bundle_rejected",
        reason: "reason-a"
      },
      { path: logPath }
    );

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const checkpoint = createCheckpoint({
      logEntries: loadTransparencyLog(logPath),
      chainHash: loadTransparencyLog(logPath)[1].chainHash,
      signer: "signer://transparency-ops",
      signingKeyPem: privateKeyPem
    });
    writeFileSync(logPath, `${readFileSync(logPath, "utf8")}${JSON.stringify(checkpoint)}\n`, "utf8");
    appendTransparencyEntry(
      {
        timestamp: "2026-02-11T12:00:02.000Z",
        type: "policy_reject",
        reason: "post-checkpoint"
      },
      { path: logPath }
    );

    const lines = readFileSync(logPath, "utf8")
      .trim()
      .split("\n");
    const tampered = JSON.parse(lines[3]) as Record<string, unknown>;
    tampered.reason = "tampered-after-checkpoint";
    lines[3] = JSON.stringify(tampered);
    writeFileSync(logPath, `${lines.join("\n")}\n`, "utf8");

    const result = verifyTransparencyLogIncremental(logPath, {
      checkpointPublicKeyPem: publicKeyPem
    });
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(4);
    expect(result.reason).toBe("entry_hash_mismatch");
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
