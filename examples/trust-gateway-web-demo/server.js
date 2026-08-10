"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const {
  AgentTrustGateway,
  InMemoryTrustGatewayStore
} = require("../../dist/runtime/trust-gateway");
const { canonicalizeEnvelopeForSigning } = require("../../runtime/signature");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT || "8090", 10);
const INDEX_PATH = path.join(__dirname, "index.html");

function publicKey(pair) {
  return pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
}

function createDemoController() {
  let state;

  function reset() {
    const procurement = crypto.generateKeyPairSync("ed25519");
    const outsider = crypto.generateKeyPairSync("ed25519");
    const store = new InMemoryTrustGatewayStore();
    const executions = [];
    let sequence = 0;

    const config = {
      protected_recipient: "protected-commerce-service",
      identities: [
        {
          agent_id: "campaign-agent-7",
          principal_id: "acme-marketing",
          public_key_id: "campaign-agent-key",
          trusted: true,
          organization: "Acme Coffee"
        }
      ],
      policies: [
        {
          id: "campaign-spend-within-limit",
          agent_id: "campaign-agent-7",
          action: "purchase.create",
          decision: "ALLOW",
          constraints: { amount: { lte: 50 } }
        },
        {
          id: "campaign-spend-needs-approval",
          agent_id: "campaign-agent-7",
          action: "purchase.create",
          decision: "REQUIRE_APPROVAL",
          constraints: { amount: { gt: 50 } }
        }
      ]
    };

    const gateway = new AgentTrustGateway({
      config,
      store,
      logger: { error() {}, warn() {} },
      trustedKeys: [
        `campaign-agent-key=${publicKey(procurement)}`,
        `outsider-key=${publicKey(outsider)}`
      ].join(","),
      handlers: {
        "purchase.create": (input, context) => {
          const execution = {
            purchase_id: `sim-${String(executions.length + 1).padStart(3, "0")}`,
            request_id: context.request_id,
            agent_id: context.agent_id,
            item: input.item,
            amount: input.amount,
            simulated: true,
            executed_at: new Date().toISOString()
          };
          executions.push(execution);
          return execution;
        }
      }
    });

    state = {
      gateway,
      store,
      executions,
      procurement,
      outsider,
      sequence,
      pendingApprovalId: null,
      lowValueEnvelope: null,
      lastResult: null,
      lastScenario: "reset"
    };
    return snapshot();
  }

  function envelope({ amount, sender, kid, key, label }) {
    state.sequence += 1;
    const id = `web-demo-${label}-${state.sequence}`;
    const unsigned = {
      spec: "aimtp/0.1",
      id,
      timestamp: new Date().toISOString(),
      sender,
      recipient: "protected-commerce-service",
      intent: "task.request",
      message: {
        id: `${id}-message`,
        role: "user",
        content: `Purchase ${label} for the Acme Coffee campaign`
      },
      task: {
        kind: "request",
        id: `${id}-task`,
        type: "purchase.create",
        input: { item: label, amount },
        expects_response: true
      },
      metadata: { principal_id: sender === "campaign-agent-7" ? "acme-marketing" : "unknown-principal" }
    };
    const sig = crypto
      .sign(null, canonicalizeEnvelopeForSigning(unsigned), key.privateKey)
      .toString("base64");
    return { ...unsigned, signature: { alg: "ed25519", kid, sig } };
  }

  async function run(scenario) {
    let result;

    if (scenario === "allow") {
      const signed = envelope({
        amount: 25,
        sender: "campaign-agent-7",
        kid: "campaign-agent-key",
        key: state.procurement,
        label: "Audience research credits"
      });
      state.lowValueEnvelope = signed;
      result = await state.gateway.receive(signed);
    } else if (scenario === "approval") {
      const signed = envelope({
        amount: 250,
        sender: "campaign-agent-7",
        kid: "campaign-agent-key",
        key: state.procurement,
        label: "Launch-day ad campaign"
      });
      result = await state.gateway.receive(signed);
      state.pendingApprovalId = result.approval_id || null;
    } else if (scenario === "approve") {
      if (!state.pendingApprovalId) throw new Error("Create an approval request first");
      result = await state.gateway.approve(state.pendingApprovalId, "maya@acme.example");
    } else if (scenario === "duplicate") {
      if (!state.pendingApprovalId) throw new Error("Approve a request first");
      result = await state.gateway.approve(state.pendingApprovalId, "maya@acme.example");
    } else if (scenario === "replay") {
      if (!state.lowValueEnvelope) throw new Error("Run the low-value request first");
      result = await state.gateway.receive(state.lowValueEnvelope);
    } else if (scenario === "unknown") {
      result = await state.gateway.receive(envelope({
        amount: 10,
        sender: "unknown-shopping-agent",
        kid: "outsider-key",
        key: state.outsider,
        label: "Unapproved gift cards"
      }));
    } else {
      throw new Error(`Unknown scenario: ${scenario}`);
    }

    state.lastResult = result;
    state.lastScenario = scenario;
    return snapshot();
  }

  function snapshot() {
    return {
      policy: {
        trusted_agent: "campaign-agent-7",
        principal: "Acme Marketing",
        automatic_limit: 50,
        protected_action: "purchase.create"
      },
      last_scenario: state.lastScenario,
      last_result: state.lastResult,
      pending_approval_id: state.pendingApprovalId,
      executions: state.executions.slice().reverse(),
      approvals: state.store.listApprovals().map(({ envelope: _envelope, ...approval }) => approval),
      audit: state.store.listAudit(30)
    };
  }

  reset();
  return { reset, run, snapshot };
}

