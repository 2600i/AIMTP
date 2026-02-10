import path from "node:path";
import { MailboxStore, createMailboxStore, parseMailboxStoreType } from "../runtime/mailbox";
import {
  Receipt,
  ReceiptEmitter,
  ReceiptMessage,
  createJsonlReceiptEmitter,
  createReceiptMessage,
  createReceipt,
  hashOutput
} from "./intentos-receipts";

/* ============================================================================
 * IntentOS v1: Operational Semantics (Small-Step, Transition-Oriented)
 * ========================================================================== */

/* Section 1: Core semantic objects */

export type MachineState =
  | "Enqueued"
  | "Admitted"
  | "Denied"
  | "Dispatched"
  | "Completed"
  | "Failed";

export type RuleName =
  | "ENQUEUE"
  | "ADMIT"
  | "DENY"
  | "DISPATCH"
  | "COMPLETE"
  | "FAIL";

export interface IntentCapabilityScope {
  readonly action: string;
  readonly resource: string;
}

export interface CapabilityToken {
  readonly id: string;
  readonly subject: string;
  readonly audience: string;
  readonly validFromSec: number;
  readonly validUntilSec: number;
  readonly scopes: ReadonlyArray<IntentCapabilityScope>;
  readonly signature: string;
}

export interface Intent {
  readonly id: string;
  readonly requester: string;
  readonly action: string;
  readonly resource: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

// Immutable message carrier.
export interface Envelope {
  readonly id: string;
  readonly recipient: string;
  readonly createdAtSec: number;
  readonly intent: Intent;
  readonly capability: CapabilityToken;
  readonly traceId?: string;
}

export interface Decision {
  readonly verdict: "ADMIT" | "DENY";
  readonly reason: string;
}

export interface Transition {
  readonly rule: RuleName;
  readonly from: MachineState | null;
  readonly to: MachineState;
  readonly atSec: number;
  readonly note: string;
}

// Immutable lifecycle audit trace.
export interface ExecutionRecord {
  readonly envelopeId: string;
  readonly intentId: string;
  readonly state: MachineState;
  readonly decision: Decision;
  readonly transitions: ReadonlyArray<Transition>;
  readonly output?: unknown;
  readonly error?: string;
}

export interface RuleHooks {
  readonly onTransition?: (transition: Transition, env: Envelope, msg: Intent) => void;
  readonly onRecord?: (record: ExecutionRecord) => void;
  readonly onReceipt?: (receipt: Receipt) => void;
}

export type IntentHandler = (
  msg: Intent,
  env: Envelope
) => Promise<unknown> | unknown;

const DEFAULT_RECEIPTS_PATH =
  process.env.INTENTOS_RECEIPTS_PATH ||
  path.join(process.cwd(), "runtime", "intentos-receipts.jsonl");

let receiptEmitter: ReceiptEmitter | null = null;
let receiptDeliveryMailbox: MailboxStore | null = null;

function getReceiptEmitter(): ReceiptEmitter {
  if (!receiptEmitter) {
    receiptEmitter = createJsonlReceiptEmitter(DEFAULT_RECEIPTS_PATH);
  }
  return receiptEmitter;
}

function parseOptionalEnvInt(value: string | undefined): number | undefined {
  if (!value || value.trim() === "") {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

function getReceiptDeliveryMailbox(): MailboxStore {
  if (!receiptDeliveryMailbox) {
    const mailboxStoreType = parseMailboxStoreType(
      process.env.AIMTP_STORE || process.env.AIMTP_MAILBOX_STORE
    );
    const mailboxSqlitePathRaw = process.env.AIMTP_MAILBOX_SQLITE_PATH?.trim();
    const mailboxSqlitePath =
      mailboxSqlitePathRaw && mailboxSqlitePathRaw.length > 0 ? mailboxSqlitePathRaw : undefined;
    const redisUrl = process.env.AIMTP_REDIS_URL?.trim();
    const redisHost = process.env.AIMTP_REDIS_HOST?.trim();
    const redisUsername = process.env.AIMTP_REDIS_USERNAME?.trim();
    const redisPassword = process.env.AIMTP_REDIS_PASSWORD?.trim();
    const redisKeyPrefix = process.env.AIMTP_REDIS_KEY_PREFIX?.trim();
    const redisCliPath = process.env.AIMTP_REDIS_CLI_PATH?.trim();
    receiptDeliveryMailbox = createMailboxStore({
      type: mailboxStoreType,
      sqlitePath: mailboxSqlitePath,
      redisUrl,
      redisHost,
      redisPort: parseOptionalEnvInt(process.env.AIMTP_REDIS_PORT),
      redisDb: parseOptionalEnvInt(process.env.AIMTP_REDIS_DB),
      redisUsername,
      redisPassword,
      redisKeyPrefix,
      redisCliPath
    });
  }
  return receiptDeliveryMailbox;
}

function isReceiptDeliveryEnabled(): boolean {
  return String(process.env.INTENTOS_RECEIPTS_DELIVER || "off").trim().toLowerCase() === "on";
}

function parseIdentity(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveReceiptRequester(env: Envelope): string | null {
  const envelope = env as Envelope & { sender?: unknown; from?: unknown };
  return (
    parseIdentity(env.intent.requester) ||
    parseIdentity(envelope.sender) ||
    parseIdentity(envelope.from)
  );
}

function deliverReceiptMessage(receipt: Receipt, env: Envelope): ReceiptMessage | null {
  if (!isReceiptDeliveryEnabled()) {
    return null;
  }

  const requester = resolveReceiptRequester(env);
  if (!requester) {
    return null;
  }

  const message = createReceiptMessage({
    receipt,
    requester,
    createdAtSec: env.createdAtSec,
    traceId: env.traceId
  });

  try {
    getReceiptDeliveryMailbox().enqueue(message.recipient, message);
  } catch {
    // Receipt delivery failures are best-effort and must not affect execution.
  }
  return message;
}

function toReceipt(record: ExecutionRecord): Receipt | null {
  if (record.state === "Admitted") {
    // Admitted means capability checks accepted execution.
    return createReceipt({
      envelopeId: record.envelopeId,
      intentId: record.intentId,
      type: "receipt.admitted",
      metadata: {}
    });
  }
  if (record.state === "Denied") {
    // Denied means admission failed with a concrete reason.
    return createReceipt({
      envelopeId: record.envelopeId,
      intentId: record.intentId,
      type: "receipt.denied",
      metadata: { reason: record.decision.reason }
    });
  }
  if (record.state === "Completed") {
    // Completed captures a deterministic hash of handler output.
    return createReceipt({
      envelopeId: record.envelopeId,
      intentId: record.intentId,
      type: "receipt.completed",
      metadata: { outputHash: hashOutput(record.output) }
    });
  }
  if (record.state === "Failed") {
    // Failed records handler error text from the runtime path.
    return createReceipt({
      envelopeId: record.envelopeId,
      intentId: record.intentId,
      type: "receipt.failed",
      metadata: { error: record.error ?? "unknown-error" }
    });
  }
  return null;
}

function emitReceipt(record: ExecutionRecord, env: Envelope, hooks?: RuleHooks): void {
  const receipt = toReceipt(record);
  if (!receipt) {
    return;
  }
  hooks?.onReceipt?.(receipt);
  try {
    getReceiptEmitter().emit(receipt);
  } catch {
    // Receipt sink failures must not alter execution semantics.
  }
  deliverReceiptMessage(receipt, env);
}

interface AdmissionOptions {
  readonly emitReceipt?: boolean;
}

/* Section 2: State graph */

export const VALID_TRANSITIONS: Readonly<Record<MachineState, ReadonlyArray<MachineState>>> = {
  Enqueued: ["Admitted", "Denied"],
  Admitted: ["Dispatched"],
  Denied: [],
  Dispatched: ["Completed", "Failed"],
  Completed: [],
  Failed: []
};

/* Section 3: Inference-rule predicates */

function scopeMatches(scopeValue: string, value: string): boolean {
  return scopeValue === "*" || scopeValue === value;
}

function denialReason(env: Envelope, msg: Intent): string {
  if (env.intent.id !== msg.id) {
    return "message-id-mismatch";
  }
  if (env.capability.subject !== msg.requester) {
    return "subject-mismatch";
  }
  if (env.capability.audience !== env.recipient) {
    return "audience-mismatch";
  }
  if (env.createdAtSec < env.capability.validFromSec) {
    return "capability-not-yet-valid";
  }
  if (env.createdAtSec >= env.capability.validUntilSec) {
    return "capability-expired";
  }
  const actionScopes = env.capability.scopes.filter((scope) =>
    scopeMatches(scope.action, msg.action)
  );
  if (actionScopes.length === 0) {
    return "action-not-permitted";
  }
  const matchedResource = actionScopes.some((scope) =>
    scopeMatches(scope.resource, msg.resource)
  );
  if (!matchedResource) {
    return "resource-not-permitted";
  }
  return "admit";
}

/*
 * (ADMIT)
 * Enqueued(Msg), CapValid(Env, Msg)  -->  Admitted(Msg)
 */
export function canAdmit(env: Envelope, msg: Intent): boolean {
  return denialReason(env, msg) === "admit";
}

/*
 * (DISPATCH)
 * Admitted(Msg), RouteExists(Env.recipient)  -->  Dispatched(Msg)
 */
export function canDispatch(env: Envelope, msg: Intent): boolean {
  return canAdmit(env, msg) && env.recipient.trim().length > 0;
}

function transition(
  rule: RuleName,
  from: MachineState | null,
  to: MachineState,
  atSec: number,
  note: string
): Transition {
  return { rule, from, to, atSec, note };
}

/*
 * (DENY)
 * Enqueued(Msg), not CapValid(Env, Msg), reason = r  -->  Denied(Msg, r)
 */
export function markDenied(env: Envelope, msg: Intent, reason: string): ExecutionRecord {
  const enqueueStep = transition(
    "ENQUEUE",
    null,
    "Enqueued",
    env.createdAtSec,
    "message entered execution substrate"
  );
  const denyStep = transition("DENY", "Enqueued", "Denied", env.createdAtSec, reason);
  return {
    envelopeId: env.id,
    intentId: msg.id,
    state: "Denied",
    decision: { verdict: "DENY", reason },
    transitions: [enqueueStep, denyStep],
    error: reason
  };
}

/* Section 4: Runtime rule firing (audit-producing transitions) */

/*
 * (ENQUEUE)
 * Env, Msg  ==>  Enqueued(Msg)
 */
export function fireEnqueue(env: Envelope, msg: Intent, hooks?: RuleHooks): ExecutionRecord {
  const enqueueStep = transition(
    "ENQUEUE",
    null,
    "Enqueued",
    env.createdAtSec,
    "message entered execution substrate"
  );
  hooks?.onTransition?.(enqueueStep, env, msg);
  const record: ExecutionRecord = {
    envelopeId: env.id,
    intentId: msg.id,
    state: "Enqueued",
    decision: { verdict: "DENY", reason: "pending-admission" },
    transitions: [enqueueStep]
  };
  hooks?.onRecord?.(record);
  return record;
}

/*
 * (ADMIT) / (DENY)
 * Enqueued(Msg), CapValid(Env, Msg)        --> Admitted(Msg)
 * Enqueued(Msg), not CapValid(Env, Msg)    --> Denied(Msg, r)
 */
export function fireAdmission(
  env: Envelope,
  msg: Intent,
  hooks?: RuleHooks,
  options?: AdmissionOptions
): ExecutionRecord {
  const shouldEmitReceipt = options?.emitReceipt ?? true;
  const enqueueStep = transition(
    "ENQUEUE",
    null,
    "Enqueued",
    env.createdAtSec,
    "message entered execution substrate"
  );
  hooks?.onTransition?.(enqueueStep, env, msg);

  const reason = denialReason(env, msg);
  if (reason !== "admit") {
    const denied = markDenied(env, msg, reason);
    hooks?.onTransition?.(denied.transitions[1], env, msg);
    hooks?.onRecord?.(denied);
    if (shouldEmitReceipt) {
      emitReceipt(denied, env, hooks);
    }
    return denied;
  }

  const admitStep = transition(
    "ADMIT",
    "Enqueued",
    "Admitted",
    env.createdAtSec,
    "capability authorizes action/resource"
  );
  hooks?.onTransition?.(admitStep, env, msg);
  const record: ExecutionRecord = {
    envelopeId: env.id,
    intentId: msg.id,
    state: "Admitted",
    decision: { verdict: "ADMIT", reason: "capability-scope-match" },
    transitions: [enqueueStep, admitStep]
  };
  hooks?.onRecord?.(record);
  if (shouldEmitReceipt) {
    emitReceipt(record, env, hooks);
  }
  return record;
}

/*
 * (DISPATCH)
 * Admitted(Msg), RouteExists  -->  Dispatched(Msg)
 *
 * (COMPLETE)
 * Dispatched(Msg), Handler(msg)=out  -->  Completed(Msg, out)
 *
 * (FAIL)
 * Dispatched(Msg), Handler(msg)=error  -->  Failed(Msg, error)
 */
export async function fireDispatch(
  env: Envelope,
  msg: Intent,
  handler: IntentHandler,
  hooks?: RuleHooks
): Promise<ExecutionRecord> {
  const admitted = fireAdmission(env, msg, hooks, { emitReceipt: false });
  if (admitted.state !== "Admitted" || !canDispatch(env, msg)) {
    emitReceipt(admitted, env, hooks);
    return admitted;
  }

  const dispatchStep = transition(
    "DISPATCH",
    "Admitted",
    "Dispatched",
    env.createdAtSec,
    "message routed to recipient handler"
  );
  hooks?.onTransition?.(dispatchStep, env, msg);

  try {
    const output = await handler(msg, env);
    const completeStep = transition(
      "COMPLETE",
      "Dispatched",
      "Completed",
      env.createdAtSec,
      "handler completed without error"
    );
    hooks?.onTransition?.(completeStep, env, msg);

    const completed: ExecutionRecord = {
      envelopeId: env.id,
      intentId: msg.id,
      state: "Completed",
      decision: { verdict: "ADMIT", reason: "capability-scope-match" },
      transitions: [...admitted.transitions, dispatchStep, completeStep],
      output
    };
    hooks?.onRecord?.(completed);
    emitReceipt(completed, env, hooks);
    return completed;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const failStep = transition("FAIL", "Dispatched", "Failed", env.createdAtSec, message);
    hooks?.onTransition?.(failStep, env, msg);

    const failed: ExecutionRecord = {
      envelopeId: env.id,
      intentId: msg.id,
      state: "Failed",
      decision: { verdict: "ADMIT", reason: "capability-scope-match" },
      transitions: [...admitted.transitions, dispatchStep, failStep],
      error: message
    };
    hooks?.onRecord?.(failed);
    emitReceipt(failed, env, hooks);
    return failed;
  }
}

/* Section 5: Minimal rule-firing examples */

export const VALID_EXAMPLE_ENV: Envelope = {
  id: "env-001",
  recipient: "agent://calendar",
  createdAtSec: 1770000100,
  intent: {
    id: "msg-001",
    requester: "did:example:alice",
    action: "calendar:create_event",
    resource: "calendar://primary/events",
    payload: { title: "sync" }
  },
  capability: {
    id: "cap-001",
    subject: "did:example:alice",
    audience: "agent://calendar",
    validFromSec: 1770000000,
    validUntilSec: 1770001000,
    scopes: [{ action: "calendar:create_event", resource: "calendar://primary/events" }],
    signature: "sig"
  }
};

export const INVALID_EXAMPLE_ENV: Envelope = {
  ...VALID_EXAMPLE_ENV,
  id: "env-002",
  intent: {
    ...VALID_EXAMPLE_ENV.intent,
    id: "msg-002",
    action: "calendar:delete_event"
  }
};

export async function runRuleExamples(): Promise<{
  readonly admittedAndCompleted: ExecutionRecord;
  readonly denied: ExecutionRecord;
}> {
  const admittedAndCompleted = await fireDispatch(
    VALID_EXAMPLE_ENV,
    VALID_EXAMPLE_ENV.intent,
    async () => ({ ok: true })
  );

  const denied = fireAdmission(INVALID_EXAMPLE_ENV, INVALID_EXAMPLE_ENV.intent);
  return { admittedAndCompleted, denied };
}
