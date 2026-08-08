import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { AIMTPEnvelope } from "../protocol/message";
import { AIMTPTaskRequest } from "../protocol/task";

const { validateEnvelope } = require("../../runtime/validation") as {
  validateEnvelope: (value: unknown) => Array<{ path: string; message: string }>;
};
const { createSignatureTrustConfig, verifyEnvelopeSignature } = require("../../runtime/signature") as {
  createSignatureTrustConfig: (options: Record<string, unknown>) => unknown;
  verifyEnvelopeSignature: (envelope: unknown, config: unknown) => any;
};

export type GatewayDecision = "ALLOW" | "DENY" | "REQUIRE_APPROVAL";
export type GatewayStatus = "allowed" | "denied" | "pending_approval" | "completed" | "rejected" | "failed";
/** `authorized` is audit-only: the decision was recorded before the protected action ran. */
export type GatewayAuditOutcome = GatewayStatus | "authorized";

export const DEFAULT_MAX_REQUEST_AGE_SEC = 300;
export const DEFAULT_CLOCK_SKEW_SEC = 60;
export const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
/** Callers never receive downstream error text; details go to the server log only. */
export const EXECUTION_FAILED_REASON = "Protected action failed";

export interface GatewayIdentity {
  agent_id: string;
  principal_id: string;
  public_key_id: string;
  trusted: boolean;
  organization?: string;
  metadata?: Record<string, unknown>;
}

export interface GatewayPolicy {
  id: string;
  agent_id?: string;
  principal_id?: string;
  action: string;
  decision: GatewayDecision;
  constraints?: { amount?: { lte?: number; lt?: number; gte?: number; gt?: number } };
}

export interface TrustGatewayConfig {
  protected_recipient: string;
  identities: GatewayIdentity[];
  policies: GatewayPolicy[];
}

export interface AuditEvent {
  event_id: string;
  request_id: string | null;
  agent_id: string | null;
  principal_id: string | null;
  action: string | null;
  authentication_result: "passed" | "failed" | "not_checked";
  trust_result: "trusted" | "untrusted" | "unknown" | "not_checked";
  policy_decision: GatewayDecision | null;
  final_outcome: GatewayAuditOutcome;
  reason: string;
  timestamp: string;
  approval_id?: string;
  approver_id?: string;
}

export interface PendingApproval {
  approval_id: string;
  request_id: string;
  agent_id: string;
  principal_id: string;
  action: string;
  envelope: AIMTPEnvelope;
  created_at: string;
  decision: "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "EXECUTING" | "COMPLETED" | "FAILED";
  decision_at?: string;
  approver_id?: string;
  result?: Record<string, unknown>;
}

/** Approval records without the stored envelope, safe to list to an operator UI. */
export type ApprovalSummary = Omit<PendingApproval, "envelope">;

export interface GatewayResponse {
  request_id: string | null;
  status: GatewayStatus;
  decision: GatewayDecision;
  reason: string;
  approval_id?: string;
  result?: Record<string, unknown>;
  matched_policy?: string;
}

export interface GatewayLogger {
  error(message: string): void;
  warn?(message: string): void;
}

export interface TrustGatewayStore {
  createApproval(record: PendingApproval): void;
  getApproval(approvalId: string): PendingApproval | null;
  listApprovals(): PendingApproval[];
  updateApproval(record: PendingApproval): void;
  /**
   * Atomically move an approval out of `from`, applying `changes`. Returns the updated
   * record, or null when the approval was not in `from` (already decided or missing).
   * This is the single-claim primitive that stops two concurrent approvers from both
   * executing. It does not survive a crash: see `approve` for why `EXECUTING` is a
   * terminal state in practice.
   */
  transitionApproval(
    approvalId: string,
    from: PendingApproval["decision"],
    changes: Partial<PendingApproval>
  ): PendingApproval | null;
  appendAudit(event: AuditEvent): void;
  listAudit(limit: number): AuditEvent[];
  /**
   * Records an envelope id as consumed. Returns true only the first time an id is
   * seen, which is what makes a captured envelope non-replayable.
   */
  registerRequestId(requestId: string, expiresAtMs: number): boolean;
}