/*
 * Scenario names are an explicit allowlist rather than a pattern. `run()` throws
 * on an unknown name anyway, but that throw is a 409 shaped like "you called
 * these out of order" — which is a different thing from "no such scenario", and
 * only the second one should be reachable by editing the URL.
 */
const SCENARIOS = new Set(["allow", "approval", "approve", "duplicate", "replay", "unknown"]);

const SESSION_HEADER = "x-aimtp-demo-session";
const SESSION_TTL_MS = Number.parseInt(process.env.DEMO_SESSION_TTL_MS || "900000", 10);
const MAX_SESSIONS = Number.parseInt(process.env.DEMO_MAX_SESSIONS || "500", 10);
/* Enough for a guided run plus a lot of clicking; far below what a script does. */
const SESSION_RATE_LIMIT = Number.parseInt(process.env.DEMO_SESSION_RATE_LIMIT || "240", 10);
const SESSION_RATE_WINDOW_MS = Number.parseInt(process.env.DEMO_SESSION_RATE_WINDOW_MS || "60000", 10);
/* No endpoint here reads a request body. Anything with one is refused unread. */
const MAX_BODY_BYTES = 1024;

/**
 * One Gateway per visitor.
 *
 * The controller holds real Gateway state — the pending approval id, the
 * single-use envelope ids, the audit trail — so a single shared instance is
 * only correct for a single-user local run. Behind a public URL two people
 * would share one Gateway, and the second one's "approve" would claim the
 * first one's pending request. Sessions are the fix, and the reason this is
 * enforced rather than optional is that the failure is silent: the demo still
 * answers, it just answers about somebody else's requests.
 *
 * Bounded in both directions. Idle sessions expire; if the cap is reached the
 * least recently used is dropped, so a flood of session ids costs a fixed
 * amount of memory rather than an unbounded one.
 */
function createSessionRegistry({
  ttlMs = SESSION_TTL_MS,
  maxSessions = MAX_SESSIONS,
  now = () => Date.now()
} = {}) {
  const sessions = new Map();

  function sweep() {
    const cutoff = now() - ttlMs;
    for (const [id, entry] of sessions) {
      // Map iterates in insertion order and `get` re-inserts, so the first
      // entry that is still fresh means every later one is too.
      if (entry.touched > cutoff) break;
      sessions.delete(id);
    }
  }

  function get(id) {
    sweep();
    let entry = sessions.get(id);
    if (entry) {
      sessions.delete(id);
    } else {
      entry = { controller: createDemoController(), hits: [] };
    }
    entry.touched = now();
    sessions.set(id, entry);

    while (sessions.size > maxSessions) {
      const oldest = sessions.keys().next().value;
      if (oldest === id) break;
      sessions.delete(oldest);
    }
    return entry;
  }

  return { get, sweep, get size() { return sessions.size; } };
}

