"use strict";

const assert = require("assert");
const { WebhookRelay, createWebhookRelayServer } = require("../runtime");
const { MailboxClient, processOneLease } = require("../examples/reference-agents/agent-runtime");
const { ReferenceRouterAgent } = require("../examples/reference-agents/router-agent");
const { ReferenceExecutorAgent } = require("../examples/reference-agents/executor-agent");
const { LocalStubLLMAdapter } = require("../examples/reference-agents/llm-adapter");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withEnv(values, fn) {
  const previous = {};
  Object.keys(values).forEach((key) => {
    previous[key] = Object.prototype.hasOwnProperty.call(process.env, key)
      ? process.env[key]
      : undefined;
    if (values[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = String(values[key]);
    }
  });
  try {
    return await fn();
  } finally {
    Object.keys(values).forEach((key) => {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    });
  }
}

function startServer(server) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener("listening", onListen);
      reject(err);
    };
    const onListen = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListen);
    server.listen(0, "127.0.0.1");
  });
}

async function withServer(fn) {
  const relay = new WebhookRelay({ emitResponses: true });
  ["agent-router", "agent-executor-1", "client-a"].forEach((agentId) => {
    relay.registerAgent(agentId, () => ({ __aimtpAccepted: true }));
  });
  const server = createWebhookRelayServer(relay, {
    mailboxStoreType: "memory",
    mailboxLeaseMs: 50,
    mailboxMaxRetries: 1,
    mailboxRetryBaseMs: 1,
    mailboxRetryMaxMs: 2
  });

  try {
    await startServer(server);
  } catch (err) {
    if (err && err.code === "EPERM") {
      console.log("SKIP: reference flow test (listen not permitted)");
      return false;
    }
    throw err;
  }

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const client = new MailboxClient({ baseUrl, relayPath: "/aimtp", apiKey: "reference-test-key" });

  try {
    await fn({ client });
  } finally {
    server.close();
  }
  return true;
}