function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function nowIso(): string { return new Date().toISOString(); }
function id(prefix: string): string { return `${prefix}-${crypto.randomUUID()}`; }
function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function summarize(record: PendingApproval): ApprovalSummary {
  const { envelope: _envelope, ...summary } = copy(record);
  return summary;
}

export class InMemoryTrustGatewayStore implements TrustGatewayStore {
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly audits: AuditEvent[] = [];
  private readonly seenRequests = new Map<string, number>();
  createApproval(record: PendingApproval): void { this.approvals.set(record.approval_id, copy(record)); }
  getApproval(approvalId: string): PendingApproval | null { const value = this.approvals.get(approvalId); return value ? copy(value) : null; }
  listApprovals(): PendingApproval[] { return Array.from(this.approvals.values()).map(copy).sort((a, b) => b.created_at.localeCompare(a.created_at)); }
  updateApproval(record: PendingApproval): void { this.approvals.set(record.approval_id, copy(record)); }
  transitionApproval(approvalId: string, from: PendingApproval["decision"], changes: Partial<PendingApproval>): PendingApproval | null {
    const current = this.approvals.get(approvalId);
    if (!current || current.decision !== from) return null;
    const next = { ...copy(current), ...copy(changes) } as PendingApproval;
    this.approvals.set(approvalId, next);
    return copy(next);
  }
  appendAudit(event: AuditEvent): void { this.audits.push(copy(event)); }
  listAudit(limit: number): AuditEvent[] { return this.audits.slice(-limit).reverse().map(copy); }
  registerRequestId(requestId: string, expiresAtMs: number): boolean {
    const now = Date.now();
    if (this.seenRequests.size > 1000) {
      this.seenRequests.forEach((expiresAt, key) => { if (expiresAt <= now) this.seenRequests.delete(key); });
    }
    const existing = this.seenRequests.get(requestId);
    if (existing !== undefined && existing > now) return false;
    this.seenRequests.set(requestId, expiresAtMs);
    return true;
  }
}

/** SQLite is intentionally small and uses the repository's existing SQLite dependency. */
export class SQLiteTrustGatewayStore implements TrustGatewayStore {
  private readonly db: any;
  constructor(sqlitePath: string) {
    const Database = require("better-sqlite3");
    this.db = new Database(sqlitePath);
    // WAL + a busy timeout so concurrent gateway processes sharing this file
    // serialise on the compare-and-swap below instead of failing.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS trust_gateway_approvals (approval_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trust_gateway_audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trust_gateway_seen_requests (request_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);`);
  }
  createApproval(record: PendingApproval): void { this.db.prepare("INSERT INTO trust_gateway_approvals (approval_id, record_json) VALUES (?, ?)").run(record.approval_id, JSON.stringify(record)); }
  getApproval(approvalId: string): PendingApproval | null { const row = this.db.prepare("SELECT record_json FROM trust_gateway_approvals WHERE approval_id = ?").get(approvalId); return row ? JSON.parse(row.record_json) : null; }
  listApprovals(): PendingApproval[] { return this.db.prepare("SELECT record_json FROM trust_gateway_approvals").all().map((row: any) => JSON.parse(row.record_json)).sort((a: PendingApproval, b: PendingApproval) => b.created_at.localeCompare(a.created_at)); }
  updateApproval(record: PendingApproval): void { this.db.prepare("UPDATE trust_gateway_approvals SET record_json = ? WHERE approval_id = ?").run(JSON.stringify(record), record.approval_id); }
  transitionApproval(approvalId: string, from: PendingApproval["decision"], changes: Partial<PendingApproval>): PendingApproval | null {
    const claim = this.db.transaction((): PendingApproval | null => {
      const row = this.db.prepare("SELECT record_json FROM trust_gateway_approvals WHERE approval_id = ?").get(approvalId);
      if (!row) return null;
      const current = JSON.parse(row.record_json) as PendingApproval;
      if (current.decision !== from) return null;
      const next = { ...current, ...changes } as PendingApproval;
      const info = this.db
        .prepare("UPDATE trust_gateway_approvals SET record_json = ? WHERE approval_id = ? AND json_extract(record_json, '$.decision') = ?")
        .run(JSON.stringify(next), approvalId, from);
      return info.changes === 1 ? next : null;
    });
    return claim();
  }
  appendAudit(event: AuditEvent): void { this.db.prepare("INSERT INTO trust_gateway_audit (event_json) VALUES (?)").run(JSON.stringify(event)); }
  listAudit(limit: number): AuditEvent[] { return this.db.prepare("SELECT event_json FROM trust_gateway_audit ORDER BY sequence DESC LIMIT ?").all(limit).map((row: any) => JSON.parse(row.event_json)); }
  registerRequestId(requestId: string, expiresAtMs: number): boolean {
    this.db.prepare("DELETE FROM trust_gateway_seen_requests WHERE expires_at <= ?").run(Date.now());
    const info = this.db
      .prepare("INSERT OR IGNORE INTO trust_gateway_seen_requests (request_id, expires_at) VALUES (?, ?)")
      .run(requestId, expiresAtMs);
    return info.changes === 1;
  }
}

