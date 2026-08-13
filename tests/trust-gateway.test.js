"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  AgentTrustGateway,
  InMemoryTrustGatewayStore,
  SQLiteTrustGatewayStore,
  createAgentTrustGatewayServer,
  parseOperatorTokens,
  EXECUTION_FAILED_REASON
} = require("../dist/runtime/trust-gateway");
const { canonicalizeEnvelopeForSigning } = require("../runtime/signature");

const OPERATOR_TOKENS = "operator-1=s3cret-operator-token-value";
const OPERATOR_TOKEN = "s3cret-operator-token-value";
const silentLogger = { error() {}, warn() {} };

function config() {
  return {
    protected_recipient: "protected-demo-service",
    identities: [
      { agent_id: "procurement-agent-1", principal_id: "principal-1", public_key_id: "trusted-key", trusted: true },
      { agent_id: "untrusted-agent", principal_id: "principal-2", public_key_id: "untrusted-key", trusted: false }
    ],
    policies: [
      { id: "within-limit", agent_id: "procurement-agent-1", action: "purchase.create", decision: "ALLOW", constraints: { amount: { lte: 50 } } },
      { id: "over-limit", agent_id: "procurement-agent-1", action: "purchase.create", decision: "REQUIRE_APPROVAL", constraints: { amount: { gt: 50 } } },
      { id: "no-handler", agent_id: "procurement-agent-1", action: "research.query", decision: "ALLOW" }
    ]
  };
}

function unsigned(agent, amount, suffix, overrides = {}) {
  return {
    spec: "aimtp/0.1", id: `gateway-${suffix}`, timestamp: new Date().toISOString(), sender: agent,
    recipient: "protected-demo-service", intent: "task.request",
    message: { id: `message-${suffix}`, role: "user", content: "create simulated purchase" },
    task: { kind: "request", id: `task-${suffix}`, type: "purchase.create", input: { item: "test-item", amount }, expects_response: true },
    ...overrides
  };
}

function sign(envelope, privateKey, kid) {
  const signature = crypto.sign(null, canonicalizeEnvelopeForSigning(envelope), privateKey).toString("base64");
  return { ...envelope, signature: { alg: "ed25519", kid, sig: signature } };
}

