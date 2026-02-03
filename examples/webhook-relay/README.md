# Webhook Relay (Minimal)

This example runs a local HTTP relay that accepts AIMTP envelopes and routes them to a registered agent handler.

## Run
- `node examples/webhook-relay/demo.js`

## Configuration (Env)
- `PORT` (default: `8787`)
- `AIMTP_RELAY_PATH` (default: `/aimtp`)
- `AIMTP_MAX_BODY_BYTES` (default: `1048576`)
- `AIMTP_API_KEY` (default: unset) enables shared API key auth for the relay endpoint.

## Auth (Optional)
When `AIMTP_API_KEY` is set, requests to the relay must include one of:
- `Authorization: Bearer <key>`
- `X-AIMTP-KEY: <key>`
`GET /healthz` and `GET /readyz` do not require authentication.

## Error Responses
- `400` `invalid_schema`
- `413` `payload_too_large`
- `500` `handler_error`

## What It Does
- Starts a relay at `/inbox`.
- Registers `agent-b`.
- Sends a task request from `agent-a`.
- `agent-b` emits `running` and `succeeded` task responses; the relay returns them in the HTTP response.
