This guide complements the diagrams in docs/overview.md.

# Implementing AIMTP (1-Page Guide)

AIMTP is a spec-first, transport-agnostic protocol for agent-to-agent message and task exchange. This guide is for implementers who want a correct, minimal v0.1 implementation.

## 1) Read the Spec First
Start with `spec/aimtp-v0.1.md`. It defines the envelope, message shape, task semantics, and error model. Do not infer behavior beyond the spec.

## 2) Use the Schemas for Validation
Validate every incoming envelope with `schemas/envelope.schema.json`. Validate message objects with `schemas/message.schema.json`. These schemas are the normative validation layer for v0.1.

## 3) Core Structures to Implement
Implement the following structures (or their equivalent) exactly, keeping them transport-agnostic:

- Envelope: `spec`, `id`, `timestamp`, `message`, plus optional routing/security metadata
- Message: `id`, `role`, `content`, plus optional `content_type`, `attachments`, `metadata`
- Task: optional `task` object on the envelope (`request` or `response`)

## 4) Envelope Rules (v0.1)
**Required:**
- `spec` (must be `aimtp/0.1`)
- `id` (non-empty string)
- `timestamp` (RFC 3339 / ISO 8601 date-time)
- `message` (valid AIMTP Message)

**Optional:**
- `sender`, `recipient`, `intent`, `task`, `signature`, `metadata`

Notes:
- Keep `intent` for routing/interpretation (e.g., `task.request`, `task.response`).
- Preserve unknown fields for forward compatibility.
- Recommended signature block fields: `alg`, `kid`, `sig` (optional `created_at`, `expires_at`).
- Backward-compatible aliases: `key_id` for `kid`, `signature` for `sig`.

## 5) Message Rules (v0.1)
**Required:**
- `id`, `role`, `content`

**Optional:**
- `content_type` (default `text/plain`)
- `attachments` (first-class, metadata references to binary content)
- `metadata`

Notes:
- `content` may be any JSON type (string/object/array/number/boolean/null).
- Use `content_type` to declare interpretation. Do not change validation behavior based on `content_type` unless your implementation profile requires it.

## 6) Task Rules (v0.1)
Tasks are optional and carried on the envelope under `task`.

**Task requests:**
- `kind: "request"`
- `id`
- `input` MUST be a JSON object when present
- `expects_response` is a best-effort hint; receivers MAY acknowledge with `running` before a final status

**Task responses:**
- `kind: "response"`
- `id` (unique identifier for the response, distinct from the request id)
- `in_response_to` MUST reference the originating TaskRequest `id`
- `status` is one of `pending | running | succeeded | failed`
- `output` and `error` are gated by status:
  - `succeeded` → `error` MUST be absent
  - `failed` → `error` MUST be present and `output` MUST be absent
  - `pending` or `running` → `output` and `error` SHOULD be absent

## 7) Minimal Implementation Checklist
- Parse JSON and validate against the schemas
- Enforce `spec` exactly (`aimtp/0.1`)
- Enforce timestamp format (RFC 3339 / date-time)
- Ignore unknown fields for forward compatibility
- Preserve `metadata` and optional objects even if you don’t interpret them yet

## 8) Conformance Testing
Run `tests/conformance/validate_schemas.py` to validate vectors. Extend vectors for your use cases without changing required fields.

## 9) Common Pitfalls
- Treating `intent` and `task.type` as interchangeable (they are related but distinct)
- Treating `expects_response` as a hard requirement (it is a hint)
- Returning `output` with failed responses
- Assuming transport behavior (AIMTP is transport-agnostic)

## 10) Reference Implementation (TypeScript)
See `src/` for type definitions and a minimal in-memory demo. It demonstrates registration, routing, and task request/response exchange without networking.

## SDK + Relay (Minimal)
```js
const { createEnvelope, createMessage, createTaskRequest, createTaskResponse } = require("aimtp/sdk");
const { WebhookRelay, createWebhookRelayServer } = require("aimtp/runtime");

const relay = new WebhookRelay({ emitResponses: true });
relay.registerAgent("agent-b", (_envelope, context) => {
  if (!context.task || context.task.kind !== "request") {
    return;
  }

  context.emit(
    createEnvelope({
      sender: "agent-b",
      recipient: context.sender,
      intent: "task.response",
      message: createMessage({ role: "assistant", content: "Done." }),
      task: createTaskResponse({
        id: `${context.task.id}-response`,
        in_response_to: context.task.id,
        status: "succeeded",
        output: { ok: true }
      })
    })
  );
});

const server = createWebhookRelayServer(relay, { path: "/inbox" });
server.listen(8080);

const requestEnvelope = createEnvelope({
  sender: "agent-a",
  recipient: "agent-b",
  intent: "task.request",
  message: createMessage({ role: "user", content: "Run a task." }),
  task: createTaskRequest({ id: "task-001", expects_response: true })
});
```

## Relay HTTP Configuration
Environment variables supported by the webhook relay server:
- `AIMTP_RELAY_PATH` (default `/aimtp`): POST endpoint for AIMTP envelopes.
- `AIMTP_HEALTH_PATH` (default `/healthz`): GET health endpoint (no auth or schema validation).
- `AIMTP_READY_PATH` (default `/readyz`): GET readiness endpoint (200 when listening, 503 otherwise).
- `AIMTP_API_KEY` (default unset): when set, relay requests require a shared API key.
  Use `Authorization: Bearer <key>` or `X-AIMTP-KEY: <key>` headers. `GET /healthz` and `GET /readyz`
  remain unauthenticated.
