import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export type ReceiptType =
  | "receipt.admitted"
  | "receipt.denied"
  | "receipt.completed"
  | "receipt.failed";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
export interface JsonArray extends ReadonlyArray<JsonValue> {}

export type ReceiptMetadata =
  | Readonly<Record<string, never>>
  | Readonly<{ reason: string }>
  | Readonly<{ outputHash: string }>
  | Readonly<{ error: string }>;

// A receipt is a protocol artifact emitted by runtime state transitions.
export interface Receipt {
  readonly receiptId: string;
  readonly envelopeId: string;
  readonly intentId: string;
  readonly type: ReceiptType;
  readonly timestamp: string;
  readonly metadata: ReceiptMetadata;
}

// A receipt message is routable AIMTP payload for requester-facing delivery.
export interface ReceiptMessage {
  readonly id: string;
  readonly recipient: string;
  readonly createdAtSec: number;
  readonly receipt: Receipt;
  readonly traceId?: string;
}

export interface ReceiptEmitter {
  emit(receipt: Receipt): void;
}

interface CreateReceiptInput {
  readonly envelopeId: string;
  readonly intentId: string;
  readonly type: ReceiptType;
  readonly timestamp?: string;
  readonly metadata: ReceiptMetadata;
}

interface CreateReceiptMessageInput {
  readonly receipt: Receipt;
  readonly requester: string;
  readonly createdAtSec?: number;
  readonly traceId?: string;
}

export function createReceipt(input: CreateReceiptInput): Receipt {
  const metadata = Object.freeze({ ...input.metadata }) as ReceiptMetadata;
  return Object.freeze({
    receiptId: randomUUID(),
    envelopeId: input.envelopeId,
    intentId: input.intentId,
    type: input.type,
    timestamp: input.timestamp ?? new Date().toISOString(),
    metadata
  });
}

export function createReceiptMessage(input: CreateReceiptMessageInput): ReceiptMessage {
  const requester = input.requester.trim();
  const traceId = input.traceId?.trim();
  return Object.freeze({
    id: `receipt-msg-${input.receipt.receiptId}`,
    recipient: `receipt://${requester}`,
    createdAtSec: input.createdAtSec ?? Math.floor(Date.now() / 1000),
    receipt: input.receipt,
    ...(traceId ? { traceId } : {})
  });
}

export function hashOutput(output: unknown): string {
  const serialized = JSON.stringify(output);
  return createHash("sha256")
    .update(serialized ?? "undefined", "utf8")
    .digest("hex");
}

export function createJsonlReceiptEmitter(filePath: string): ReceiptEmitter {
  const absolutePath = path.resolve(filePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });

  return {
    emit(receipt: Receipt): void {
      appendFileSync(absolutePath, `${JSON.stringify(receipt)}\n`, "utf8");
    }
  };
}
