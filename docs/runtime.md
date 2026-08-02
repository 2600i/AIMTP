# Runtime & Relay

## Overview
The relay is a minimal HTTP server that accepts AIMTP envelopes, validates them
against the JSON Schemas, and enqueues them into a mailbox store per recipient.
Recipients poll leased messages and must explicitly acknowledge or fail them.

Delivery is **at-least-once**. Messages are leased on poll, retried with
exponential backoff, and dead-lettered after the configured retry limit.

## Run
```sh
npm run build
node dist/runtime/relay.js
```

## Configuration
- `PORT` (default `8787`)
- `AIMTP_BIND_HOST` (default: all interfaces; set `127.0.0.1` to bind loopback only)
- `AIMTP_RELAY_PATH` (default `/aimtp`)
- `AIMTP_MAX_BODY_BYTES` (default `1048576`)
- `AIMTP_API_KEY` (shared admin key)
- `AIMTP_RECIPIENT_KEYS` (per-recipient keys: `agent-a:key-a,agent-b:key-b`)
- `AIMTP_KEY_RECIPIENTS` (per-recipient keys: `key-a=agent-a,agent-b;key-b=agent-c`)
- `AIMTP_ALLOWED_RECIPIENTS` (comma-separated allowlist)
- `AIMTP_ALLOWLIST_RECIPIENTS=0` (disable recipient allowlist even if set)
- `AIMTP_ALLOWED_SENDERS` (comma-separated allowlist)
- `AIMTP_STORE` (`sqlite` default, `redis` optional)
- `AIMTP_MAILBOX_STORE` (legacy alias; still accepted)
- `AIMTP_MAILBOX_SQLITE_PATH` (default `runtime/aimtp-mailbox.sqlite`)
- `AIMTP_MAILBOX_TTL_MS` (default `600000`)
- `AIMTP_MAILBOX_MAX_QUEUE_LENGTH` (default `100`)
- `AIMTP_MAILBOX_MAX_RECIPIENTS` (default `1000`)
- `AIMTP_MAILBOX_CLEANUP_INTERVAL_MS` (optional periodic cleanup job)
- `AIMTP_MAILBOX_LEASE_MS` (default `30000`)
- `AIMTP_MAILBOX_MAX_RETRIES` (default `5`)
- `AIMTP_MAILBOX_RETRY_BASE_MS` (default `1000`)
- `AIMTP_MAILBOX_RETRY_MAX_MS` (default `30000`)
- `AIMTP_REDIS_URL` (optional Redis URL)
- `AIMTP_REDIS_HOST` / `AIMTP_REDIS_PORT` / `AIMTP_REDIS_DB` (optional Redis settings)
- `AIMTP_REDIS_USERNAME` / `AIMTP_REDIS_PASSWORD` (optional Redis auth)
- `AIMTP_REDIS_KEY_PREFIX` (default `aimtp:mailbox:`)
- `AIMTP_REDIS_CLI_PATH` (default `redis-cli`)
- `AIMTP_REDIS_TIMEOUT_MS` (default `1000`)
- `AIMTP_RELAY_INSTANCE_ID` (optional stable relay instance id for logs/locks)
- `AIMTP_REDIS_LOCK_TTL_MS` (default `10000`)
- `AIMTP_REDIS_LOCK_ACQUIRE_TIMEOUT_MS` (default `5000`)
- `AIMTP_REDIS_LOCK_RETRY_DELAY_MS` (default `20`)
- `AIMTP_REDIS_LEASE_RESULT_TTL_MS` (default `300000`)
- `AIMTP_SIGNATURE_POLICY` (`off` default, `warn`, or `enforce`)
- `AIMTP_TRUSTED_KEYS` (comma-separated `kid=public_key`)
- `AIMTP_TRUSTED_KEYS_FILE` (optional file with trusted key entries)
- `AIMTP_SIGNATURE_CLOCK_SKEW_SEC` (default `0`)
- `AIMTP_LOG_SUMMARY_INTERVAL_MS` (optional periodic log summary interval)
- `INTENTOS` (`on` enables the IntentOS endpoints and UI; off by default)
- `AIMTP_INTENTOS_SQLITE_PATH` (default `runtime/aimtp-intentos.sqlite`)
- `AIMTP_INTENTOS_MAX_INTENTS` (default `500`)

### Recommended Redis Coordination Defaults
| Variable | Recommended default | Notes |
| --- | ---: | --- |
| `AIMTP_REDIS_LOCK_TTL_MS` | `10000` | Lease time for per-recipient lock ownership. |
| `AIMTP_REDIS_LOCK_ACQUIRE_TIMEOUT_MS` | `5000` | Max wait to acquire recipient lock before returning error. |
| `AIMTP_REDIS_LOCK_RETRY_DELAY_MS` | `20` | Sleep between lock acquire attempts. |
| `AIMTP_REDIS_LEASE_RESULT_TTL_MS` | `300000` | TTL for cached idempotent `ack`/`fail` lease results. |

