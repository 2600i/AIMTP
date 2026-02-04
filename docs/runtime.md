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

## Recipient Allowlist & Admin Endpoints
When `AIMTP_ALLOWED_RECIPIENTS` is set to a non-empty list, incoming envelopes
must target a recipient in the allowlist or the relay returns `404` with
`code: unknown_recipient`. Sender allowlisting works the same way with
`AIMTP_ALLOWED_SENDERS` and returns `403` `unknown_sender`.

Admin endpoints (in-memory only) allow updating recipients at runtime:
- `GET /admin/recipients` → `{ recipients: [...] }`
- `POST /admin/recipients` with JSON `{ "recipient": "agent-b" }`
- `DELETE /admin/recipients?recipient=agent-b`
When `AIMTP_API_KEY` is set, these endpoints require the same auth header
as the relay path.

Example (with API key auth enabled):
```sh
curl -H "Authorization: Bearer $AIMTP_API_KEY" http://localhost:8787/admin/recipients

curl -X POST http://localhost:8787/admin/recipients \\
  -H "Authorization: Bearer $AIMTP_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{\"recipient\":\"agent-b\"}'

curl -X DELETE \"http://localhost:8787/admin/recipients?recipient=agent-b\" \\
  -H \"Authorization: Bearer $AIMTP_API_KEY\"
```

## Error Responses
- `400` `invalid_schema`
- `401` `unauthorized`
- `403` `forbidden`
- `403` `unknown_sender`
- `413` `payload_too_large`
- `404` `unknown_recipient`
- `500` `handler_error`

## Logging
Structured log lines include an `auth` field with values `disabled`, `ok`,
`missing`, or `invalid`. Do not log secrets or header values.