async function main() {
  const trusted = crypto.generateKeyPairSync("ed25519");
  const untrusted = crypto.generateKeyPairSync("ed25519");
  const stranger = crypto.generateKeyPairSync("ed25519");
  const trustedPublic = trusted.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const untrustedPublic = untrusted.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const strangerPublic = stranger.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  let executions = 0;
  let lastExecutedAmount = null;
  const store = new InMemoryTrustGatewayStore();
  const gateway = new AgentTrustGateway({
    config: config(), store, logger: silentLogger,
    trustedKeys: `trusted-key=${trustedPublic},untrusted-key=${untrustedPublic}`,
    handlers: {
      "purchase.create": (input) => { executions += 1; lastExecutedAmount = input.amount; return { executed: true, amount: input.amount }; }
    }
  });

  // --- allow path -----------------------------------------------------------
  const allowed = await gateway.receive(sign(unsigned("procurement-agent-1", 25, "allow"), trusted.privateKey, "trusted-key"));
  assert.equal(allowed.status, "allowed");
  assert.equal(allowed.decision, "ALLOW");
  assert.equal(executions, 1, "allowed request executes");

  // --- approval path --------------------------------------------------------
  const pending = await gateway.receive(sign(unsigned("procurement-agent-1", 100, "approval"), trusted.privateKey, "trusted-key"));
  assert.equal(pending.status, "pending_approval");
  assert.ok(pending.approval_id);
  assert.equal(executions, 1, "pending request does not execute");
  const approved = await gateway.approve(pending.approval_id, "operator-1");
  assert.equal(approved.status, "completed");
  assert.equal(executions, 2, "approved request executes exactly once");
  assert.equal(lastExecutedAmount, 100, "approval executes the original payload, not a substitute");
  assert.equal(approved.result.amount, 100, "approval result carries the original amount");
  const duplicate = await gateway.approve(pending.approval_id, "operator-1");
  assert.equal(duplicate.status, "denied");
  assert.equal(executions, 2, "duplicate approval cannot execute twice");
  const unknownApproval = await gateway.approve("approval-does-not-exist", "operator-1");
  assert.equal(unknownApproval.status, "denied", "invalid approval ids are rejected");

  // --- rejection ------------------------------------------------------------
  const rejection = await gateway.receive(sign(unsigned("procurement-agent-1", 75, "reject"), trusted.privateKey, "trusted-key"));
  const rejected = gateway.reject(rejection.approval_id, "operator-2");
  assert.equal(rejected.status, "rejected");
  assert.equal(executions, 2, "rejected request does not execute");
  assert.equal((await gateway.approve(rejection.approval_id, "operator-2")).status, "denied", "a rejected approval cannot then be approved");
  assert.equal(executions, 2);

  // --- concurrent approval claims -------------------------------------------
  const raced = await gateway.receive(sign(unsigned("procurement-agent-1", 300, "race"), trusted.privateKey, "trusted-key"));
  const raceResults = await Promise.all([
    gateway.approve(raced.approval_id, "operator-1"),
    gateway.approve(raced.approval_id, "operator-2"),
    gateway.approve(raced.approval_id, "operator-3")
  ]);
  assert.equal(raceResults.filter((r) => r.status === "completed").length, 1, "exactly one concurrent approval wins");
  assert.equal(executions, 3, "concurrent approvals execute exactly once");

  // --- replay ---------------------------------------------------------------
  const replayable = sign(unsigned("procurement-agent-1", 25, "replay"), trusted.privateKey, "trusted-key");
  const firstUse = await gateway.receive(replayable);
  assert.equal(firstUse.status, "allowed");
  assert.equal(executions, 4);
  const replayed = await gateway.receive(replayable);
  assert.equal(replayed.status, "denied", "a replayed envelope is denied");
  assert.match(replayed.reason, /already been processed/i);
  assert.equal(executions, 4, "replayed envelope does not execute again");

  // --- stale envelope -------------------------------------------------------
  const stale = sign(unsigned("procurement-agent-1", 25, "stale", { timestamp: "2016-01-01T00:00:00Z" }), trusted.privateKey, "trusted-key");
  const staleResult = await gateway.receive(stale);
  assert.equal(staleResult.status, "denied", "a stale envelope is denied");
  assert.match(staleResult.reason, /freshness window/i);
  const future = sign(unsigned("procurement-agent-1", 25, "future", { timestamp: new Date(Date.now() + 86400000).toISOString() }), trusted.privateKey, "trusted-key");
  assert.match((await gateway.receive(future)).reason, /in the future/i);
  assert.equal(executions, 4, "stale and future envelopes never execute");

  // --- identity and authentication -----------------------------------------
  const untrustedResult = await gateway.receive(sign(unsigned("untrusted-agent", 25, "untrusted"), untrusted.privateKey, "untrusted-key"));
  assert.equal(untrustedResult.status, "denied");
  assert.match(untrustedResult.reason, /not trusted/i);

  const strangerGateway = new AgentTrustGateway({
    config: config(), store: new InMemoryTrustGatewayStore(), logger: silentLogger,
    trustedKeys: `trusted-key=${trustedPublic},stranger-key=${strangerPublic}`,
    handlers: { "purchase.create": () => { executions += 1; return { executed: true }; } }
  });
  const unknownKey = await strangerGateway.receive(sign(unsigned("procurement-agent-1", 25, "stranger"), stranger.privateKey, "stranger-key"));
  assert.equal(unknownKey.status, "denied", "a signing key with no configured identity is denied");
  assert.match(unknownKey.reason, /Unknown agent identity/);

  const spoofedSender = await gateway.receive(sign(unsigned("some-other-agent", 25, "spoof"), trusted.privateKey, "trusted-key"));
  assert.match(spoofedSender.reason, /Unknown agent identity/, "sender must match the key's identity");

  const spoofedPrincipal = await gateway.receive(sign(unsigned("procurement-agent-1", 25, "principal", { metadata: { principal_id: "root" } }), trusted.privateKey, "trusted-key"));
  assert.match(spoofedPrincipal.reason, /Principal does not match/, "principal cannot be claimed by the caller");

  const wrongRecipient = await gateway.receive(sign(unsigned("procurement-agent-1", 25, "recipient", { recipient: "some-other-service" }), trusted.privateKey, "trusted-key"));
  assert.match(wrongRecipient.reason, /Unknown protected recipient/);

  const tampered = sign(unsigned("procurement-agent-1", 25, "tampered"), trusted.privateKey, "trusted-key");
  tampered.task.input.amount = 26;
  const invalidAuth = await gateway.receive(tampered);
  assert.equal(invalidAuth.status, "denied");
  assert.match(invalidAuth.reason, /Signature verification failed/);

  const unsignedEnvelope = unsigned("procurement-agent-1", 25, "nosig");
  assert.equal((await gateway.receive(unsignedEnvelope)).status, "denied", "unsigned envelopes are denied");
  assert.equal(executions, 4, "no authentication or identity failure ever executes");

  // --- amount handling ------------------------------------------------------
  for (const amount of ["25", null, true, [25], { v: 25 }, -5]) {
    const suffix = `amt-${JSON.stringify(amount)}`;
    const result = await gateway.receive(sign(unsigned("procurement-agent-1", amount, suffix), trusted.privateKey, "trusted-key"));
    assert.equal(result.status, "denied", `amount ${JSON.stringify(amount)} must not satisfy the numeric policy`);
  }
  assert.equal(executions, 4, "invalid amounts never execute");

  // --- execution failure is audited and does not leak error text -------------
  const noHandler = await gateway.receive(sign(
    { ...unsigned("procurement-agent-1", 25, "nohandler"), task: { kind: "request", id: "task-nohandler", type: "research.query", input: { q: "x" } } },
    trusted.privateKey, "trusted-key"
  ));
  assert.equal(noHandler.status, "failed", "an ALLOW with no handler fails closed");
  assert.equal(noHandler.reason, EXECUTION_FAILED_REASON, "downstream error text is not echoed to the caller");
  const failureAudit = store.listAudit(200).filter((event) => event.request_id === "gateway-nohandler");
  assert.ok(failureAudit.some((event) => event.final_outcome === "authorized"), "the ALLOW decision is audited before execution");
  assert.ok(failureAudit.some((event) => event.final_outcome === "failed"), "the execution failure is audited");

  // --- revocation between request and approval ------------------------------
  const revocationGateway = new AgentTrustGateway({
    config: config(), store: new InMemoryTrustGatewayStore(), logger: silentLogger,
    trustedKeys: `trusted-key=${trustedPublic}`,
    handlers: { "purchase.create": () => { throw new Error("must not run after revocation"); } }
  });
  const beforeRevocation = await revocationGateway.receive(sign(unsigned("procurement-agent-1", 500, "revoke"), trusted.privateKey, "trusted-key"));
  assert.equal(beforeRevocation.status, "pending_approval");
  revocationGateway.config.identities[0].trusted = false;
  const afterRevocation = await revocationGateway.approve(beforeRevocation.approval_id, "operator-1");
  assert.equal(afterRevocation.status, "denied", "approval re-checks trust at approval time");
  assert.match(afterRevocation.reason, /no longer trusted/i);

  // --- audit trail ----------------------------------------------------------
  const audit = store.listAudit(200);
  assert.ok(audit.some((event) => event.final_outcome === "allowed"));
  assert.ok(audit.some((event) => event.final_outcome === "denied"));
  assert.ok(audit.some((event) => event.final_outcome === "pending_approval"));
  assert.ok(audit.some((event) => event.final_outcome === "completed"));
  assert.ok(audit.some((event) => event.final_outcome === "rejected"));
  assert.ok(audit.some((event) => event.final_outcome === "authorized"));
  assert.ok(audit.some((event) => event.final_outcome === "failed"));
  assert.ok(
    audit.every((event) => !JSON.stringify(event).includes(trustedPublic)),
    "audit events never contain key material"
  );
  const completedEvent = audit.find((event) => event.final_outcome === "completed");
  assert.equal(completedEvent.approver_id, "operator-1", "the approver is recorded in the audit trail");

  await testDurableExecution(trusted, trustedPublic);
  await testSqliteStore(trusted, trustedPublic);
  await testHttpSurface(trusted, trustedPublic);
  console.log("OK: trust gateway tests");
}

