# Runtime & Relay (Internal)

## Webhook Relay Overview
The webhook relay is a minimal HTTP server that accepts AIMTP envelopes over POST
and routes them to registered agent handlers. It is transport-only and does not
change the AIMTP envelope format or validation rules.

## Configuration
- `PORT` (default `8787`)
- `AIMTP_RELAY_PATH` (default `/aimtp`)
- `AIMTP_MAX_BODY_BYTES` (default `1048576`)
- `AIMTP_API_KEY` (optional, unset by default; enables auth wrapper)

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

## Error Responses
- `400` `invalid_schema`
- `401` `unauthorized`
- `403` `forbidden`
- `413` `payload_too_large`
- `500` `handler_error`

## Logging
Structured log lines include an `auth` field with values `disabled`, `ok`,
`missing`, or `invalid`. Do not log secrets or header values.
