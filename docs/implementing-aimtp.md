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
