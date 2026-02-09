# AIMTP CLI Sender

Minimal Node 20+ CLI to send AIMTP v0.1 envelopes to a relay over HTTPS.

## Usage

```sh
node cli/aimtp-send.mjs \
  --url https://relay.aimtp.net/aimtp \
  --api-key <key> \
  --file cli/sample-envelope.json
```

### Flags

- `--url <url>` Relay URL (default: `https://relay.aimtp.net/aimtp`)
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
curl https://relay.aimtp.net/healthz
```

Send the sample envelope:
```sh
node cli/aimtp-send.mjs \
  --url https://relay.aimtp.net/aimtp \
  --file cli/sample-envelope.json
```

Send inline JSON:
```sh
node cli/aimtp-send.mjs \
  --url https://relay.aimtp.net/aimtp \
  --json '{"spec":"aimtp/0.1","message":{"id":"msg_1","role":"user","content":"hello"}}'
```
