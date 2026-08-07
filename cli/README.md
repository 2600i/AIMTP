# AIMTP Envelope Sender

Minimal Node 20+ CLI to validate and send AIMTP v0.1 envelopes to an HTTP
relay. It demonstrates one transport profile; it is not the Agent Trust Gateway
client and does not perform an authorization decision.

## Usage

```sh
node cli/aimtp-send.mjs \
  --url http://127.0.0.1:8787/aimtp \
  --api-key dev-key \
  --file cli/sample-envelope.json
```

### Flags

- `--url <url>` Relay URL. The CLI's historical default is
  `https://relay.aimtp.net/aimtp`; pass an explicit local or verified deployment
  URL because this repository does not assert hosted-service availability.
- `--api-key <key>` API key (sent as `Authorization: Bearer <key>`)
- `--file <path>` Envelope JSON file
- `--json <json>` Inline envelope JSON (quote in your shell)
- `--intent <intent>` Override `envelope.intent`
- `--sender <sender>` Override `envelope.sender`
- `--recipient <recipient>` Override `envelope.recipient`
- `--message <text>` Override `message.content` (string)

The CLI:
- Overwrites `timestamp` with a UTC RFC3339 string
- Generates UUIDs for missing `id` and `message.id`
- Validates the envelope locally against `schemas/*.schema.json`

## Examples

Health check:
```sh
curl http://127.0.0.1:8787/healthz
```

Send the sample envelope:
```sh
node cli/aimtp-send.mjs \
  --url http://127.0.0.1:8787/aimtp \
  --api-key dev-key \
  --file cli/sample-envelope.json
```

Send inline JSON:
```sh
node cli/aimtp-send.mjs \
  --url http://127.0.0.1:8787/aimtp \
  --api-key dev-key \
  --json '{"spec":"aimtp/0.1","message":{"id":"msg_1","role":"user","content":"hello"}}'
```
