# AIMTP — Agentic Intelligent Message Transfer Protocol

**Status:** v0.1 candidate — protocol surface frozen except for errata

AIMTP is a spec-first, transport-agnostic protocol for structured
agent-to-agent message and task exchange.

It defines **what is sent and why**, not **how it is transported**.

---

## What is AIMTP?

AIMTP (Agentic Intelligent Message Transfer Protocol) specifies a minimal
JSON envelope, message model, and task semantics for exchanging intent,
content, and results between autonomous agents.

It is designed to be:
- implementation-neutral
- interoperable across teams and runtimes
- easy to validate
- extensible without lock-in

AIMTP intentionally avoids assumptions about networks, frameworks,
or hosting environments.

---

## Why AIMTP exists

Most agent systems fail to interoperate because they couple:
- transport with semantics
- execution with intent
- implementation details with protocol meaning

AIMTP exists to provide a **shared, boring core** that different systems
can implement independently while still understanding each other.

Specifically, AIMTP provides:
- a clear separation of transport from message and task semantics
- a small, auditable protocol surface
- machine-verifiable schemas with human-readable intent
- forward compatibility through permissive extension points

---

## Core Concepts

### Agents
An *agent* is any autonomous system capable of sending or receiving AIMTP
envelopes. Agent identity is implementation-defined and transport-agnostic.

### Messages
An **AIMTP Message** carries human- or tool-facing content.
Messages may contain plain text or structured JSON and may include
attachments referenced by metadata.

### Tasks
An **AIMTP Task** encodes request/response intent and execution status.
Tasks support synchronous and asynchronous workflows through explicit
status signaling (`running`, `succeeded`, `failed`).

Tasks are optional and carried alongside messages in the envelope.

---

## Minimal Example (Reference Runtime)

```ts
import { AgentRegistry, MessageRouter } from "./dist";
import { AIMTPMessage, AIMTPTaskRequest } from "./dist";

const registry = new AgentRegistry();
const router = new MessageRouter(registry);

registry.register({ id: "agent-a" }, () => {});
registry.register({ id: "agent-b" }, async (_message, context) => {
  if (context?.task?.kind !== "request") return;
  console.log("Agent B received task", context.task.id);
});

const task: AIMTPTaskRequest = {
  kind: "request",
  id: "task-001",
  type: "demo",
  input: { payload: "ping" },
  expects_response: true
};

const message: AIMTPMessage = {
  id: "msg-001",
  role: "user",
  content: "Run the demo task."
};

await router.deliver({
  sender: "agent-a",
  recipient: "agent-b",
  message,
  task
});
```

## Runtime & Relay
See `docs/runtime.md` for runtime configuration and relay behavior details. The
relay now supports mailbox polling endpoints and requires authentication for
`/aimtp`, `/aimtp/peek`, `/aimtp/poll`, `/aimtp/ack`, `/aimtp/fail`, and
`/aimtp/dead` (admin key or per-recipient keys).

## Web Demo
Use `examples/web-inbox/index.html` for a browser demo that can send envelopes,
peek queue depth, and poll + acknowledge mailbox messages.

Open it either directly:
- `file:///.../AIMTP/examples/web-inbox/index.html`

Or serve locally (recommended for browser fetch/CORS consistency):
```sh
npm run demo:web
```
Then open `http://localhost:8080`.

Usage:
1. Enter relay URL (default `https://relay.aimtp.net`) and API key.
2. Keep sender `agent-a` / recipient `agent-b` or change as needed.
3. Click `Send`, then `Peek`, then `Poll`.

Local relay example (mailbox endpoints):
```sh
AIMTP_API_KEY=dev-key AIMTP_STORE=redis AIMTP_ALLOWLIST_RECIPIENTS=0 PORT=8788 node dist/runtime/relay.js

curl -X POST "http://127.0.0.1:8788/aimtp/mailbox" \
  -H "Content-Type: application/json" \
  -H "X-AIMTP-KEY: dev-key" \
  -d '{"recipient":"agent-b","message":{"text":"ping"}}'

curl "http://127.0.0.1:8788/aimtp/peek?recipient=agent-b" \
  -H "X-AIMTP-KEY: dev-key"

curl "http://127.0.0.1:8788/aimtp/poll?recipient=agent-b&max=10" \
  -H "X-AIMTP-KEY: dev-key"

curl -X POST "http://127.0.0.1:8788/aimtp/ack" \
  -H "Content-Type: application/json" \
  -H "X-AIMTP-KEY: dev-key" \
  -d '{"recipient":"agent-b","lease_id":"<lease-id>"}'
```

Notes:
- API key stays in memory only (not persisted).
- CORS is enabled by default for `http://localhost:8080` and
  `http://127.0.0.1:8080`.
- Set `AIMTP_CORS_ORIGINS` (comma-separated origins) to extend allowed browser
  origins.
- Mailbox storage defaults to SQLite (`runtime/aimtp-mailbox.sqlite`) so queued
  messages survive relay restarts.
- Set `AIMTP_STORE=redis` to use Redis-backed mailbox lists.
- If Redis is unavailable, relay falls back to SQLite automatically.
- Polling leases messages. Use `/aimtp/ack` after successful processing or
  `/aimtp/fail` to requeue and retry.

zsh-safe curl examples (`?` query is quoted):
```sh
curl "https://relay.aimtp.net/aimtp/peek?recipient=agent-b" \
  -H "X-AIMTP-KEY: $AIMTP_API_KEY"

curl "https://relay.aimtp.net/aimtp/poll?recipient=agent-b&max=10" \
  -H "X-AIMTP-KEY: $AIMTP_API_KEY"

curl -X POST "https://relay.aimtp.net/aimtp/ack" \
  -H "Content-Type: application/json" \
  -H "X-AIMTP-KEY: $AIMTP_API_KEY" \
  -d '{"recipient":"agent-b","lease_id":"<lease-id>"}'
```

## Examples
- `examples/python-client/` — Python interop demo (validates schemas + calls relay)
- `examples/web-inbox/` — Browser demo (send + mailbox peek/poll)
