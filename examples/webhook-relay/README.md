# Webhook Relay (Minimal)

This example runs a local HTTP relay that accepts AIMTP envelopes and routes them to a registered agent handler.

## Run
- `node examples/webhook-relay/demo.js`

## What It Does
- Starts a relay at `/inbox`.
- Registers `agent-b`.
- Sends a task request from `agent-a`.
- `agent-b` emits `running` and `succeeded` task responses; the relay returns them in the HTTP response.
