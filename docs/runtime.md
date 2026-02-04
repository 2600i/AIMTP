# Runtime & Relay (Internal)

## Webhook Relay Overview
The webhook relay is a minimal HTTP server that accepts AIMTP envelopes over POST
and routes them to registered agent handlers. It is transport-only and does not
change the AIMTP envelope format or validation rules.

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
- `AIMTP_API_KEY` (optional, unset by default; enables auth wrapper)
- `AIMTP_ALLOWED_RECIPIENTS` (optional, comma-separated allowlist)
- `AIMTP_ALLOWED_SENDERS` (optional, comma-separated allowlist)

## Auth Wrapper (Optional)
When `AIMTP_API_KEY` is set, all relay endpoints require a valid key except the
health endpoints listed below.

Accepted headers:
- `Authorization: Bearer <key>`
- `X-AIMTP-KEY: <key>`

Exempt endpoints:
- `GET /healthz`
- `GET /readyz` (if present)

## Health Endpoints
- `/healthz` is always unauthenticated.
- `/readyz` is always unauthenticated when implemented.

## Recipient & Sender Allowlists
When `AIMTP_ALLOWED_RECIPIENTS` is set to a non-empty list, incoming envelopes
must include `recipient` and it must appear in the allowlist or the relay
returns `404` with `code: unknown_recipient`. Missing recipients return `400`
with `code: invalid_request`.

When `AIMTP_ALLOWED_SENDERS` is set to a non-empty list, incoming envelopes
must include `sender` and it must appear in the allowlist or the relay returns
`403` with `code: unknown_sender`.

Example:
```sh
export AIMTP_ALLOWED_RECIPIENTS="agent-a,agent-b"
export AIMTP_ALLOWED_SENDERS="agent-a"
node dist/runtime/relay.js

curl -X POST http://localhost:8787/aimtp \\
  -H "Content-Type: application/json" \\
  -d '{\"spec\":\"aimtp/0.1\",\"id\":\"env-1\",\"timestamp\":\"2026-02-04T00:00:00Z\",\"sender\":\"agent-a\",\"recipient\":\"agent-b\",\"message\":{\"id\":\"msg-1\",\"role\":\"user\",\"content\":\"ping\"}}'
```

## Error Responses
- `400` `invalid_schema`
- `400` `invalid_request`
- `401` `unauthorized`
- `403` `forbidden`
- `403` `unknown_sender`
- `413` `payload_too_large`
- `404` `unknown_recipient`
- `500` `handler_error`

## Logging
Structured log lines include an `auth` field with values `disabled`, `ok`,
`missing`, or `invalid`. Do not log secrets or header values.