export function loadTrustGatewayConfig(filePath: string | URL): TrustGatewayConfig {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as TrustGatewayConfig;
  if (!parsed || !Array.isArray(parsed.identities) || !Array.isArray(parsed.policies) || !parsed.protected_recipient) {
    throw new Error("Invalid trust gateway configuration");
  }
  return parsed;
}

function constraintMatches(input: Record<string, unknown>, constraints?: GatewayPolicy["constraints"]): boolean {
  if (!constraints || !constraints.amount) return true;
  const amount = input.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return false;
  const rule = constraints.amount;
  return !((rule.lte !== undefined && amount > rule.lte) || (rule.lt !== undefined && amount >= rule.lt) ||
    (rule.gte !== undefined && amount < rule.gte) || (rule.gt !== undefined && amount <= rule.gt));
}

export function evaluateGatewayPolicy(config: TrustGatewayConfig, identity: GatewayIdentity, action: string, input: Record<string, unknown>) {
  const matched = config.policies.find((policy) =>
    policy.action === action &&
    (!policy.agent_id || policy.agent_id === identity.agent_id) &&
    (!policy.principal_id || policy.principal_id === identity.principal_id) &&
    constraintMatches(input, policy.constraints)
  );
  if (!matched) return { decision: "DENY" as const, matched_policy: undefined, reason: "No policy allows this action", timestamp: nowIso() };
  return { decision: matched.decision, matched_policy: matched.id, reason: `Matched policy ${matched.id}`, timestamp: nowIso() };
}

type ProtectedHandler = (input: Record<string, unknown>, context: { request_id: string; agent_id: string }) => Promise<Record<string, unknown>> | Record<string, unknown>;

type RevalidationResult =
  | { ok: true; identity: GatewayIdentity; input: Record<string, unknown> }
  | { ok: false; reason: string };

export interface AgentTrustGatewayOptions {
  config: TrustGatewayConfig;
  store?: TrustGatewayStore;
  trustedKeys?: string;
  trustedKeysFile?: string;
  signatureConfig?: unknown;
  handlers?: Record<string, ProtectedHandler>;
  /** Envelopes older or newer than this are rejected. Defaults to 300s. */
  maxRequestAgeSec?: number;
  clockSkewSec?: number;
  logger?: GatewayLogger;
}

export class AgentTrustGateway {
  private readonly identitiesByKey = new Map<string, GatewayIdentity>();
  private readonly handlers = new Map<string, ProtectedHandler>();
  private readonly signatureConfig: unknown;
  private readonly maxRequestAgeMs: number;
  private readonly clockSkewMs: number;
  private readonly logger: GatewayLogger;
  public readonly store: TrustGatewayStore;
  public readonly config: TrustGatewayConfig;

