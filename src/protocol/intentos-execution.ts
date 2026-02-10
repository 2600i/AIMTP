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
}

export type IntentHandler = (
  msg: Intent,
  env: Envelope
) => Promise<unknown> | unknown;

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
export function fireAdmission(env: Envelope, msg: Intent, hooks?: RuleHooks): ExecutionRecord {
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
  const admitted = fireAdmission(env, msg, hooks);
  if (admitted.state !== "Admitted" || !canDispatch(env, msg)) {
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
