# AIMTP

## What is AIMTP?
AIMTP (AI Message Transfer Protocol) is a minimal, transport-agnostic envelope and type system for exchanging AI messages and tasks between agents. It specifies structure and intent, not transport mechanics.

## Why it exists
- A shared, boring core that multiple teams can implement independently.
- Clear separation of transport from message and task semantics.
- A small surface area that can be validated and extended without lock-in.

## Core concepts
- Agents: `AIMTPAgent` describes the identity and capabilities of a sender/recipient.
- Messages: `AIMTPMessage` carries the human- or tool-facing content.
- Tasks: `AIMTPTask` and `AIMTPResponse` define request/response intent and status.

## Minimal example
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
  recipients: ["agent-b"],
  message,
  task
});
```

## What AIMTP is NOT (yet)
- A transport or networking protocol (no sockets, HTTP, or RPC).
- A full conversation or memory model.
- A security or authentication standard.

## Status
- Version: 0.1 (draft)
- Stability: Experimental

## Repo Layout
- `spec/aimtp-v0.1.md` — protocol specification
- `schemas/` — JSON Schemas
- `src/` — TypeScript reference implementation
- `docs/` — diagrams and whitepaper assets
- `examples/`
- `tests/`

## Build
```
npm ci
npm run build
```

## License
- TBD