  constructor(options: AgentTrustGatewayOptions) {
    this.config = options.config;
    options.config.identities.forEach((identity) => this.identitiesByKey.set(identity.public_key_id, identity));
    this.store = options.store || new InMemoryTrustGatewayStore();
    this.logger = options.logger || console;
    this.maxRequestAgeMs = Math.max(0, (options.maxRequestAgeSec ?? DEFAULT_MAX_REQUEST_AGE_SEC)) * 1000;
    this.clockSkewMs = Math.max(0, (options.clockSkewSec ?? DEFAULT_CLOCK_SKEW_SEC)) * 1000;
    // Both key sources are passed explicitly so an embedder's empty key set is not
    // silently widened by AIMTP_TRUSTED_KEYS_FILE in the ambient environment.
    this.signatureConfig = options.signatureConfig || createSignatureTrustConfig({
      policy: "enforce",
      trustedKeys: options.trustedKeys || "",
      trustedKeysFile: options.trustedKeysFile || "",
      logger: this.logger
    });
    this.handlers.set("demo.echo", (input) => ({ echoed: input }));
    this.handlers.set("purchase.create", (input) => ({ purchase_id: id("purchase"), item: input.item, amount: input.amount, simulated: true }));
    Object.entries(options.handlers || {}).forEach(([action, handler]) => this.handlers.set(action, handler));
  }

  private audit(fields: Omit<AuditEvent, "event_id" | "timestamp">): void { this.store.appendAudit({ ...fields, event_id: id("audit"), timestamp: nowIso() }); }

  private log(event: string, fields: Record<string, unknown>): void {
    this.logger.error(JSON.stringify({ event, ...fields }));
  }

  private deny(requestId: string | null, identity: GatewayIdentity | null, action: string | null, reason: string, authentication: AuditEvent["authentication_result"], trust: AuditEvent["trust_result"], approvalId?: string): GatewayResponse {
    this.audit({ request_id: requestId, agent_id: identity?.agent_id || null, principal_id: identity?.principal_id || null, action, authentication_result: authentication, trust_result: trust, policy_decision: "DENY", final_outcome: "denied", reason, approval_id: approvalId });
    return { request_id: requestId, status: "denied", decision: "DENY", reason, ...(approvalId ? { approval_id: approvalId } : {}) };
  }

  /**
   * Records the failure and returns a generic reason. The underlying error text is
   * never echoed to the caller, which would otherwise make the gateway an oracle
   * for downstream internals.
   */
  private fail(requestId: string | null, identity: GatewayIdentity | null, action: string | null, error: unknown, approvalId?: string): GatewayResponse {
    const detail = error instanceof Error ? error.message : String(error);
    this.log("trust_gateway_execution_failed", { request_id: requestId, action, approval_id: approvalId, detail });
    this.audit({ request_id: requestId, agent_id: identity?.agent_id || null, principal_id: identity?.principal_id || null, action, authentication_result: "passed", trust_result: "trusted", policy_decision: "ALLOW", final_outcome: "failed", reason: EXECUTION_FAILED_REASON, approval_id: approvalId });
    return { request_id: requestId, status: "failed", decision: "DENY", reason: EXECUTION_FAILED_REASON, ...(approvalId ? { approval_id: approvalId } : {}) };
  }

  private checkFreshness(timestamp: unknown): { ok: true } | { ok: false; reason: string } {
    if (this.maxRequestAgeMs === 0) return { ok: true };
    if (typeof timestamp !== "string") return { ok: false, reason: "Envelope timestamp is required" };
    const parsed = Date.parse(timestamp);
    if (!Number.isFinite(parsed)) return { ok: false, reason: "Envelope timestamp is not a valid date-time" };
    const now = Date.now();
    if (parsed > now + this.clockSkewMs) return { ok: false, reason: "Envelope timestamp is in the future" };
    if (parsed < now - this.maxRequestAgeMs - this.clockSkewMs) return { ok: false, reason: "Envelope timestamp is outside the accepted freshness window" };
    return { ok: true };
  }