## Authentication and Signatures
Auth is required for all mailbox endpoints:
- `POST /aimtp`
- `POST /aimtp/mailbox`
- `GET /aimtp/peek`
- `GET /aimtp/poll`
- `POST /aimtp/ack`
- `POST /aimtp/fail`
- `GET /aimtp/dead`

Accepted headers:
- `Authorization: Bearer <key>`
- `X-AIMTP-KEY: <key>`

AIMTP envelopes may include an optional `signature` object. The protocol is
chain-agnostic and does not mandate a specific blockchain.

Supported signature fields:
- `alg`, `kid`, `sig`, optional `created_at`, optional `expires_at`
- Backward-compatible aliases: `key_id` for `kid`, `signature` for `sig`
- Trusted key values are loaded from `AIMTP_TRUSTED_KEYS` / `AIMTP_TRUSTED_KEYS_FILE`
  and may be PEM public keys or base64/hex SPKI DER bytes.

Canonical signing payload:
- top-level `signature` removed from envelope
- stable JSON key ordering (lexicographic at every object level)
- array order preserved
- UTF-8 bytes, no extra whitespace

Verification policy behavior:
- `off`: no signature verification.
- `warn`: verify and log failures, still accept envelope.
- `enforce`: reject envelope on missing/invalid/untrusted/expired signature.

Exempt endpoints:
- `GET /healthz`
- `GET /readyz` (if enabled)

Unauthorized recipient access returns `403`.

## API Endpoints

### `GET /healthz`
Returns basic health information.

Response `200`:
```json
{ "status": "ok", "service": "aimtp-relay", "version": "<version>", "uptime_sec": 123, "timestamp": "2026-02-05T00:00:00Z" }
```

### `GET /readyz`
Returns readiness if enabled via `AIMTP_READY_PATH`.

Response `200`:
```json
{ "status": "ready" }
```

### `POST /aimtp`
Enqueues a validated AIMTP envelope.

Request:
```json
{
  "spec": "aimtp/0.1",
  "id": "env-1",
  "timestamp": "2026-02-05T00:00:00Z",
  "sender": "agent-a",
  "recipient": "agent-b",
  "message": { "id": "msg-1", "role": "user", "content": "ping" },
  "signature": {
    "alg": "ed25519",
    "kid": "agent-a-key-1",
    "sig": "<base64-signature>",
    "created_at": "2026-02-06T00:00:00Z",
    "expires_at": "2026-02-06T00:05:00Z"
  }
}
```

Response `202`:
```json
{ "status": "accepted", "id": "<envelope.id>", "recipient": "<recipient>", "queued": true, "queue_depth": 2 }
```

Example (`warn` policy, request accepted even if signature fails verification):
```sh
curl -X POST "http://127.0.0.1:8787/aimtp" \
  -H "Content-Type: application/json" \
  -H "X-AIMTP-KEY: dev-key" \
  -d '{"spec":"aimtp/0.1","id":"env-1","timestamp":"2026-02-06T00:00:00Z","sender":"agent-a","recipient":"agent-b","message":{"id":"msg-1","role":"user","content":"ping"},"signature":{"alg":"ed25519","kid":"agent-a-key-1","sig":"<base64-signature>"}}'
```

### `POST /aimtp/mailbox`
Enqueues a raw message payload without schema validation. This is intended for
lightweight mailbox usage.

Request:
```json
{ "recipient": "agent-b", "message": { "text": "ping" } }
```

Response `200`:
```json
{ "ok": true, "recipient": "agent-b", "id": "<message.id?>" }
```

### `GET /aimtp/peek?recipient=<id>`
Returns queue depth without removing messages.

Parameters:
- `recipient` (required)

Response `200`:
```json
{ "recipient": "agent-b", "count": 2, "pending": 1, "leased": 1, "dead_letters": 0 }
```

### `GET /aimtp/poll?recipient=<id>&max=<n>`
Returns up to `max` leased envelopes (default `1`, cap `50`). The lease must be
acknowledged or failed. When empty, returns `200 []`.

Parameters:
- `recipient` (required)
- `max` (optional, default `1`, max `50`)

Response `200`:
```json
[
  {
    "envelope": { "id": "env-001", "spec": "aimtp/0.1", "timestamp": "2026-02-05T00:00:00Z", "message": { "id": "msg-1", "role": "user", "content": "ping" } },
    "lease_id": "lease-123",
    "lease_expires_at": "2026-02-05T00:00:30Z",
    "retry_count": 0,
    "delivery_attempt": 1
  }
]
```
`retry_count` counts prior failed attempts. `delivery_attempt` is 1-based.

