# Webhook Relay (Concept)

This example documents a simple HTTP relay that accepts AIMTP envelopes and forwards them to a downstream consumer.

## Flow
- POST an AIMTP envelope to `/inbox`.
- Validate against `schemas/envelope.schema.json`.
- Forward the envelope to a configured downstream URL.