  async receive(envelope: unknown): Promise<GatewayResponse> {
    const requestId = isObject(envelope) && typeof envelope.id === "string" ? envelope.id : null;
    const schemaErrors = validateEnvelope(envelope);
    if (schemaErrors.length) return this.deny(requestId, null, null, "Invalid AIMTP envelope", "not_checked", "not_checked");
    const request = envelope as AIMTPEnvelope;
    const verified = verifyEnvelopeSignature(request, this.signatureConfig);
    if (!verified.ok) return this.deny(request.id, null, null, verified.message || "Authentication failed", "failed", "unknown");
    const keyId = verified.details && typeof verified.details.kid === "string" ? verified.details.kid : "";
    const identity = this.identitiesByKey.get(keyId);
    if (!identity || request.sender !== identity.agent_id) return this.deny(request.id, null, null, "Unknown agent identity", "failed", "unknown");
    const suppliedPrincipal = isObject(request.metadata) ? request.metadata.principal_id : undefined;
    if (suppliedPrincipal !== undefined && suppliedPrincipal !== identity.principal_id) return this.deny(request.id, identity, null, "Principal does not match authenticated identity", "failed", "unknown");
    if (!identity.trusted) return this.deny(request.id, identity, null, "Known agent is not trusted", "passed", "untrusted");
    if (request.recipient !== this.config.protected_recipient) return this.deny(request.id, identity, null, "Unknown protected recipient", "passed", "trusted");

    // Anti-replay runs after the identity is established (so unauthenticated callers
    // cannot fill the nonce store) but before any policy evaluation or execution.
    const freshness = this.checkFreshness(request.timestamp);
    if (!freshness.ok) return this.deny(request.id, identity, null, freshness.reason, "failed", "trusted");
    let firstUse: boolean;
    try {
      firstUse = this.store.registerRequestId(request.id, Date.now() + this.maxRequestAgeMs + this.clockSkewMs);
    } catch (error) {
      this.log("trust_gateway_replay_store_error", { request_id: request.id, detail: error instanceof Error ? error.message : String(error) });
      return this.deny(request.id, identity, null, "Replay protection is unavailable", "passed", "trusted");
    }
    if (!firstUse) return this.deny(request.id, identity, null, "Envelope id has already been processed", "failed", "trusted");

    const task = request.task as AIMTPTaskRequest | undefined;
    const action = task && task.kind === "request" && typeof task.type === "string" ? task.type : "";
    const input = task && isObject(task.input) ? task.input : null;
    if (!action || !input) return this.deny(request.id, identity, action || null, "A request task with action and object input is required", "passed", "trusted");
    if (action === "purchase.create" && (typeof input.item !== "string" || !input.item.trim() || typeof input.amount !== "number" || !Number.isFinite(input.amount) || input.amount < 0)) {
      return this.deny(request.id, identity, action, "purchase.create requires a non-empty item and finite non-negative numeric amount", "passed", "trusted");
    }
    const policy = evaluateGatewayPolicy(this.config, identity, action, input);
    if (policy.decision === "DENY") return this.deny(request.id, identity, action, policy.reason, "passed", "trusted");
    if (policy.decision === "REQUIRE_APPROVAL") {
      const approval: PendingApproval = { approval_id: id("approval"), request_id: request.id, agent_id: identity.agent_id, principal_id: identity.principal_id, action, envelope: request, created_at: nowIso(), decision: "PENDING_APPROVAL" };
      this.store.createApproval(approval);
      this.audit({ request_id: request.id, agent_id: identity.agent_id, principal_id: identity.principal_id, action, authentication_result: "passed", trust_result: "trusted", policy_decision: "REQUIRE_APPROVAL", final_outcome: "pending_approval", reason: policy.reason, approval_id: approval.approval_id });
      return { request_id: request.id, status: "pending_approval", decision: "REQUIRE_APPROVAL", reason: policy.reason, approval_id: approval.approval_id, matched_policy: policy.matched_policy };
    }
    // The authorization decision is recorded before the side effect, so a handler
    // that crashes or is missing can never leave the decision unaudited.
    this.audit({ request_id: request.id, agent_id: identity.agent_id, principal_id: identity.principal_id, action, authentication_result: "passed", trust_result: "trusted", policy_decision: "ALLOW", final_outcome: "authorized", reason: policy.reason });
    try {
      const result = await this.execute(request, identity, action, input);
      this.audit({ request_id: request.id, agent_id: identity.agent_id, principal_id: identity.principal_id, action, authentication_result: "passed", trust_result: "trusted", policy_decision: "ALLOW", final_outcome: "allowed", reason: policy.reason });
      return { request_id: request.id, status: "allowed", decision: "ALLOW", reason: policy.reason, result, matched_policy: policy.matched_policy };
    } catch (error) {
      return this.fail(request.id, identity, action, error);
    }
  }