### `POST /aimtp/ack`
Acknowledges a leased message and removes it from the queue.

Request:
```json
{ "recipient": "agent-b", "lease_id": "lease-123" }
```

Response `200`:
```json
{ "ok": true, "status": "acknowledged" }
```

### `POST /aimtp/fail`
Marks a leased message as failed. The relay will requeue it with backoff or
move it to the dead-letter queue if retries are exhausted.

Request:
```json
{ "recipient": "agent-b", "lease_id": "lease-123", "reason": "processing_error" }
```

Response `200`:
```json
{ "ok": true, "status": "requeued", "retry_count": 1 }
```

### `GET /aimtp/dead?recipient=<id>&max=<n>`
Returns up to `max` dead-lettered items (default `1`, cap `50`) and removes them
from the dead-letter queue.

Parameters:
- `recipient` (required)
- `max` (optional, default `1`, max `50`)

Response `200`:
```json
[
  {
    "envelope": { "id": "env-001", "spec": "aimtp/0.1", "timestamp": "2026-02-05T00:00:00Z", "message": { "id": "msg-1", "role": "user", "content": "ping" } },
    "enqueued_at": "2026-02-05T00:00:00Z",
    "failed_at": "2026-02-05T00:02:00Z",
    "retry_count": 5,
    "delivery_attempt": 6,
    "last_error": "processing_error"
  }
]
```

## IntentOS

Opt-in and off by default. Set `INTENTOS=on` to enable a read-only projection of
relay traffic plus a browser UI. Nothing here changes delivery: the projection is
written after an envelope is accepted, and a projection failure is logged as
`intentos_record_failed` and never fails the request.

With `INTENTOS` unset, every path below returns `404`.

### The projection

Envelopes carry `intent` as a label, not an identifier, so intents are keyed by
thread: `metadata.aimtp.thread_id` when present, and the envelope `id` otherwise.
A request and its response therefore collapse onto **one** intent, and the
response advances that intent's status rather than creating a second one.

| Source | Becomes |
| --- | --- |
| `metadata.aimtp.thread_id`, else envelope `id` | intent id |
| `message.content` | intent `goal` (first envelope wins; truncated at 500 chars) |
| `task.status`, else `in_progress` for a request, else `received` | intent `status` |
| each accepted envelope | one entry in the intent's event log |
| `task.in_response_to`, else `task.id` | task id — a response collapses onto the task it answers |

A task row keeps the `type` it was created with and only its `status` advances,
so a completed request reads `type: request`, `status: succeeded`.

Payloads with no usable id — raw `POST /aimtp/mailbox` bodies, for instance — are
skipped rather than creating phantom intents. Only `POST /aimtp` feeds the
projection.

### Storage

The backend follows `AIMTP_STORE`: `sqlite` (default) persists to
`AIMTP_INTENTOS_SQLITE_PATH` and survives restarts; `memory` resets on restart.
`redis` maps to the in-memory store rather than adding a second remote
dependency for a read-only view. Intents prune oldest-first past
`AIMTP_INTENTOS_MAX_INTENTS`, and each intent retains its most recent 100 events.

### Authentication

All three endpoints below require `X-AIMTP-KEY` exactly like the mailbox
endpoints — `401 unauthorized` when absent, `403 forbidden` when wrong. When
capabilities are enforced (`AIMTP_CAPABILITIES=on` with both `INTENTOS_MODE` and
`AIMTP_CAP_MODE` set to `enforce`), a valid `X-AIMTP-Capability` is required as
well; capability enforcement is an additional, narrower gate, not a replacement
for the API key.

The UI assets themselves are served unauthenticated — they contain no data.

### `GET /aimtp/intentos/intents`
Parameters:
- `limit` (optional, default `100`)

Response `200`:
```json
{
  "intents": [
    {
      "id": "task-task-001",
      "status": "succeeded",
      "goal": "Summarize the Q3 pipeline",
      "sender": "agent-a",
      "recipient": "agent-b",
      "created_at": "2026-08-02T12:30:00.000Z",
      "updated_at": "2026-08-02T12:31:00.000Z"
    }
  ]
}
```

### `GET /aimtp/intentos/tasks`
Parameters:
- `limit` (optional, default `100`)

Response `200`:
```json
{
  "tasks": [
    {
      "id": "task-001",
      "intent_id": "task-task-001",
      "type": "request",
      "status": "succeeded",
      "assigned_to": "agent-b",
      "created_at": "2026-08-02T12:30:00.000Z",
      "updated_at": "2026-08-02T12:31:00.000Z"
    }
  ]
}
```

### `GET /aimtp/intentos/intent/<intent-id>`
Returns one intent with its ordered event log. `404 not_found` for an unknown id.

