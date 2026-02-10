import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Envelope } from "../src/protocol/intentos-execution";
import { verifyReceipt, type Receipt } from "../src/protocol/intentos-receipts";
import type { MailboxStore } from "../src/runtime/mailbox";

type IntentosExecutionModule = typeof import("../src/protocol/intentos-execution");
type MailboxModule = typeof import("../src/runtime/mailbox");

const tempDirs: string[] = [];

function makeSinkPath(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aimtp-receipts-"));
  tempDirs.push(dir);
  return path.join(dir, "receipts.jsonl");
}

function loadExecutionModule(sinkPath: string): IntentosExecutionModule {
  process.env.INTENTOS_RECEIPTS_PATH = sinkPath;
  jest.resetModules();
  return require("../src/protocol/intentos-execution") as IntentosExecutionModule;
}

function createSqliteMailboxStore(sqlitePath: string): MailboxStore {
  const mailboxModule = require("../src/runtime/mailbox") as MailboxModule;
  return mailboxModule.createMailboxStore({ type: "sqlite", sqlitePath });
}

function readJsonlReceipts(sinkPath: string): Receipt[] {
  if (!existsSync(sinkPath)) {
    return [];
  }
  const lines = readFileSync(sinkPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  return lines.map((line) => JSON.parse(line) as Receipt);
}

function buildValidEnvelope(envelopeId: string, intentId: string): Envelope {
  return {
    id: envelopeId,
    recipient: "agent://calendar",
    createdAtSec: 1_700_000_050,
    intent: {
      id: intentId,
      requester: "did:example:alice",
      action: "calendar:create_event",
      resource: "calendar://primary/events",
      payload: { title: "sync" }
    },
    capability: {
      id: `cap-${intentId}`,
      subject: "did:example:alice",
      audience: "agent://calendar",
      validFromSec: 1_700_000_000,
      validUntilSec: 1_700_000_500,
      scopes: [{ action: "calendar:create_event", resource: "calendar://primary/events" }],
      signature: "sig"
    }
  };
}

function expectCoreReceiptFields(receipt: Receipt, env: Envelope): void {
  expect(typeof receipt.receiptId).toBe("string");
  expect(receipt.receiptId.length).toBeGreaterThan(0);
  expect(receipt.envelopeId).toBe(env.id);
  expect(receipt.intentId).toBe(env.intent.id);
  expect(typeof receipt.timestamp).toBe("string");
}

afterEach(() => {
  delete process.env.INTENTOS_RECEIPTS_PATH;
  delete process.env.INTENTOS_RECEIPTS_DELIVER;
  delete process.env.INTENTOS_RECEIPTS_SIGN;
  delete process.env.INTENTOS_RECEIPTS_ISSUER;
  delete process.env.INTENTOS_RECEIPTS_PRIVATE_KEY;
  delete process.env.INTENTOS_TRUST_VERSION;
  delete process.env.AIMTP_STORE;
  delete process.env.AIMTP_MAILBOX_SQLITE_PATH;
  jest.resetModules();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("IntentOS v2 receipts", () => {
  test("writes admitted receipt with empty metadata", () => {
    const sinkPath = makeSinkPath();
    const runtime = loadExecutionModule(sinkPath);
    const env = buildValidEnvelope("env-admitted-1", "intent-admitted-1");

    const record = runtime.fireAdmission(env, env.intent);
    expect(record.state).toBe("Admitted");

    const receipts = readJsonlReceipts(sinkPath);
    expect(receipts).toHaveLength(1);

    const receipt = receipts[0];
    expect(receipt.type).toBe("receipt.admitted");
    expectCoreReceiptFields(receipt, env);
    expect(receipt.metadata).toEqual({});
    expect(Object.keys(receipt.metadata)).toEqual([]);
  });

  test("signs emitted receipts when receipt signing flag is enabled", () => {
    const sinkPath = makeSinkPath();
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const issuer = "relay://receipt-signer";
    process.env.INTENTOS_RECEIPTS_SIGN = "on";
    process.env.INTENTOS_RECEIPTS_ISSUER = issuer;
    process.env.INTENTOS_RECEIPTS_PRIVATE_KEY = privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    const runtime = loadExecutionModule(sinkPath);
    const env = buildValidEnvelope("env-signed-1", "intent-signed-1");

    const record = runtime.fireAdmission(env, env.intent);
    expect(record.state).toBe("Admitted");

    const receipts = readJsonlReceipts(sinkPath);
    expect(receipts).toHaveLength(1);

    const receipt = receipts[0];
    expect(receipt.issuer).toBe(issuer);
    expect(receipt.sigAlg).toBe("ed25519");
    expect(typeof receipt.signature).toBe("string");
    expect((receipt.signature || "").length).toBeGreaterThan(0);

    const trustedKeys = {
      [issuer]: publicKey.export({ type: "spki", format: "pem" }).toString()
    };
    const verification = verifyReceipt(receipt, trustedKeys);
    expect(verification).toEqual({ verified: true, reason: "signature valid", trustVersion: "v1" });
  });

  test("writes denied receipt with { reason } metadata", () => {
    const sinkPath = makeSinkPath();
    const runtime = loadExecutionModule(sinkPath);
    const env = buildValidEnvelope("env-denied-1", "intent-denied-1");
    const invalidEnv: Envelope = {
      ...env,
      capability: {
        ...env.capability,
        validUntilSec: env.createdAtSec
      }
    };

    const record = runtime.fireAdmission(invalidEnv, invalidEnv.intent);
    expect(record.state).toBe("Denied");

    const receipts = readJsonlReceipts(sinkPath);
    expect(receipts).toHaveLength(1);

    const receipt = receipts[0];
    expect(receipt.type).toBe("receipt.denied");
    expectCoreReceiptFields(receipt, invalidEnv);
    expect(receipt.metadata).toEqual({ reason: record.decision.reason });
    expect(Object.keys(receipt.metadata)).toEqual(["reason"]);
  });

  test("writes completed receipt with deterministic output hash metadata", async () => {
    const sinkPath = makeSinkPath();
    const runtime = loadExecutionModule(sinkPath);
    const env = buildValidEnvelope("env-completed-1", "intent-completed-1");
    const output = { ok: true, booked: { day: "2026-02-10", slot: "09:00" } };

    const record = await runtime.fireDispatch(env, env.intent, async () => output);
    expect(record.state).toBe("Completed");

    const receipts = readJsonlReceipts(sinkPath);
    expect(receipts).toHaveLength(1);

    const receipt = receipts[0];
    expect(receipt.type).toBe("receipt.completed");
    expectCoreReceiptFields(receipt, env);

    const expectedHash = createHash("sha256")
      .update(JSON.stringify(output), "utf8")
      .digest("hex");
    expect(receipt.metadata).toEqual({ outputHash: expectedHash });
    expect(Object.keys(receipt.metadata)).toEqual(["outputHash"]);
  });

  test("writes failed receipt with { error } metadata", async () => {
    const sinkPath = makeSinkPath();
    const runtime = loadExecutionModule(sinkPath);
    const env = buildValidEnvelope("env-failed-1", "intent-failed-1");

    const record = await runtime.fireDispatch(env, env.intent, async () => {
      throw new Error("handler-boom");
    });
    expect(record.state).toBe("Failed");

    const receipts = readJsonlReceipts(sinkPath);
    expect(receipts).toHaveLength(1);

    const receipt = receipts[0];
    expect(receipt.type).toBe("receipt.failed");
    expectCoreReceiptFields(receipt, env);
    expect(receipt.metadata).toEqual({ error: "handler-boom" });
    expect(Object.keys(receipt.metadata)).toEqual(["error"]);
  });

  test("produces identical hashes for identical outputs and different hashes for different outputs", async () => {
    const sinkPath = makeSinkPath();
    const runtime = loadExecutionModule(sinkPath);
    const outputA = { ok: true, result: ["same", 1] };
    const outputB = { ok: true, result: ["same", 1] };
    const outputC = { ok: true, result: ["different", 1] };

    const env1 = buildValidEnvelope("env-hash-1", "intent-hash-1");
    const env2 = buildValidEnvelope("env-hash-2", "intent-hash-2");
    const env3 = buildValidEnvelope("env-hash-3", "intent-hash-3");

    await runtime.fireDispatch(env1, env1.intent, async () => outputA);
    await runtime.fireDispatch(env2, env2.intent, async () => outputB);
    await runtime.fireDispatch(env3, env3.intent, async () => outputC);

    const completedReceipts = readJsonlReceipts(sinkPath).filter(
      (receipt) => receipt.type === "receipt.completed"
    );
    expect(completedReceipts).toHaveLength(3);

    const hash1 = (completedReceipts[0].metadata as { outputHash: string }).outputHash;
    const hash2 = (completedReceipts[1].metadata as { outputHash: string }).outputHash;
    const hash3 = (completedReceipts[2].metadata as { outputHash: string }).outputHash;

    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
  });

  test("delivers receipt envelopes only when delivery flag is on", async () => {
    const offSinkPath = makeSinkPath();
    const offMailboxPath = path.join(path.dirname(offSinkPath), "mailbox-off.sqlite");
    process.env.AIMTP_STORE = "sqlite";
    process.env.AIMTP_MAILBOX_SQLITE_PATH = offMailboxPath;
    process.env.INTENTOS_RECEIPTS_DELIVER = "off";
    const runtimeOff = loadExecutionModule(offSinkPath);
    const offEnv = buildValidEnvelope("env-delivery-off", "intent-delivery-off");

    const offRecord = await runtimeOff.fireDispatch(offEnv, offEnv.intent, async () => ({ ok: true }));
    expect(offRecord.state).toBe("Completed");
    expect(readJsonlReceipts(offSinkPath)).toHaveLength(1);

    const mailboxOff = createSqliteMailboxStore(offMailboxPath);
    const offDeliveryRecipient = `receipt://${offEnv.intent.requester}`;
    expect(mailboxOff.peek(offDeliveryRecipient).count).toBe(0);
    mailboxOff.close?.();

    const onSinkPath = makeSinkPath();
    const onMailboxPath = path.join(path.dirname(onSinkPath), "mailbox-on.sqlite");
    process.env.AIMTP_MAILBOX_SQLITE_PATH = onMailboxPath;
    process.env.INTENTOS_RECEIPTS_DELIVER = "on";
    const runtimeOn = loadExecutionModule(onSinkPath);
    const onEnv = buildValidEnvelope("env-delivery-on", "intent-delivery-on");

    const onRecord = await runtimeOn.fireDispatch(onEnv, onEnv.intent, async () => ({ ok: true }));
    expect(onRecord.state).toBe("Completed");
    const deniedEnv: Envelope = {
      ...onEnv,
      id: "env-delivery-on-denied",
      intent: { ...onEnv.intent, id: "intent-delivery-on-denied" },
      capability: {
        ...onEnv.capability,
        id: "cap-delivery-on-denied",
        validUntilSec: onEnv.createdAtSec
      }
    };
    const deniedRecord = runtimeOn.fireAdmission(deniedEnv, deniedEnv.intent);
    expect(deniedRecord.state).toBe("Denied");
    expect(readJsonlReceipts(onSinkPath)).toHaveLength(2);

    const mailboxOn = createSqliteMailboxStore(onMailboxPath);
    const onDeliveryRecipient = `receipt://${onEnv.intent.requester}`;
    const receiptItems = mailboxOn.poll(onDeliveryRecipient, 10);
    expect(receiptItems).toHaveLength(2);
    const firstDeliveredMessage = receiptItems[0].envelope as {
      recipient: string;
      receipt: Receipt;
    };
    const secondDeliveredMessage = receiptItems[1].envelope as {
      recipient: string;
      receipt: Receipt;
    };
    expect(firstDeliveredMessage.recipient).toBe(onDeliveryRecipient);
    expect(secondDeliveredMessage.recipient).toBe(onDeliveryRecipient);
    expect(firstDeliveredMessage.receipt.type).toBe("receipt.completed");
    expect(firstDeliveredMessage.receipt.envelopeId).toBe(onEnv.id);
    expect(firstDeliveredMessage.receipt.intentId).toBe(onEnv.intent.id);
    expect(secondDeliveredMessage.receipt.type).toBe("receipt.denied");
    expect(secondDeliveredMessage.receipt.envelopeId).toBe(deniedEnv.id);
    expect(secondDeliveredMessage.receipt.intentId).toBe(deniedEnv.intent.id);
    mailboxOn.close?.();
  });
});
