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
chain-agnostic and does not mandate a specific blockchain. The relay validates
only the signature **shape** (`key_id`, `signature`, `alg`); any cryptographic
verification or key ownership checks are handled by your runtime or gateway.

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
  "message": { "id": "msg-1", "role": "user", "content": "ping" }
}
```

Response `202`:
```json
{ "status": "accepted", "id": "<envelope.id>", "recipient": "<recipient>", "queued": true, "queue_depth": 2 }
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

## Delivery Guarantees
- At-least-once delivery with explicit leasing
- Lease expiration triggers requeue with exponential backoff
- Max retry limit moves messages to the dead-letter queue

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

## Testing
```sh
npm test
```

## Troubleshooting
- **Redis connection errors**: verify `redis-cli`, host/port, credentials, and
  `AIMTP_REDIS_TIMEOUT_MS`.
- **Lease expired** (`409 lease_expired`): poll again and use the new lease id.
- **Unknown recipient** (`404 unknown_recipient`): check allowlists and spelling.
- **Unauthorized** (`401/403`): verify API keys and recipient key mapping.
- **Port in use**: set `PORT` to an available port.

## Error Responses
- `400` `invalid_schema`
- `400` `invalid_request`
- `400` `missing_recipient`
- `401` `unauthorized`
- `403` `forbidden`
- `403` `unknown_sender`
- `413` `payload_too_large`
- `404` `unknown_recipient`
- `404` `unknown_lease`
- `409` `lease_expired`
- `500` `internal_error`

## Logging
Structured log lines include an `auth` field with values `ok`, `missing`, or
`invalid`. Do not log secrets or message content.
