# IntentOS v0.1 Groundwork on AIMTP

## 1. Overview

IntentOS is an application layer built on AIMTP envelopes to support user intents, orchestration, and agent execution with auditable state.

- Implementations MUST represent IntentOS operations as AIMTP envelope-driven actions.
- Implementations MUST preserve AIMTP Phase 7 federation checks, Phase 8 identity verification, and Phase 9 capability authorization semantics.
- IntentOS in v0.1 SHOULD remain deterministic and minimal (CLI and JSON endpoints only).

## 2. Terminology

- `Intent`: A user-submitted goal and lifecycle record in an Intent Inbox.
- `Task`: A unit of work derived from an intent.
- `Run`: The end-to-end execution of an intent until completion/failure.
- `Agent`: A principal that claims tasks and executes tools.
- `Tool`: A deterministic function invoked by an agent for a task.
- `Claim`: Agent task-ownership operation (`task.claim`).
- `Result`: Output/failure posted for a claimed task.

## 3. Core Objects (Canonical JSON)

### 3.1 Intent

```json
{
  "id": "intent-123",
  "principal": "did:aimtp:user.alice",
  "goal": "Summarize project risks",
  "created_at": "2026-02-09T00:00:00Z",
  "status": "submitted",
  "metadata": {
    "source": "cli"
  }
}
```

Rules:

- `id` MUST be unique within an inbox.
- `principal` MUST identify the submitting principal.
- `goal` MUST be a non-empty string.
- `status` MUST be one of: `submitted`, `planning`, `running`, `completed`, `failed`.

### 3.2 Task

```json
{
  "id": "task-123",
  "intent_id": "intent-123",
  "type": "classify",
  "input": {
    "goal": "Summarize project risks"
  },
  "status": "queued",
  "assigned_to": "did:aimtp:agent.worker-1",
  "created_at": "2026-02-09T00:00:05Z"
}
```

Rules:

- `intent_id` MUST reference an existing intent.
- `status` MUST be one of: `queued`, `claimed`, `completed`, `failed`.
- `assigned_to` MAY be omitted until claim.

### 3.2.1 Task State Transition Invariants

Allowed transitions:

| From | To | Requirement |
| --- | --- | --- |
| `queued` | `claimed` | MUST be allowed on valid claim |
| `claimed` | `completed` | MUST be allowed on valid result |
| `claimed` | `failed` | MUST be allowed on valid failure result |

Rules:

- `claimed -> queued` MUST NOT be allowed.
- `completed -> failed` and `failed -> completed` MUST NOT be allowed.
- In `enforce` mode, `task.result` submissions MUST be rejected when the task is not currently `claimed` by the submitting agent identity.

### 3.3 Result

```json
{
  "task_id": "task-123",
  "output": {
    "category": "analysis"
  },
  "status": "completed",
  "created_at": "2026-02-09T00:00:10Z"
}
```

Rules:

- `task_id` MUST reference an existing task.
- `status` MUST be `completed` or `failed`.

### 3.4 RunLog Event (append-only)

```json
{
  "id": "ev-001",
  "intent_id": "intent-123",
  "type": "task.claim",
  "created_at": "2026-02-09T00:00:08Z",
  "data": {
    "task_id": "task-123",
    "agent_id": "did:aimtp:agent.worker-1"
  }
}
```

Rules:

- RunLog events MUST be append-only.
- Implementations MUST NOT mutate or delete prior events in normal operation.
- Current intent/task status MAY be materialized state derived from the event stream.

## 4. Message Types over AIMTP Envelopes

IntentOS uses AIMTP envelope `intent` values:

- `intent.submit`
- `intent.status`
- `task.create`
- `task.claim`
- `task.result`
- `task.fail`

Rules:

- Payloads SHOULD include stable IDs (`intent_id`, `task_id`).
- Task lifecycle transitions MUST emit corresponding runlog events.
- `task.fail` SHOULD include a stable failure reason code.

## 5. Authorization Mapping (Phase 9)

Exact-match capability mapping for v0.1:

- action: `intent.submit`, resource: `intentbox:<box_id>`
- action: `task.claim`, resource: `task:<task_id>`
- action: `task.result`, resource: `task:<task_id>`

Rules:

- `box_id` identifies the target Intent Inbox namespace for `intent.submit`.
- When not explicitly provided, `box_id` MUST default to `default`.
- Future multi-tenant deployments MAY derive `box_id` from principal context, but v0.1 default behavior MUST remain `default`.
- Capability scope matching MUST be exact on both action and resource.
- Default mode SHOULD be `log`.
- Production deployments SHOULD use `enforce`.

## 6. Identity Requirements

- In `enforce` mode, submit/claim/result operations MUST include verifiable `identity` + `proof`.
- In `log` mode, operations MAY proceed without identity/proof, but present proofs SHOULD be verified and logged.
- For task operations, the acting identity subject MUST map to the claimed/executing agent principal.
- Capability final subject MUST match the acting identity subject for claim/result requests.

## 7. Storage Model (MVP)

- Intent Inbox MUST provide mailbox-like durable queue semantics per deployment.
- Redis or SQLite MAY be used; in-memory stores MAY be used for local/dev MVP.
- Writes MUST append a runlog event.
- `intent_id` and `task_id` MUST be idempotent keys.
- Submit operations SHOULD support client idempotency keys to avoid duplicate intents.

## 8. Security Considerations

- Replay: Proof and capability validity MUST be bounded by `expires_at` with bounded skew.
- Confused deputy: Implementations MUST enforce audience checks when capability constraints include `audience`.
- Least privilege: Capabilities SHOULD grant minimal scopes and short expiry.
- Logging: Structured logs MUST avoid full goal/payload content and SHOULD log IDs + reason codes only.

## 9. Conformance Vectors

IntentOS vectors are defined in `spec/vectors/intentos/`.

Minimum vector classes:

- valid intent submission
- valid task chain
- unauthorized task claim
- unauthorized task result