  private async execute(envelope: AIMTPEnvelope, identity: GatewayIdentity, action: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const handler = this.handlers.get(action);
    if (!handler) throw new Error(`No protected handler for action ${action}`);
    return handler(input, { request_id: envelope.id, agent_id: identity.agent_id });
  }

  /**
   * Approval is a second authorization point, not a replay of the first. Identity,
   * trust and policy are all re-checked against current configuration so that a
   * revocation between request and approval actually stops execution.
   */
  private revalidate(approval: PendingApproval): RevalidationResult {
    const signature = approval.envelope.signature;
    const kid = (signature && (signature.kid || signature.key_id)) || "";
    const identity = this.identitiesByKey.get(kid);
    if (!identity) return { ok: false, reason: "Requesting identity is no longer configured" };
    if (identity.agent_id !== approval.agent_id || identity.principal_id !== approval.principal_id) {
      return { ok: false, reason: "Requesting identity no longer matches the approval record" };
    }
    if (!identity.trusted) return { ok: false, reason: "Requesting agent is no longer trusted" };
    const task = approval.envelope.task as AIMTPTaskRequest | undefined;
    const input = task && task.kind === "request" && isObject(task.input) ? task.input : null;
    if (!input) return { ok: false, reason: "Stored request payload is no longer valid" };
    const policy = evaluateGatewayPolicy(this.config, identity, approval.action, input);
    if (policy.decision === "DENY") return { ok: false, reason: `Policy no longer permits this action: ${policy.reason}` };
    return { ok: true, identity, input };
  }

  async approve(approvalId: string, approverId: string): Promise<GatewayResponse> {
    const approval = this.store.getApproval(approvalId);
    if (!approval) return { request_id: null, status: "denied", decision: "DENY", reason: "Unknown approval id" };
    if (approval.decision !== "PENDING_APPROVAL") return { request_id: approval.request_id, status: "denied", decision: "DENY", reason: "Approval has already been decided", approval_id: approvalId };

    const revalidated = this.revalidate(approval);
    if (!revalidated.ok) {
      this.audit({ request_id: approval.request_id, agent_id: approval.agent_id, principal_id: approval.principal_id, action: approval.action, authentication_result: "passed", trust_result: "untrusted", policy_decision: "DENY", final_outcome: "denied", reason: revalidated.reason, approval_id: approvalId, approver_id: approverId });
      return { request_id: approval.request_id, status: "denied", decision: "DENY", reason: revalidated.reason, approval_id: approvalId };
    }

    // Claim the approval atomically. Losing this race means another approver (or
    // another gateway process) already took it, so this call must not execute.
    //
    // Crash window: if the process dies after `execute` performs the protected
    // action but before `COMPLETED` is written below, the record stays in
    // `EXECUTING` and nothing moves it out — there is no timeout or reconciler.
    // Closing that properly needs a durable idempotency key or outbox shared with
    // the protected system, not a change here. Documented in docs/trust-gateway.md.
    const claimed = this.store.transitionApproval(approvalId, "PENDING_APPROVAL", { decision: "EXECUTING", decision_at: nowIso(), approver_id: approverId });
    if (!claimed) return { request_id: approval.request_id, status: "denied", decision: "DENY", reason: "Approval has already been decided", approval_id: approvalId };

    try {
      const result = await this.execute(claimed.envelope, revalidated.identity, claimed.action, revalidated.input);
      this.store.updateApproval({ ...claimed, decision: "COMPLETED", result });
      this.audit({ request_id: claimed.request_id, agent_id: claimed.agent_id, principal_id: claimed.principal_id, action: claimed.action, authentication_result: "passed", trust_result: "trusted", policy_decision: "ALLOW", final_outcome: "completed", reason: "Approved by operator and executed", approval_id: approvalId, approver_id: approverId });
      return { request_id: claimed.request_id, status: "completed", decision: "ALLOW", reason: "Approved and executed", approval_id: approvalId, result };
    } catch (error) {
      this.store.updateApproval({ ...claimed, decision: "FAILED" });
      return this.fail(claimed.request_id, revalidated.identity, claimed.action, error, approvalId);
    }
  }

