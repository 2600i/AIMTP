"use strict";

const { WebhookRelay, createWebhookRelayServer } = require("../../runtime");
const { MailboxClient, processOneLease } = require("./agent-runtime");
const { ReferenceRouterAgent } = require("./router-agent");
const { ReferenceExecutorAgent } = require("./executor-agent");
const { LocalStubLLMAdapter } = require("./llm-adapter");

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

async function main() {
  const previousApiKey = Object.prototype.hasOwnProperty.call(process.env, "AIMTP_API_KEY")
    ? process.env.AIMTP_API_KEY
    : undefined;
  process.env.AIMTP_API_KEY = "reference-demo-key";
  let server = null;
  try {
    const relay = new WebhookRelay({ emitResponses: true });
    ["agent-router", "agent-executor-1", "client-a"].forEach((recipient) => {
      relay.registerAgent(recipient, () => ({ __aimtpAccepted: true }));
    });

    server = createWebhookRelayServer(relay, {
      mailboxStoreType: "memory",
      mailboxLeaseMs: 50,
      mailboxMaxRetries: 2,
      mailboxRetryBaseMs: 1,
      mailboxRetryMaxMs: 2
    });
    try {
      await startServer(server);
    } catch (err) {
      if (err && err.code === "EPERM") {
        console.log("SKIP: reference agent demo (listen not permitted in this environment)");
        return;
      }
      throw err;
    }
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const client = new MailboxClient({
      baseUrl,
      relayPath: "/aimtp",
      apiKey: "reference-demo-key"
    });

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
      adapter: new LocalStubLLMAdapter()
    });

    const initialEnvelope = {
      spec: "aimtp/0.1",
      id: "env-demo-001",
      timestamp: new Date().toISOString(),
      sender: "client-a",
      recipient: "agent-router",
      intent: { type: "task.request", priority: "high", tags: ["demo"] },
      capabilities: { required: ["missing.capability"] },
      actions: [
        { id: "act-1", type: "summarize", inputs: { text: "AIMTP demo request for local execution." } }
      ],
      message: {
        id: "msg-demo-001",
        role: "user",
        content: "Find a capable executor."
      },
      task: {
        kind: "request",
        id: "task-demo-001",
        type: "demo.reference",
        input: { prompt: "demo" },
        expects_response: true
      }
    };

    console.log("1) enqueue initial request");
    await client.enqueueEnvelope(initialEnvelope);

    console.log("2) router polls and negotiates mismatch");
    await processOneLease({
      client,
      recipient: "agent-router",
      handler: (envelope) => router.handleEnvelope(envelope)
    });

    const negotiationPoll = await client.poll("client-a", 1);
    const negotiationLease = negotiationPoll.body && negotiationPoll.body[0];
    if (!negotiationLease) {
      throw new Error("Expected negotiation envelope for client-a");
    }
    console.log("3) client receives negotiation counter and acknowledges");
    await client.ack("client-a", negotiationLease.lease_id);

    const acceptedEnvelope = {
      spec: "aimtp/0.1",
      id: "env-demo-002",
      timestamp: new Date().toISOString(),
      sender: "client-a",
      recipient: "agent-router",
      intent: { type: "task.request", priority: "urgent", tags: ["demo", "accept"] },
      capabilities: { required: ["summarize"] },
      negotiation: { accept: true },
      actions: [
        {
          id: "act-2",
          type: "summarize",
          inputs: {
            text: "AIMTP provides schema-first messaging with leasing and retries.",
            max_words: 8
          }
        }
      ],
      message: {
        id: "msg-demo-002",
        role: "user",
        content: "Accepting counter-offer. Execute summarize action."
      },
      task: {
        kind: "request",
        id: "task-demo-002",
        type: "demo.reference",
        input: { prompt: "execute" },
        expects_response: true
      }
    };

    console.log("4) enqueue accepted negotiation request");
    await client.enqueueEnvelope(acceptedEnvelope);

    console.log("5) router routes to executor");
    await processOneLease({
      client,
      recipient: "agent-router",
      handler: (envelope) => router.handleEnvelope(envelope)
    });

    console.log("6) executor polls, executes, and acks");
    await processOneLease({
      client,
      recipient: "agent-executor-1",
      handler: (envelope) => executor.handleEnvelope(envelope)
    });

    console.log("7) client polls final response and acks");
    const responsePoll = await client.poll("client-a", 5);
    const responseLease = (responsePoll.body || []).find(
      (item) => item.envelope && item.envelope.intent === "task.response"
    );
    if (!responseLease) {
      throw new Error("Expected task response for client-a");
    }
    await client.ack("client-a", responseLease.lease_id);
    console.log(JSON.stringify(responseLease.envelope.message.content, null, 2));

  } finally {
    if (server) {
      server.close();
    }
    if (previousApiKey === undefined) {
      delete process.env.AIMTP_API_KEY;
    } else {
      process.env.AIMTP_API_KEY = previousApiKey;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
