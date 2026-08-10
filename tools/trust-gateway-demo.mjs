import crypto from "crypto";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { AgentTrustGateway, InMemoryTrustGatewayStore, loadTrustGatewayConfig } = require("../dist/runtime/trust-gateway.js");
const { canonicalizeEnvelopeForSigning } = require("../runtime/signature.js");

// Ephemeral keys: nothing is written to disk and no private key is ever committed.
const procurement = crypto.generateKeyPairSync("ed25519");
const untrusted = crypto.generateKeyPairSync("ed25519");
const stranger = crypto.generateKeyPairSync("ed25519");
const spki = (pair) => pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");

const config = loadTrustGatewayConfig(new URL("../config/trust-gateway.demo.json", import.meta.url));
const gateway = new AgentTrustGateway({
  config,
  store: new InMemoryTrustGatewayStore(),
  trustedKeys: [
    `demo-procurement-key=${spki(procurement)}`,
    `untrusted-demo-key=${spki(untrusted)}`,
    `stranger-key=${spki(stranger)}`
  ].join(",")
});

function request({ id, amount, sender = "procurement-agent-1", kid = "demo-procurement-key", key = procurement }) {
  const envelope = {
    spec: "aimtp/0.1", id, timestamp: new Date().toISOString(), sender,
    recipient: "protected-demo-service", intent: "task.request",
    message: { id: `${id}-message`, role: "user", content: "Create a simulated purchase" },
    task: { kind: "request", id: `${id}-task`, type: "purchase.create", input: { item: "test-item", amount } }
  };
  return { ...envelope, signature: { alg: "ed25519", kid, sig: crypto.sign(null, canonicalizeEnvelopeForSigning(envelope), key.privateKey).toString("base64") } };
}

const show = (label, value) => {
  console.log(`\n${label}`);
  console.log(JSON.stringify(value, null, 2));
};

console.log("=== AIMTP Agent Trust Gateway demo ===");
console.log("Policy: procurement-agent-1 may purchase up to 50; above 50 needs a human.");

show("A. Trusted agent, amount 25 -> ALLOW, protected action executes", await gateway.receive(request({ id: "demo-allow", amount: 25 })));

const pending = await gateway.receive(request({ id: "demo-approval", amount: 100 }));
show("B. Trusted agent, amount 100 -> REQUIRE_APPROVAL, nothing executes yet", pending);
show("C. Operator approves -> original request executes; the approval is claimed once", await gateway.approve(pending.approval_id, "demo-operator"));
show("   A second approval of the same id is refused", await gateway.approve(pending.approval_id, "demo-operator"));

const toReject = await gateway.receive(request({ id: "demo-reject", amount: 250 }));
show("D. Operator rejects -> the protected action never runs", gateway.reject(toReject.approval_id, "demo-operator"));

show(
  "E. Known but untrusted agent -> DENY",
  await gateway.receive(request({ id: "demo-untrusted", amount: 10, sender: "untrusted-demo-agent", kid: "untrusted-demo-key", key: untrusted }))
);
show(
  "F. Valid signature, but the key maps to no configured identity -> DENY",
  await gateway.receive(request({ id: "demo-stranger", amount: 10, sender: "procurement-agent-1", kid: "stranger-key", key: stranger }))
);

const tampered = request({ id: "demo-invalid", amount: 25 });
tampered.task.input.amount = 26;
show("G. Payload tampered after signing -> DENY before policy evaluation", await gateway.receive(tampered));

const replayed = request({ id: "demo-replay", amount: 25 });
await gateway.receive(replayed);
show("H. The same signed envelope replayed -> DENY, no second purchase", await gateway.receive(replayed));

console.log("\n=== Audit trail (newest first) ===");
console.table(
  gateway.store.listAudit(30).map((event) => ({
    request_id: event.request_id,
    agent: event.agent_id,
    auth: event.authentication_result,
    trust: event.trust_result,
    policy: event.policy_decision,
    outcome: event.final_outcome,
    reason: event.reason
  }))
);