  reject(approvalId: string, approverId: string): GatewayResponse {
    const approval = this.store.getApproval(approvalId);
    if (!approval) return { request_id: null, status: "denied", decision: "DENY", reason: "Unknown approval id" };
    const claimed = this.store.transitionApproval(approvalId, "PENDING_APPROVAL", { decision: "REJECTED", decision_at: nowIso(), approver_id: approverId });
    if (!claimed) return { request_id: approval.request_id, status: "denied", decision: "DENY", reason: "Approval has already been decided", approval_id: approvalId };
    this.audit({ request_id: claimed.request_id, agent_id: claimed.agent_id, principal_id: claimed.principal_id, action: claimed.action, authentication_result: "passed", trust_result: "trusted", policy_decision: "DENY", final_outcome: "rejected", reason: "Rejected by operator", approval_id: approvalId, approver_id: approverId });
    return { request_id: claimed.request_id, status: "rejected", decision: "DENY", reason: "Rejected by operator", approval_id: approvalId };
  }
}

class HttpError extends Error {
  constructor(public readonly statusCode: number, message: string) { super(message); }
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.destroy();
      reject(new HttpError(413, "Request body too large"));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const failWith = (error: Error) => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(error);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) { failWith(new HttpError(413, "Request body too large")); return; }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new HttpError(400, "Invalid JSON payload")); }
    });
    req.on("error", failWith);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }

/** Parses `operator-id=token,operator-id=token`. A bare token maps to `operator`. */
export function parseOperatorTokens(raw?: string): Map<string, string> {
  const tokens = new Map<string, string>();
  if (typeof raw !== "string") return tokens;
  raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0).forEach((part) => {
    const separator = part.indexOf("=");
    if (separator <= 0 || separator === part.length - 1) { tokens.set(part, "operator"); return; }
    const operatorId = part.slice(0, separator).trim();
    const token = part.slice(separator + 1).trim();
    if (operatorId && token) tokens.set(token, operatorId);
  });
  return tokens;
}