/**
 * The crash window, and what the gateway can honestly say about it.
 *
 * A process that dies between performing the protected action and recording the
 * outcome leaves a record that says EXECUTING forever. The point of these tests
 * is not that the gateway recovers the truth — it cannot — but that the
 * ambiguity becomes visible, carries a key the protected system can be asked
 * about, and can be settled by a person on the record.
 */
async function testDurableExecution(trusted, trustedPublic) {
  const store = new InMemoryTrustGatewayStore();
  let seenContext = null;
  let recordDuringExecution = null;
  const gateway = new AgentTrustGateway({
    config: config(), store, logger: silentLogger,
    trustedKeys: `trusted-key=${trustedPublic}`,
    handlers: {
      "purchase.create": (input, context) => {
        seenContext = context;
        // Read our own approval record from inside the handler. This is the only
        // moment that proves the durable write happened *before* the side effect
        // rather than around it — after the call returns, both orderings look
        // identical.
        recordDuringExecution = store.listApprovals().find((r) => r.request_id === context.request_id) || null;
        return { executed: true, amount: input.amount };
      }
    }
  });

  const pending = await gateway.receive(sign(unsigned("procurement-agent-1", 500, "durable-1"), trusted.privateKey, "trusted-key"));
  assert.equal(pending.status, "pending_approval");
  await gateway.approve(pending.approval_id, "operator-1");

  assert.equal(seenContext.idempotency_key, "gateway-durable-1", "handler receives the envelope id as its idempotency key");
  assert.equal(seenContext.request_id, seenContext.idempotency_key, "the key is the request id, not a second identifier");
  assert.equal(seenContext.attempt, 1, "a first execution reports attempt 1");
  assert.equal(recordDuringExecution.decision, "EXECUTING", "the record is durable before the side effect runs");
  assert.ok(recordDuringExecution.execution_started_at, "a start time is written before the handler is entered");
  assert.equal(recordDuringExecution.idempotency_key, "gateway-durable-1", "the key is persisted, not only passed");

  // --- a crashed execution is exactly this record, left behind ---------------
  const crashed = await gateway.receive(sign(unsigned("procurement-agent-1", 600, "durable-crash"), trusted.privateKey, "trusted-key"));
  store.transitionApproval(crashed.approval_id, "PENDING_APPROVAL", {
    decision: "EXECUTING",
    decision_at: new Date(Date.now() - 3600_000).toISOString(),
    approver_id: "operator-1",
    execution_started_at: new Date(Date.now() - 3600_000).toISOString(),
    attempts: 1,
    idempotency_key: "gateway-durable-crash"
  });

  // A generous timeout must not sweep it yet: an execution can legitimately be slow.
  assert.equal(gateway.reconcile({ staleAfterMs: 7200_000 }).length, 0, "a recent execution is not swept");
  assert.equal(store.getApproval(crashed.approval_id).decision, "EXECUTING");

  const found = gateway.reconcile({ staleAfterMs: 60_000 });
  assert.equal(found.length, 1, "an execution older than the timeout is reported");
  assert.equal(found[0].approval_id, crashed.approval_id);
  assert.equal(found[0].idempotency_key, "gateway-durable-crash", "the report carries the key to ask downstream with");
  assert.equal(store.getApproval(crashed.approval_id).decision, "IN_DOUBT");
  assert.equal(found[0].envelope, undefined, "in-doubt reports are summaries and never carry the envelope");

  const inDoubtEvent = store.listAudit(200).find((event) => event.final_outcome === "in_doubt");
  assert.ok(inDoubtEvent, "going in doubt is audited");
  assert.equal(inDoubtEvent.approval_id, crashed.approval_id);

  // Sweeping again must not re-report it, or a queue of one incident grows forever.
  assert.equal(gateway.reconcile({ staleAfterMs: 60_000 }).length, 0, "reconcile does not re-report a settled record");
  assert.equal(gateway.listInDoubt().length, 1, "the record stays listed until an operator resolves it");

  // --- an operator settles it ------------------------------------------------
  const resolved = gateway.resolveInDoubt(crashed.approval_id, "executed", "operator-2");
  assert.equal(resolved.status, "completed");
  const settled = store.getApproval(crashed.approval_id);
  assert.equal(settled.decision, "COMPLETED");
  assert.equal(settled.resolution, "executed");
  assert.equal(settled.resolved_by, "operator-2", "the finding is attributed to the operator who made it");
  const resolvedEvent = store.listAudit(200).find((event) => event.final_outcome === "resolved");
  assert.ok(resolvedEvent && resolvedEvent.approver_id === "operator-2", "the resolution is audited against its operator");
  assert.equal(gateway.listInDoubt().length, 0);

  // Resolving something that is not in doubt is refused rather than silently applied.
  assert.equal(gateway.resolveInDoubt(crashed.approval_id, "executed", "operator-2").status, "denied");
  assert.equal(gateway.resolveInDoubt("approval-does-not-exist", "executed", "operator-2").status, "denied");

  // --- not_executed leaves the action available to be requested again --------
  const second = await gateway.receive(sign(unsigned("procurement-agent-1", 700, "durable-crash-2"), trusted.privateKey, "trusted-key"));
  store.transitionApproval(second.approval_id, "PENDING_APPROVAL", {
    decision: "EXECUTING", execution_started_at: new Date(Date.now() - 3600_000).toISOString(), attempts: 1
  });
  gateway.reconcile({ staleAfterMs: 60_000 });
  assert.equal(gateway.resolveInDoubt(second.approval_id, "not_executed", "operator-2").status, "failed");
  assert.equal(store.getApproval(second.approval_id).decision, "FAILED");

  // --- records predating the field are left alone ----------------------------
  // Sweeping one would assert a start time the gateway never observed.
  const legacy = await gateway.receive(sign(unsigned("procurement-agent-1", 800, "durable-legacy"), trusted.privateKey, "trusted-key"));
  store.transitionApproval(legacy.approval_id, "PENDING_APPROVAL", { decision: "EXECUTING" });
  assert.equal(gateway.reconcile({ staleAfterMs: 0 }).length, 0, "an EXECUTING record with no start time is never swept");
  assert.equal(store.getApproval(legacy.approval_id).decision, "EXECUTING");
}

