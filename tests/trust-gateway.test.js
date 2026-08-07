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

  await testSqliteStore(trusted, trustedPublic);
  await testHttpSurface(trusted, trustedPublic);
  console.log("OK: trust gateway tests");
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
