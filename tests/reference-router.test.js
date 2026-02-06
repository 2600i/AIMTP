"use strict";

const assert = require("assert");
const { ReferenceRouterAgent } = require("../examples/reference-agents/router-agent");

function buildEnvelope(overrides = {}) {
  return Object.assign(
    {
      spec: "aimtp/0.1",
      id: "env-router-001",
      timestamp: "2026-02-06T00:00:00Z",
      sender: "client-a",
      recipient: "agent-router",
      intent: { type: "task.request", priority: "high" },
      capabilities: { required: ["summarize"] },
      actions: [{ id: "act-1", type: "summarize", inputs: { text: "hello world" } }],
      message: {
        id: "msg-router-001",
        role: "user",
        content: "Route this request."
      }
    },
    overrides
  );
}

async function main() {
  const router = new ReferenceRouterAgent({
    id: "agent-router",
    executors: [
      { recipient: "agent-exec-a", capabilities: ["extract", "format"] },
      { recipient: "agent-exec-b", capabilities: ["summarize", "extract", "format"], basePriority: 5 }
    ]
  });

  const routeDecision = router.describeDecision(buildEnvelope());
  assert.strictEqual(routeDecision.decision, "route");
  assert.strictEqual(routeDecision.recipient, "agent-exec-b");

  const mismatchDecision = router.describeDecision(
    buildEnvelope({
      id: "env-router-002",
      capabilities: { required: ["missing.capability"] },
      actions: [{ id: "act-x", type: "missing.capability", inputs: {} }]
    })
  );
  assert.strictEqual(mismatchDecision.decision, "negotiate");
  assert.ok(Array.isArray(mismatchDecision.offered_capabilities));
  assert.ok(mismatchDecision.offered_capabilities.includes("summarize"));

  const negotiationResult = await router.handleEnvelope(
    buildEnvelope({
      id: "env-router-003",
      capabilities: { required: ["missing.capability"] },
      actions: [{ id: "act-y", type: "missing.capability", inputs: {} }]
    })
  );
  assert.strictEqual(negotiationResult.decision.decision, "negotiate");
  assert.strictEqual(negotiationResult.outbound.length, 1);
  assert.strictEqual(negotiationResult.outbound[0].recipient, "client-a");
  assert.ok(negotiationResult.outbound[0].negotiation.counter);

  console.log("OK: reference router tests");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