async function main() {
  await withEnv(
    {
      AIMTP_API_KEY: "reference-test-key",
      AIMTP_ALLOWED_RECIPIENTS: undefined,
      AIMTP_ALLOWED_SENDERS: undefined,
      AIMTP_RECIPIENT_KEYS: undefined,
      AIMTP_KEY_RECIPIENTS: undefined,
      AIMTP_SIGNATURE_POLICY: "off"
    },
    async () => {
      const ran = await withServer(async ({ client }) => {
        const adapter = new LocalStubLLMAdapter();
        const router = new ReferenceRouterAgent({
          id: "agent-router",
          executors: [
            {
              recipient: "agent-executor-1",
              capabilities: ["summarize", "extract", "validate_schema", "format", "stub.local"]
            }
          ]
        });
        const executor = new ReferenceExecutorAgent({
          id: "agent-executor-1",
          adapter
        });

        const mismatchEnvelope = {
          spec: "aimtp/0.1",
          id: "env-negotiation-001",
          timestamp: new Date().toISOString(),
          sender: "client-a",
          recipient: "agent-router",
          intent: { type: "task.request", priority: "high" },
          capabilities: { required: ["missing.capability"] },
          actions: [{ id: "act-neg-1", type: "summarize", inputs: { text: "hello" } }],
          message: {
            id: "msg-negotiation-001",
            role: "user",
            content: "Need unavailable capability."
          },
          task: {
            kind: "request",
            id: "task-negotiation-001",
            type: "route.demo",
            input: { text: "hello" },
            expects_response: true
          }
        };

        const enqueueMismatch = await client.enqueueEnvelope(mismatchEnvelope);
        assert.strictEqual(enqueueMismatch.status, 202);

        const routerNegotiation = await processOneLease({
          client,
          recipient: "agent-router",
          handler: (envelope) => router.handleEnvelope(envelope)
        });
        assert.strictEqual(routerNegotiation.processed, true);
        assert.strictEqual(routerNegotiation.status, "acknowledged");
        assert.strictEqual(routerNegotiation.result.decision.decision, "negotiate");

        const negotiationPoll = await client.poll("client-a", 1);
        assert.strictEqual(negotiationPoll.status, 200);
        assert.strictEqual(negotiationPoll.body.length, 1);
        assert.ok(negotiationPoll.body[0].envelope.negotiation.counter);
        await client.ack("client-a", negotiationPoll.body[0].lease_id);

        const acceptedEnvelope = {
          spec: "aimtp/0.1",
          id: "env-negotiation-002",
          timestamp: new Date().toISOString(),
          sender: "client-a",
          recipient: "agent-router",
          intent: { type: "task.request", priority: "urgent" },
          capabilities: { required: ["summarize"] },
          negotiation: { accept: true },
          actions: [
            {
              id: "act-run-1",
              type: "summarize",
              inputs: {
                text: "AIMTP uses schema-first envelopes and mailbox leasing for delivery.",
                max_words: 7
              }
            }
          ],
          message: {
            id: "msg-negotiation-002",
            role: "user",
            content: "Counter-offer accepted. Execute summarize."
          },
          task: {
            kind: "request",
            id: "task-negotiation-002",
            type: "route.demo",
            input: { text: "execute" },
            expects_response: true
          }
        };

        const enqueueAccepted = await client.enqueueEnvelope(acceptedEnvelope);
        assert.strictEqual(enqueueAccepted.status, 202);

        const routerForward = await processOneLease({
          client,
          recipient: "agent-router",
          handler: (envelope) => router.handleEnvelope(envelope)
        });
        assert.strictEqual(routerForward.status, "acknowledged");
        assert.strictEqual(routerForward.result.decision.decision, "route");
        assert.strictEqual(routerForward.result.decision.recipient, "agent-executor-1");

        const executorRun = await processOneLease({
          client,
          recipient: "agent-executor-1",
          handler: (envelope) => executor.handleEnvelope(envelope)
        });
        assert.strictEqual(executorRun.status, "acknowledged");
        assert.strictEqual(adapter.calls.length, 1);

        const responsePoll = await client.poll("client-a", 5);
        const responseItem = responsePoll.body.find(
          (item) =>
            item.envelope &&
            item.envelope.intent === "task.response" &&
            item.envelope.metadata &&
            item.envelope.metadata.aimtp &&
            item.envelope.metadata.aimtp.source_envelope_id === "env-negotiation-002:route:agent-executor-1"
        );
        assert.ok(responseItem, "expected final task response");
        assert.ok(responseItem.envelope.message.content.outputs[0].result.summary);
        await client.ack("client-a", responseItem.lease_id);

        const idempotentEnvelope = {
          spec: "aimtp/0.1",
          id: "env-idempotent-001",
          timestamp: new Date().toISOString(),
          sender: "client-a",
          recipient: "agent-executor-1",
          intent: "task.request",
          actions: [{ id: "act-idem-1", type: "summarize", inputs: { text: "idempotent path" } }],
          message: {
            id: "msg-idempotent-001",
            role: "user",
            content: "Run idempotent action."
          }
        };

        const beforeIdempotentCalls = adapter.calls.length;
        await client.enqueueEnvelope(idempotentEnvelope);

        let failAfterOnce = true;
        const firstIdempotentAttempt = await processOneLease({
          client,
          recipient: "agent-executor-1",
          handler: (envelope) => executor.handleEnvelope(envelope),
          onSuccess: () => {
            if (failAfterOnce) {
              failAfterOnce = false;
              return "fail";
            }
            return "ack";
          }
        });
        assert.strictEqual(firstIdempotentAttempt.status, "failed_after_processing");
        await sleep(5);

        const secondIdempotentAttempt = await processOneLease({
          client,
          recipient: "agent-executor-1",
          handler: (envelope) => executor.handleEnvelope(envelope)
        });
        assert.strictEqual(secondIdempotentAttempt.status, "acknowledged");
        assert.strictEqual(adapter.calls.length, beforeIdempotentCalls + 1);

        const idempotentResponsePoll = await client.poll("client-a", 10);
        const idempotentResponses = idempotentResponsePoll.body.filter(
          (item) =>
            item.envelope &&
            item.envelope.metadata &&
            item.envelope.metadata.aimtp &&
            item.envelope.metadata.aimtp.source_envelope_id === "env-idempotent-001"
        );
        assert.strictEqual(idempotentResponses.length, 1);
        await client.ack("client-a", idempotentResponses[0].lease_id);

        const deadLetterEnvelope = {
          spec: "aimtp/0.1",
          id: "env-dead-001",
          timestamp: new Date().toISOString(),
          sender: "client-a",
          recipient: "agent-executor-1",
          intent: "task.request",
          actions: [{ id: "act-dead-1", type: "unsupported_action", inputs: {} }],
          message: {
            id: "msg-dead-001",
            role: "user",
            content: "This should fail repeatedly."
          }
        };

        await client.enqueueEnvelope(deadLetterEnvelope);
        const deadAttempt1 = await processOneLease({
          client,
          recipient: "agent-executor-1",
          handler: (envelope) => executor.handleEnvelope(envelope)
        });
        assert.strictEqual(deadAttempt1.status, "failed");
        assert.strictEqual(deadAttempt1.fail.body.status, "requeued");
        await sleep(5);

        const deadAttempt2 = await processOneLease({
          client,
          recipient: "agent-executor-1",
          handler: (envelope) => executor.handleEnvelope(envelope)
        });
        assert.strictEqual(deadAttempt2.status, "failed");
        assert.strictEqual(deadAttempt2.fail.body.status, "dead_lettered");

        const deadLetters = await client.deadLetters("agent-executor-1", 5);
        assert.strictEqual(deadLetters.status, 200);
        assert.ok(Array.isArray(deadLetters.body));
        assert.strictEqual(deadLetters.body.length, 1);
        assert.strictEqual(deadLetters.body[0].envelope.id, "env-dead-001");
      });
      if (!ran) {
        return;
      }
    }
  );

  console.log("OK: reference flow tests");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
