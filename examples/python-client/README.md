# AIMTP Python Client (Demo)

This is a minimal Python interop demo that constructs an AIMTP v0.1 `task.request` envelope, validates it against the local schemas, POSTs it to the webhook relay, validates the response, and prints success.

## Requirements
- Python 3.x
- Optional but recommended: `jsonschema` (used for validation)

If `jsonschema` is missing, the client exits with install instructions.

## Usage
1. (Optional) install `jsonschema`:
   - `python3 -m pip install jsonschema referencing`
2. One-command run (auto-starts the relay):
   - `python3 examples/python-client/client.py`

### Overrides
- Use a different relay URL:
  - `AIMTP_RELAY_URL=http://localhost:8787/aimtp python3 examples/python-client/client.py`
- Use a custom relay command:
  - `AIMTP_RELAY_CMD=\"node dist/runtime/relay.js\" python3 examples/python-client/client.py`
  - The default relay command binds to `AIMTP_RELAY_URL`.
- Disable auto-start (relay must already be running):
  - `python3 examples/python-client/client.py --start-relay=false`

## Notes
- Schemas are loaded from `../../schemas/envelope.schema.json` and `../../schemas/message.schema.json`.
- Remote schema resolution is disabled; only local schemas are used.
- If you see `Connection refused`, the relay is not running. Start the relay manually or point `AIMTP_RELAY_URL` at a reachable endpoint.
- If your relay sets `AIMTP_API_KEY`, add `Authorization: Bearer <key>` or `X-AIMTP-KEY: <key>` to the
  request headers in `examples/python-client/client.py` (`_post_json`).