Response `200`:
```json
{
  "intent": {
    "id": "task-task-001",
    "status": "succeeded",
    "goal": "Summarize the Q3 pipeline",
    "sender": "agent-a",
    "recipient": "agent-b",
    "created_at": "2026-08-02T12:30:00.000Z",
    "updated_at": "2026-08-02T12:31:00.000Z"
  },
  "events": [
    {
      "intent_id": "task-task-001",
      "seq": 1,
      "type": "task.request",
      "status": "",
      "message": "Summarize the Q3 pipeline",
      "envelope_id": "env-req-1",
      "created_at": "2026-08-02T12:30:00.000Z"
    },
    {
      "intent_id": "task-task-001",
      "seq": 2,
      "type": "task.response",
      "status": "succeeded",
      "message": "Pipeline summary ready",
      "envelope_id": "env-resp-1",
      "created_at": "2026-08-02T12:31:00.000Z"
    }
  ]
}
```

### UI

Served at `<relay-path>/intentos/ui` (for the default relay path,
`http://127.0.0.1:8787/aimtp/intentos/ui`). The **Access** panel takes the relay
API key and sends it as `X-AIMTP-KEY`; it is held in `sessionStorage`, so it
survives a reload and dies with the tab. The **Capability** panel below it takes
capability JSON for enforce mode. Without a key the panels stay empty and report
`Relay requires an API key`.

Because the key lives in the browser, treat this UI as a localhost/operator tool.
Exposing it beyond a trusted network means handing an admin key to a browser
context; use a scoped capability instead.

## Delivery Guarantees
- At-least-once delivery with explicit leasing
- Lease expiration triggers requeue with exponential backoff
- Max retry limit moves messages to the dead-letter queue

## Multi-Relay Semantics
- Redis-backed mailbox operations are coordinated with per-recipient distributed locks.
- `poll`, `ack`, `fail`, `peek`, and dead-letter reads are serialized per recipient across relay instances.
- Duplicate `ack` and `fail` requests for the same lease id are idempotent for a short TTL window.
- Lease ownership is global to Redis state, so a lease polled by relay A can be acknowledged or failed by relay B.
- Lock acquisition timeout returns an internal error; tune lock env vars for high-contention recipients.

## Mailbox Limits
- TTL: `10 minutes`. Expired messages are dropped on enqueue + peek/poll
- Max queue length per recipient: `100` (oldest dropped first)
- Max recipients tracked: `1000` (least-recently-active recipients evicted)
- Default storage is SQLite; mailbox contents survive process restarts
- Redis-backed storage is available via `AIMTP_STORE=redis`

SQLite schema is defined in `docs/mailbox-sqlite-schema.sql`.

## Scaling Guidance
- Use Redis-backed storage when running multiple relay instances.
- Use `AIMTP_REDIS_KEY_PREFIX` to shard mailboxes across Redis databases.
- Place relays behind a load balancer and keep key routing consistent.
- If you need cross-process notifications, integrate Redis Pub/Sub or streams
  externally. The relay does not require Pub/Sub to function.
- Assign `AIMTP_RELAY_INSTANCE_ID` per instance (or rely on default `relay-<pid>`) for operational traceability.

## Testing
```sh
npm test
```

## Troubleshooting
- **Redis connection errors**: verify `redis-cli`, host/port, credentials, and
  `AIMTP_REDIS_TIMEOUT_MS`.
- **Redis lock timeout** (`500 internal_error`): increase `AIMTP_REDIS_LOCK_TTL_MS`
  or `AIMTP_REDIS_LOCK_ACQUIRE_TIMEOUT_MS` for busy recipients.
- **Lease expired** (`409 lease_expired`): poll again and use the new lease id.
- **Unknown recipient** (`404 unknown_recipient`): check allowlists and spelling.
- **Unauthorized** (`401/403`): verify API keys and recipient key mapping.
- **Signature rejected**: verify `AIMTP_SIGNATURE_POLICY`, trusted key source,
  canonical payload consistency, and envelope `signature` fields.
- **Port in use**: set `PORT` to an available port.

## Error Responses
- `400` `invalid_schema`
- `400` `invalid_request`
- `400` `missing_recipient`
- `400` `signature_invalid`
- `400` `signature_unsupported_alg`
- `401` `unauthorized`
- `401` `signature_required`
- `401` `signature_expired`
- `401` `signature_not_yet_valid`
- `403` `forbidden`
- `403` `unknown_sender`
- `403` `signature_untrusted_key`
- `403` `signature_verification_failed`
- `500` `signature_key_error`
- `413` `payload_too_large`
- `404` `unknown_recipient`
- `404` `unknown_lease`
- `409` `lease_expired`
- `500` `internal_error`

## Logging
Structured log lines include an `auth` field with values `ok`, `missing`, or
`invalid`. Do not log secrets or message content.
