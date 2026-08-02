# Webhook Relay (Minimal)

A local HTTP relay that validates AIMTP envelopes and delivers them through a
recipient mailbox with at-least-once semantics.

## Run
```sh
node examples/webhook-relay/demo.js
```

Runs standalone with no setup. Output is deterministic across runs.

## What It Does

Walks the full delivery lifecycle against a real relay:

1. **SEND** — POST a validated envelope to `/inbox` → `202 accepted` with queue depth.
2. **PEEK** — `GET /inbox/peek?recipient=agent-b` → queue depth without consuming.
3. **POLL** — `GET /inbox/poll?recipient=agent-b&max=1` → the envelope plus a
   `lease_id` and `lease_expires_at`.
4. **ACK** — `POST /inbox/ack` with the `lease_id` → removes it from the queue.
5. **PEEK** — queue is drained (`count: 0`).
6. **SEND (invalid)** — a malformed envelope is rejected `400 invalid_schema`
   and never enters the mailbox.

## Delivery model

This is **at-least-once queue delivery, not request/response**. `POST /inbox`
returns `202` as soon as the envelope is validated and enqueued; it does not
wait for the recipient and does not return the recipient's reply. If a lease
expires without an ack, the message is redelivered, and after `max_retries` it
moves to the dead-letter queue (`GET /inbox/dead`).

For **in-process handler dispatch** — where a registered agent receives the
envelope and emits task responses synchronously — use `relay.receive()` instead
of the HTTP server. See [`examples/reference-agents/`](../reference-agents/).
Registering an agent handler does not affect the HTTP path.

## Configuration (Env)
- `AIMTP_RELAY_PATH` (default: `/aimtp`) — this demo overrides it to `/inbox`
  via the `path` option.
- `AIMTP_MAX_BODY_BYTES` (default: `1048576`)
- `AIMTP_API_KEY` — the relay API key. See Auth below.
- `AIMTP_STORE` (default: `sqlite`) — this demo sets `memory` so repeated runs
  start from an empty queue.

## Auth

The relay is **fail-closed**. If `AIMTP_API_KEY` is not set, the relay rejects
every request with `401 unauthorized` rather than serving unauthenticated
traffic. This demo therefore sets `AIMTP_API_KEY=demo-key` for you unless you
supply your own.

When set, requests must include one of:
- `Authorization: Bearer <key>`
- `X-AIMTP-KEY: <key>`

`GET /healthz` and `GET /readyz` never require authentication.

## Error Responses
- `400` `invalid_schema` — envelope failed schema validation
- `400` `invalid_request` — malformed recipient
- `401` `unauthorized` — missing API key
- `403` `forbidden` — invalid API key, or recipient not permitted for that key
- `404` `unknown_recipient` — recipient not in `AIMTP_ALLOWED_RECIPIENTS`
- `413` `payload_too_large`
- `500` `handler_error`