/** Fixed-window count per session. The website proxy rate-limits per IP; this
 *  is the backstop for anything that reaches the service directly. */
function withinRateLimit(entry, now = Date.now()) {
  entry.hits = entry.hits.filter((at) => at > now - SESSION_RATE_WINDOW_MS);
  if (entry.hits.length >= SESSION_RATE_LIMIT) return false;
  entry.hits.push(now);
  return true;
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers
  });
  res.end(JSON.stringify(body));
}

/**
 * Session ids are minted here rather than accepted from the caller, so a
 * caller cannot choose to land on another visitor's Gateway by guessing or
 * reusing an id. An unrecognised id simply gets a fresh controller, which is
 * indistinguishable from a new visit and leaks nothing.
 */
function sessionIdFrom(req) {
  const supplied = req.headers[SESSION_HEADER];
  if (typeof supplied === "string" && /^[0-9a-f]{32}$/.test(supplied)) return supplied;
  return crypto.randomBytes(16).toString("hex");
}

function hasBody(req) {
  const length = Number.parseInt(req.headers["content-length"] || "0", 10);
  return length > MAX_BODY_BYTES;
}

/**
 * `controller` pins every request to one Gateway, which is what the tests and a
 * single-user local run want. Omit it and each visitor gets their own.
 */
function createDemoServer(controller = null) {
  const registry = controller ? null : createSessionRegistry();

  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const sessionId = sessionIdFrom(req);
    const sessionHeaders = registry ? { [SESSION_HEADER]: sessionId } : {};

    try {
      if (url.pathname === "/" || url.pathname === "/index.html") {
        if (req.method !== "GET" && req.method !== "HEAD") {
          sendJson(res, 405, { error: "Method not allowed" }, { allow: "GET, HEAD" });
          return;
        }
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff"
        });
        res.end(req.method === "HEAD" ? undefined : fs.readFileSync(INDEX_PATH));
        return;
      }

      if (url.pathname === "/api/health") {
        sendJson(res, 200, { status: "ok", service: "aimtp-gateway-demo", sessions: registry ? registry.size : 1 });
        return;
      }

      const isState = url.pathname === "/api/state";
      const isReset = url.pathname === "/api/reset";
      const scenario = url.pathname.startsWith("/api/scenarios/")
        ? url.pathname.slice("/api/scenarios/".length)
        : null;

      if (!isState && !isReset && scenario === null) {
        sendJson(res, 404, { error: "Not found" }, sessionHeaders);
        return;
      }
      if (scenario !== null && !SCENARIOS.has(scenario)) {
        sendJson(res, 404, { error: "Unknown scenario" }, sessionHeaders);
        return;
      }

      const expected = isState ? "GET" : "POST";
      if (req.method !== expected) {
        sendJson(res, 405, { error: "Method not allowed" }, { ...sessionHeaders, allow: expected });
        return;
      }
      if (hasBody(req)) {
        sendJson(res, 413, { error: "Request body too large" }, sessionHeaders);
        return;
      }

      const entry = registry ? registry.get(sessionId) : { controller, hits: [] };
      if (registry && !withinRateLimit(entry)) {
        sendJson(res, 429, { error: "Too many requests" }, { ...sessionHeaders, "retry-after": "60" });
        return;
      }

      const active = entry.controller;
      if (isState) sendJson(res, 200, active.snapshot(), sessionHeaders);
      else if (isReset) sendJson(res, 200, active.reset(), sessionHeaders);
      else sendJson(res, 200, await active.run(scenario), sessionHeaders);
    } catch (error) {
      sendJson(
        res,
        409,
        { error: error instanceof Error ? error.message : "Demo action failed" },
        sessionHeaders
      );
    }
  });
}

if (require.main === module) {
  const server = createDemoServer();
  server.listen(PORT, HOST, () => {
    console.log(`AIMTP Agent Trust Gateway web demo: http://${HOST}:${PORT}`);
    console.log("All protected actions are simulated; no payment is performed.");
  });
}

module.exports = { createDemoController, createDemoServer, createSessionRegistry };
