# Runtime & Relay (Internal)

## Mailbox Relay Overview
The relay is a minimal HTTP server that accepts AIMTP envelopes over POST,
validates them, and enqueues them into a mailbox store per recipient.
Recipients fetch messages via polling endpoints. The relay does not modify
AIMTP envelopes or validation rules.

## Run
Build first, then run:
```sh
npm run build
node dist/runtime/relay.js
```

## Configuration
- `PORT` (default `8787`)
- `AIMTP_RELAY_PATH` (default `/aimtp`)
- `AIMTP_MAX_BODY_BYTES` (default `1048576`)
- `AIMTP_API_KEY` (required for mailbox endpoints; shared admin key)
- `AIMTP_RECIPIENT_KEYS` (optional per-recipient keys: `agent-a:key-a,agent-b:key-b`)
- `AIMTP_KEY_RECIPIENTS` (optional per-recipient keys: `key-a=agent-a,agent-b;key-b=agent-c`)
- `AIMTP_ALLOWED_RECIPIENTS` (optional, comma-separated allowlist)
- `AIMTP_ALLOWLIST_RECIPIENTS=0` (disable recipient allowlist even if set)
- `AIMTP_ALLOWED_SENDERS` (optional, comma-separated allowlist)
- `AIMTP_STORE` (`sqlite` default, `redis` optional)
- `AIMTP_MAILBOX_STORE` (legacy alias; still accepted)
- `AIMTP_MAILBOX_SQLITE_PATH` (default `runtime/aimtp-mailbox.sqlite`)
- `AIMTP_MAILBOX_TTL_MS` (optional, defaults to `600000`)
- `AIMTP_MAILBOX_MAX_QUEUE_LENGTH` (optional, defaults to `100`)
- `AIMTP_MAILBOX_MAX_RECIPIENTS` (optional, defaults to `1000`)
- `AIMTP_MAILBOX_CLEANUP_INTERVAL_MS` (optional periodic TTL cleanup job; disabled when unset)
- `AIMTP_REDIS_URL` (optional Redis URL)
- `AIMTP_REDIS_HOST` / `AIMTP_REDIS_PORT` / `AIMTP_REDIS_DB` (optional discrete Redis settings)
- `AIMTP_REDIS_USERNAME` / `AIMTP_REDIS_PASSWORD` (optional Redis auth)
- `AIMTP_REDIS_KEY_PREFIX` (optional key prefix; default `aimtp:mailbox:`)
- `AIMTP_REDIS_CLI_PATH` (optional redis-cli path; default `redis-cli`)
- `AIMTP_REDIS_TIMEOUT_MS` (optional redis command timeout; default `1000`)

## Auth & Recipient Isolation
Auth is required for:
- `POST /aimtp`
- `GET /aimtp/peek`
- `GET /aimtp/poll`

Accepted headers:
- `Authorization: Bearer <key>`
- `X-AIMTP-KEY: <key>`

Key modes:
- `AIMTP_API_KEY` acts as a shared admin key (full access to all recipients).
- `AIMTP_RECIPIENT_KEYS` enables per-recipient isolation. Keys are only allowed
  to access the recipients they are mapped to.
- `AIMTP_KEY_RECIPIENTS` uses the format `key=recipient1,recipient2;key2=x,y`.
- If both are set, the admin key can access all recipients; recipient keys
  remain scoped.

Exempt endpoints:
- `GET /healthz`
- `GET /readyz` (if present)

Unauthorized recipient access returns `403`.

## Mailbox Endpoints
### `POST /aimtp`
Enqueues a validated envelope.

Response `202`:
```json
{ "status": "accepted", "id": "<envelope.id>", "recipient": "<recipient>", "queued": true, "queue_depth": 2 }
```

### `GET /aimtp/peek?recipient=<id>`
Returns queue depth without removing messages.

Response `200`:
```json
{ "recipient": "agent-b", "count": 2 }
```

### `GET /aimtp/poll?recipient=<id>&max=<n>`
Returns up to `max` envelopes (default `1`, cap `50`) and removes them from the
queue (FIFO). When empty, returns `200 []`.

## Mailbox Limits
- TTL: `10 minutes`. Expired messages are dropped on enqueue + peek/poll.
- Max queue length per recipient: `100`. If exceeded, oldest messages are
  dropped first and a single-line metric is logged:
  `mailbox_drop_oldest recipient=<id> dropped=<k> queue_depth=<n>`
- Max recipients tracked: `1000`. Least-recently-active recipients are evicted
  if the limit is exceeded.
- Default storage is SQLite, so mailbox contents survive process restarts.
- Set `AIMTP_STORE=redis` to use Redis-backed mailbox lists.
- If Redis is unavailable, relay gracefully falls back to SQLite and logs:
  `mailbox_store_fallback from=redis to=sqlite reason=<...>`.
- Optional cleanup job: set `AIMTP_MAILBOX_CLEANUP_INTERVAL_MS` to run periodic
  expiry cleanup in the background.

SQLite schema is defined in `docs/mailbox-sqlite-schema.sql`.

## Recipient & Sender Allowlists
When `AIMTP_ALLOWED_RECIPIENTS` is set to a non-empty list, incoming envelopes
must include `recipient` and it must appear in the allowlist or the relay
returns `404` with `code: unknown_recipient`.

When `AIMTP_ALLOWED_SENDERS` is set to a non-empty list, incoming envelopes
must include `sender` and it must appear in the allowlist or the relay returns
`403` with `code: unknown_sender`.

Example:
```sh
export AIMTP_API_KEY="shared-admin-key"
export AIMTP_ALLOWED_RECIPIENTS="agent-a,agent-b"
export AIMTP_ALLOWED_SENDERS="agent-a"
node dist/runtime/relay.js

curl -X POST http://localhost:8787/aimtp \
  -H "Content-Type: application/json" \
  -H "X-AIMTP-KEY: shared-admin-key" \
  -d '{"spec":"aimtp/0.1","id":"env-1","timestamp":"2026-02-04T00:00:00Z","sender":"agent-a","recipient":"agent-b","message":{"id":"msg-1","role":"user","content":"ping"}}'

curl "http://localhost:8787/aimtp/peek?recipient=agent-b" \
  -H "X-AIMTP-KEY: shared-admin-key"

curl "http://localhost:8787/aimtp/poll?recipient=agent-b&max=5" \
  -H "X-AIMTP-KEY: shared-admin-key"
```

## Error Responses
- `400` `invalid_schema`
- `400` `invalid_request`
- `400` `missing_recipient`
- `401` `unauthorized`
- `403` `forbidden`
- `403` `unknown_sender`
- `413` `payload_too_large`
- `404` `unknown_recipient`
- `500` `internal_error`

## Logging
Structured log lines include an `auth` field with values `ok`, `missing`, or
`invalid`. Do not log secrets or message content.