function presentedToken(req: http.IncomingMessage): string {
  const direct = req.headers["x-aimtp-key"];
  const header = Array.isArray(direct) ? direct[0] : direct;
  if (typeof header === "string" && header.trim()) return header.trim();
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string") return "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

/** Constant-time over the configured token set; returns the operator id or null. */
function authenticateOperator(req: http.IncomingMessage, tokens: Map<string, string>): string | null {
  const presented = Buffer.from(presentedToken(req));
  if (presented.length === 0) return null;
  let operatorId: string | null = null;
  tokens.forEach((candidateOperator, token) => {
    const candidate = Buffer.from(token);
    if (candidate.length === presented.length && crypto.timingSafeEqual(candidate, presented)) {
      operatorId = candidateOperator;
    }
  });
  return operatorId;
}

export interface TrustGatewayServerOptions {
  /** `operator-id=token,...`. Required: without it the operator routes are refused. */
  operatorTokens?: string;
  maxBodyBytes?: number;
}

export function createAgentTrustGatewayServer(gateway: AgentTrustGateway, options: TrustGatewayServerOptions = {}): http.Server {
  const tokens = parseOperatorTokens(options.operatorTokens);
  const maxBodyBytes = options.maxBodyBytes && options.maxBodyBytes > 0 ? options.maxBodyBytes : DEFAULT_MAX_BODY_BYTES;

  // Fails closed: an unconfigured deployment refuses operator access rather than
  // exposing approvals and the audit log anonymously.
  const requireOperator = (req: http.IncomingMessage, res: http.ServerResponse): string | null => {
    if (tokens.size === 0) {
      send(res, 503, { code: "operator_auth_not_configured", message: "Set AIMTP_GATEWAY_OPERATOR_TOKENS to use the operator routes" });
      return null;
    }
    const operatorId = authenticateOperator(req, tokens);
    if (!operatorId) {
      send(res, 401, { code: "operator_unauthorized", message: "A valid operator token is required" });
      return null;
    }
    return operatorId;
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { status: "ok", service: "aimtp-trust-gateway" });

      if (req.method === "POST" && url.pathname === "/gateway/requests") {
        const response = await gateway.receive(await readBody(req, maxBodyBytes));
        return send(res, response.status === "failed" ? 502 : 200, response);
      }

      if (req.method === "GET" && url.pathname === "/gateway/approvals") {
        if (!requireOperator(req, res)) return;
        // Summaries only: the stored envelope stays server-side.
        return send(res, 200, { approvals: gateway.store.listApprovals().map(summarize) });
      }

      if (req.method === "GET" && url.pathname === "/gateway/audit") {
        if (!requireOperator(req, res)) return;
        return send(res, 200, { events: gateway.store.listAudit(Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50))) });
      }

      const match = url.pathname.match(/^\/gateway\/approvals\/([^/]+)\/(approve|reject)$/);
      if (req.method === "POST" && match) {
        const operatorId = requireOperator(req, res);
        if (!operatorId) return;
        // The approver is the authenticated operator; any body-supplied id is ignored.
        const response = match[2] === "approve" ? await gateway.approve(match[1], operatorId) : gateway.reject(match[1], operatorId);
        return send(res, response.status === "denied" ? 409 : response.status === "failed" ? 502 : 200, response);
      }
    } catch (error) {
      const status = error instanceof HttpError ? error.statusCode : 400;
      const reason = error instanceof HttpError ? error.message : "Invalid request";
      if (res.headersSent) return;
      return send(res, status, { status: "denied", decision: "DENY", reason });
    }
    return send(res, 404, { code: "not_found" });
  });
}

if (require.main === module) {
  const configPath = process.env.AIMTP_TRUST_GATEWAY_CONFIG || path.join(process.cwd(), "config", "trust-gateway.demo.json");
  const storeType = process.env.AIMTP_TRUST_GATEWAY_STORE || "sqlite";
  const store = storeType === "memory" ? new InMemoryTrustGatewayStore() : new SQLiteTrustGatewayStore(process.env.AIMTP_TRUST_GATEWAY_SQLITE_PATH || path.join(process.cwd(), "runtime", "aimtp-trust-gateway.sqlite"));
  const gateway = new AgentTrustGateway({
    config: loadTrustGatewayConfig(configPath),
    store,
    trustedKeys: process.env.AIMTP_TRUSTED_KEYS || "",
    trustedKeysFile: process.env.AIMTP_TRUSTED_KEYS_FILE || "",
    maxRequestAgeSec: Number(process.env.AIMTP_GATEWAY_MAX_REQUEST_AGE_SEC) || DEFAULT_MAX_REQUEST_AGE_SEC
  });
  const operatorTokens = process.env.AIMTP_GATEWAY_OPERATOR_TOKENS || "";
  const server = createAgentTrustGatewayServer(gateway, {
    operatorTokens,
    maxBodyBytes: Number(process.env.AIMTP_GATEWAY_MAX_BODY_BYTES) || DEFAULT_MAX_BODY_BYTES
  });
  const port = Number(process.env.PORT || "8788");
  const bindHostRaw = process.env.AIMTP_BIND_HOST?.trim();
  const bindHost = bindHostRaw && bindHostRaw.length > 0 ? bindHostRaw : "127.0.0.1";
  if (!operatorTokens.trim()) {
    console.warn("AIMTP_GATEWAY_OPERATOR_TOKENS is unset; /gateway/approvals and /gateway/audit will return 503.");
  }
  if (!process.env.AIMTP_TRUSTED_KEYS && !process.env.AIMTP_TRUSTED_KEYS_FILE) {
    console.warn("No AIMTP_TRUSTED_KEYS or AIMTP_TRUSTED_KEYS_FILE configured; every request will be denied.");
  }
  server.listen(port, bindHost, () => console.log(`AIMTP Trust Gateway listening on ${bindHost}:${port}`));
}
