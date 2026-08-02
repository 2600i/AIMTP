# AIMTP Python Client (Demo)

Cross-language interop demo. A Python client builds an AIMTP v0.1
`task.request` envelope, validates it against the local JSON Schemas, sends it
to the Node reference relay, **polls it back out of the mailbox**, and validates
the round-tripped envelope against the same schemas.

That round trip is the actual interop proof: an envelope constructed in Python
survives the Node relay unchanged and still validates.

## Requirements
- Python 3.x
- `jsonschema` (used for validation)

If `jsonschema` is missing, the client exits with install instructions.

## Usage
1. Install the validator:
   ```sh
   python3 -m pip install jsonschema referencing
   ```
2. Build the relay once, then run (the relay auto-starts):
   ```sh
   npm run build
   python3 examples/python-client/client.py
   ```

Expected output:
```
URL: http://localhost:8787/aimtp
Relay started: yes
request errors: []
acceptance errors: []
round-trip errors: []
ack: acknowledged
OK
```

## What it verifies

1. **Request validation** — the Python-built envelope validates against
   `schemas/envelope.schema.json` before it is sent.
2. **Acceptance** — `POST /aimtp` returns `202` with
   `{"status":"accepted","queued":true,"id":<envelope id>}`. This is an
   acceptance receipt, not a response envelope: the relay is an at-least-once
   queue, not request/response.
3. **Round trip** — `GET /aimtp/poll` returns the envelope plus a `lease_id`.
   The returned envelope is re-validated against the schemas and its `id` is
   compared to what was sent.
4. **Ack** — `POST /aimtp/ack` releases the lease so the queue drains.

## Overrides
- Different relay URL:
  `AIMTP_RELAY_URL=http://localhost:8787/aimtp python3 examples/python-client/client.py`
- Custom relay command:
  `AIMTP_RELAY_CMD="node dist/runtime/relay.js" python3 examples/python-client/client.py`
- Disable auto-start (relay must already be running):
  `python3 examples/python-client/client.py --start-relay=false`
- Use your own API key:
  `AIMTP_API_KEY=my-key python3 examples/python-client/client.py`
- Non-persistent queue (recommended for repeat runs):
  `AIMTP_STORE=memory python3 examples/python-client/client.py`

## Auth

The relay is **fail-closed**: with no `AIMTP_API_KEY` configured it rejects every
request with `401 unauthorized` rather than serving unauthenticated traffic.
This demo therefore defaults to `AIMTP_API_KEY=demo-key`, passing it both to the
relay it starts and in the `X-AIMTP-KEY` request header. Set `AIMTP_API_KEY`
yourself to override.

## Notes
- Schemas are loaded from `../../schemas/envelope.schema.json` and
  `../../schemas/message.schema.json`. Remote schema resolution is disabled;
  only local schemas are used.
- `Connection refused` means the relay is not running. Start it manually or
  point `AIMTP_RELAY_URL` at a reachable endpoint.
- The default `sqlite` store persists to `runtime/aimtp-mailbox.sqlite`, so
  queue depths accumulate across runs. Use `AIMTP_STORE=memory` for a clean
  queue each time.
- To validate the schemas themselves from Python, see
  [`tests/conformance/validate_schemas.py`](../../tests/conformance/README.md).
