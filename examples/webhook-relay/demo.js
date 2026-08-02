"use strict";

// Minimal end-to-end AIMTP relay example over HTTP.
//
// Shows the actual delivery model of the reference relay: envelopes POSTed to
// the relay path are validated and enqueued to the recipient's mailbox (HTTP
// 202), then the recipient polls for a lease, processes, and acknowledges.
//
// This is at-least-once delivery, not request/response. For in-process handler
// dispatch (where an agent emits task responses synchronously), see
// examples/reference-agents/ and relay.receive().

const http = require("http");
const { WebhookRelay, createWebhookRelayServer } = require("../../runtime");
const {
  createEnvelope,
  createMessage,
  createTaskRequest
} = require("../../sdk/js");

// The relay is fail-closed: if no API key is configured it rejects every
// request with 401. Set a demo key up front so this example runs standalone,
// and honor an operator-supplied key if one is already in the environment.
const API_KEY = (process.env.AIMTP_API_KEY && process.env.AIMTP_API_KEY.trim()) || "demo-key";
process.env.AIMTP_API_KEY = API_KEY;

// Use the in-memory store so repeated runs start from an empty queue. The
// default sqlite store persists to runtime/aimtp-mailbox.sqlite, which would
// make this example's queue depths accumulate across runs.
if (!process.env.AIMTP_STORE) {
  process.env.AIMTP_STORE = "memory";
}

const RELAY_PATH = "/inbox";

function request(port, method, path, payload) {
  const body = payload === undefined ? null : JSON.stringify(payload);
  const options = {
    hostname: "127.0.0.1",
    port,
    path,
    method,
    headers: Object.assign(
      { "X-AIMTP-KEY": API_KEY },
      body === null
        ? {}
        : {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body)
          }
    )
  };

  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        if (!raw) {
          resolve({ status: res.statusCode, body: null });
          return;
        }
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on("error", reject);
    if (body !== null) {
      req.write(body);
    }
    req.end();
  });
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

function show(label, response) {
  console.log(`\n${label} -> HTTP ${response.status}`);
  console.log(JSON.stringify(response.body, null, 2));
}

async function main() {
  const relay = new WebhookRelay({ emitResponses: true });
  const server = createWebhookRelayServer(relay, { path: RELAY_PATH });
  await startServer(server);
  const { port } = server.address();

  console.log(`Relay listening on http://127.0.0.1:${port}${RELAY_PATH}`);

  const requestEnvelope = createEnvelope({
    sender: "agent-a",
    recipient: "agent-b",
    intent: "task.request",
    message: createMessage({
      role: "user",
      content: "Run the demo task."
    }),
    task: createTaskRequest({
      id: "task-001",
      type: "demo",
      input: { payload: "ping" },
      expects_response: true
    })
  });

  // 1. Producer sends a validated envelope. The relay enqueues it.
  const sent = await request(port, "POST", RELAY_PATH, requestEnvelope);
  show("SEND", sent);

  // 2. Anyone can inspect queue depth without consuming.
  const peeked = await request(port, "GET", `${RELAY_PATH}/peek?recipient=agent-b`);
  show("PEEK", peeked);

  // 3. Consumer leases the message.
  const polled = await request(port, "GET", `${RELAY_PATH}/poll?recipient=agent-b&max=1`);
  show("POLL", polled);

  const leased = Array.isArray(polled.body) ? polled.body[0] : null;
  if (!leased) {
    throw new Error("expected a leased message from poll");
  }

  // 4. Consumer acknowledges, removing it from the queue. Without this the
  //    lease expires and the message is redelivered.
  const acked = await request(port, "POST", `${RELAY_PATH}/ack`, {
    recipient: "agent-b",
    lease_id: leased.lease_id
  });
  show("ACK", acked);

  // 5. Queue is now drained.
  const drained = await request(port, "GET", `${RELAY_PATH}/peek?recipient=agent-b`);
  show("PEEK (after ack)", drained);

  // 6. Rejection path: an invalid envelope never enters the mailbox.
  const rejected = await request(port, "POST", RELAY_PATH, { spec: "aimtp/0.1", id: "bad" });
  show("SEND (invalid envelope)", rejected);

  server.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