async function testSqliteStore(trusted, trustedPublic) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimtp-gw-"));
  const dbPath = path.join(dir, "gateway.sqlite");
  try {
    let executions = 0;
    const build = () => new AgentTrustGateway({
      config: config(), store: new SQLiteTrustGatewayStore(dbPath), logger: silentLogger,
      trustedKeys: `trusted-key=${trustedPublic}`,
      handlers: { "purchase.create": () => { executions += 1; return { executed: true }; } }
    });
    const first = build();
    const pending = await first.receive(sign(unsigned("procurement-agent-1", 400, "sqlite"), trusted.privateKey, "trusted-key"));
    assert.equal(pending.status, "pending_approval");

    // A second gateway process sharing the same database must not double-execute.
    const second = build();
    assert.ok(second.store.getApproval(pending.approval_id), "approvals are visible across processes");
    const results = await Promise.all([
      first.approve(pending.approval_id, "operator-1"),
      second.approve(pending.approval_id, "operator-2")
    ]);
    assert.equal(results.filter((r) => r.status === "completed").length, 1, "sqlite compare-and-swap admits one approver");
    assert.equal(executions, 1, "sqlite-backed approval executes exactly once");

    // Replay protection must survive across store instances.
    const replayable = sign(unsigned("procurement-agent-1", 25, "sqlite-replay"), trusted.privateKey, "trusted-key");
    assert.equal((await first.receive(replayable)).status, "allowed");
    assert.equal((await second.receive(replayable)).status, "denied", "sqlite replay protection is shared");
    assert.equal(executions, 2);
    assert.ok(first.store.listAudit(100).length > 0, "sqlite audit is readable");

    // Reconciliation across processes. The SQLite sweep is a different query
    // from the in-memory filter — a json_extract against stored records — so it
    // is exercised rather than assumed to match.
    const crashed = await first.receive(sign(unsigned("procurement-agent-1", 900, "sqlite-crash"), trusted.privateKey, "trusted-key"));
    const longAgo = new Date(Date.now() - 3600_000).toISOString();
    first.store.transitionApproval(crashed.approval_id, "PENDING_APPROVAL", {
      decision: "EXECUTING", execution_started_at: longAgo, attempts: 1, idempotency_key: "gateway-sqlite-crash"
    });
    assert.equal(first.reconcile({ staleAfterMs: 7200_000 }).length, 0, "sqlite sweep respects the timeout");

    // Two processes sweeping at once must report the record once between them,
    // or one incident becomes two work items for whoever is on call.
    const swept = [first.reconcile({ staleAfterMs: 60_000 }), second.reconcile({ staleAfterMs: 60_000 })];
    assert.equal(swept[0].length + swept[1].length, 1, "concurrent sweeps report a record exactly once");
    assert.equal(second.store.getApproval(crashed.approval_id).decision, "IN_DOUBT", "the state is shared across processes");

    assert.equal(second.resolveInDoubt(crashed.approval_id, "not_executed", "operator-2").status, "failed");
    assert.equal(first.store.getApproval(crashed.approval_id).decision, "FAILED", "resolution is visible to the other process");
    assert.equal(executions, 2, "reconciling and resolving never execute anything");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testHttpSurface(trusted, trustedPublic) {
  assert.equal(parseOperatorTokens("a=1,b=2").size, 2);
  assert.equal(parseOperatorTokens("bare-token").get("bare-token"), "operator");
  assert.equal(parseOperatorTokens(undefined).size, 0);

  let executions = 0;
  const gateway = new AgentTrustGateway({
    config: config(), store: new InMemoryTrustGatewayStore(), logger: silentLogger,
    trustedKeys: `trusted-key=${trustedPublic}`,
    handlers: { "purchase.create": () => { executions += 1; return { executed: true }; } }
  });
  const server = createAgentTrustGatewayServer(gateway, { operatorTokens: OPERATOR_TOKENS, maxBodyBytes: 4096 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, pathname, { body, token } = {}) => {
    const headers = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(base + pathname, { method, headers, body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)) });
    return { code: res.status, body: await res.json().catch(() => null) };
  };

  try {
    assert.equal((await call("GET", "/healthz")).code, 200);

    const pending = await call("POST", "/gateway/requests", { body: sign(unsigned("procurement-agent-1", 700, "http"), trusted.privateKey, "trusted-key") });
    assert.equal(pending.code, 200);
    assert.equal(pending.body.status, "pending_approval");
    const approvalId = pending.body.approval_id;

    // Operator routes must reject anonymous and bad-token callers.
    assert.equal((await call("GET", "/gateway/approvals")).code, 401, "listing approvals requires an operator token");
    assert.equal((await call("GET", "/gateway/audit")).code, 401, "reading the audit log requires an operator token");
    assert.equal((await call("POST", `/gateway/approvals/${approvalId}/approve`, { body: {} })).code, 401, "approving requires an operator token");
    assert.equal((await call("POST", `/gateway/approvals/${approvalId}/reject`, { body: {} })).code, 401);
    assert.equal((await call("GET", "/gateway/approvals", { token: "wrong-token" })).code, 401);
    assert.equal(executions, 0, "no anonymous caller can trigger execution");

    // An authenticated operator can act, and the approver is the token's identity.
    const listed = await call("GET", "/gateway/approvals", { token: OPERATOR_TOKEN });
    assert.equal(listed.code, 200);
    assert.equal(listed.body.approvals.length, 1);
    assert.equal(listed.body.approvals[0].envelope, undefined, "approval listings do not expose stored envelopes");

    const approved = await call("POST", `/gateway/approvals/${approvalId}/approve`, { body: { approver_id: "forged-cfo" }, token: OPERATOR_TOKEN });
    assert.equal(approved.code, 200);
    assert.equal(approved.body.status, "completed");
    assert.equal(executions, 1);
    const auditRes = await call("GET", "/gateway/audit", { token: OPERATOR_TOKEN });
    const completed = auditRes.body.events.find((event) => event.final_outcome === "completed");
    assert.equal(completed.approver_id, "operator-1", "the body-supplied approver_id is ignored");

    assert.equal((await call("POST", `/gateway/approvals/${approvalId}/approve`, { body: {}, token: OPERATOR_TOKEN })).code, 409, "a decided approval cannot be re-approved");
    assert.equal(executions, 1);

    // Replay over HTTP.
    const replayable = sign(unsigned("procurement-agent-1", 25, "http-replay"), trusted.privateKey, "trusted-key");
    assert.equal((await call("POST", "/gateway/requests", { body: replayable })).body.status, "allowed");
    assert.equal((await call("POST", "/gateway/requests", { body: replayable })).body.status, "denied");
    assert.equal(executions, 2, "an HTTP replay does not execute twice");

    // Oversized bodies are refused.
    const oversized = await call("POST", "/gateway/requests", { body: JSON.stringify({ spec: "aimtp/0.1", pad: "A".repeat(20000) }) })
      .catch((error) => ({ code: "network-error", body: error.message }));
    assert.ok(oversized.code === 413 || oversized.code === "network-error", `oversized body refused (got ${oversized.code})`);

    assert.equal((await call("GET", "/gateway/requests")).code, 404);
    assert.equal((await call("POST", "/gateway/requests", { body: "{not json" })).code, 400);

    // --- reconciliation over HTTP -------------------------------------------
    // These read and mutate execution state, so they fail closed like every
    // other operator route rather than being readable anonymously.
    assert.equal((await call("GET", "/gateway/in-doubt")).code, 401);
    assert.equal((await call("POST", "/gateway/reconcile")).code, 401);
    assert.equal((await call("POST", "/gateway/approvals/whatever/resolve", { body: { resolution: "executed" } })).code, 401);

    const crashable = await call("POST", "/gateway/requests", { body: sign(unsigned("procurement-agent-1", 950, "http-crash"), trusted.privateKey, "trusted-key") });
    assert.equal(crashable.body.status, "pending_approval");
    const executionsBefore = executions;
    gateway.store.transitionApproval(crashable.body.approval_id, "PENDING_APPROVAL", {
      decision: "EXECUTING", execution_started_at: new Date(Date.now() - 3600_000).toISOString(), attempts: 1, idempotency_key: "gateway-http-crash"
    });

    const swept = await call("POST", "/gateway/reconcile?stale_after_ms=60000", { token: OPERATOR_TOKEN });
    assert.equal(swept.code, 200);
    assert.equal(swept.body.in_doubt.length, 1, "the sweep reports the stranded execution");
    assert.equal(swept.body.in_doubt[0].envelope, undefined, "in-doubt responses never carry the stored envelope");

    const inDoubtList = await call("GET", "/gateway/in-doubt", { token: OPERATOR_TOKEN });
    assert.equal(inDoubtList.body.approvals.length, 1);
    assert.equal(inDoubtList.body.approvals[0].idempotency_key, "gateway-http-crash");

    // No default resolution: guessing would write a finding no operator made.
    const guessed = await call("POST", `/gateway/approvals/${crashable.body.approval_id}/resolve`, { body: {}, token: OPERATOR_TOKEN });
    assert.equal(guessed.code, 400, "a resolve with no finding is refused");
    const bogus = await call("POST", `/gateway/approvals/${crashable.body.approval_id}/resolve`, { body: { resolution: "maybe" }, token: OPERATOR_TOKEN });
    assert.equal(bogus.code, 400, "an unrecognised finding is refused");

    const settled = await call("POST", `/gateway/approvals/${crashable.body.approval_id}/resolve`, { body: { resolution: "executed" }, token: OPERATOR_TOKEN });
    assert.equal(settled.code, 200);
    assert.equal(settled.body.status, "completed");
    assert.equal((await call("GET", "/gateway/in-doubt", { token: OPERATOR_TOKEN })).body.approvals.length, 0);

    // Resolving twice is a conflict, not a second resolution.
    const again = await call("POST", `/gateway/approvals/${crashable.body.approval_id}/resolve`, { body: { resolution: "executed" }, token: OPERATOR_TOKEN });
    assert.equal(again.code, 409);
    assert.equal(executions, executionsBefore, "nothing on the reconciliation path executes a protected action");

    // An unconfigured deployment refuses operator access instead of opening it.
    const openServer = createAgentTrustGatewayServer(gateway, {});
    await new Promise((resolve) => openServer.listen(0, "127.0.0.1", resolve));
    const openBase = `http://127.0.0.1:${openServer.address().port}`;
    const unconfigured = await fetch(`${openBase}/gateway/approvals`);
    assert.equal(unconfigured.status, 503, "operator routes fail closed when no tokens are configured");
    openServer.close();
  } finally {
    server.close();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
