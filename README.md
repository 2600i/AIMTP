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

## Examples
- `examples/python-client/` — Python interop demo (validates schemas + calls relay)
