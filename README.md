# AIMTP — Agentic Intelligent Message Transfer Protocol

**Status:** v0.1 candidate — protocol surface frozen except for errata

AIMTP is a **schema-first, transport-agnostic** protocol for structured
agent-to-agent message and task exchange. It defines **what is sent and why**,
not **how it is transported**. Implementations can pick their own transports
(HTTP, queues, files, etc.) while sharing a consistent envelope, message model,
and task semantics.

**Goals**
- Protocol stability with explicit versioning
- Clear JSON Schemas for validation
- Minimal, auditable surface area
- Interop across runtimes and teams
- Extensible metadata without breaking changes

## Getting Started

**Prerequisites**
- Node.js and npm

**Install dependencies**
```sh
npm ci
```

**Build**
```sh
npm run build
```

**Run the relay**
```sh
AIMTP_API_KEY=dev-key node dist/runtime/relay.js
```

## Usage Examples

**Send a validated AIMTP envelope** (`POST /aimtp`)
```sh
curl -X POST "http://127.0.0.1:8787/aimtp" \
  -H "Content-Type: application/json" \
  -H "X-AIMTP-KEY: dev-key" \
  -d '{"spec":"aimtp/0.1","id":"env-1","timestamp":"2026-02-05T00:00:00Z","sender":"agent-a","recipient":"agent-b","message":{"id":"msg-1","role":"user","content":"ping"}}'
```

**Send a raw mailbox message** (`POST /aimtp/mailbox`)
```sh
curl -X POST "http://127.0.0.1:8787/aimtp/mailbox" \
  -H "Content-Type: application/json" \
  -H "X-AIMTP-KEY: dev-key" \
  -d '{"recipient":"agent-b","message":{"text":"ping"}}'
```

**Peek queue depth** (`GET /aimtp/peek`)
```sh
curl "http://127.0.0.1:8787/aimtp/peek?recipient=agent-b" \
  -H "X-AIMTP-KEY: dev-key"
```

**Poll for leased messages** (`GET /aimtp/poll`)
```sh
curl "http://127.0.0.1:8787/aimtp/poll?recipient=agent-b&max=1" \
  -H "X-AIMTP-KEY: dev-key"
```

**Acknowledge a lease** (`POST /aimtp/ack`)
```sh
curl -X POST "http://127.0.0.1:8787/aimtp/ack" \
  -H "Content-Type: application/json" \
  -H "X-AIMTP-KEY: dev-key" \
  -d '{"recipient":"agent-b","lease_id":"<lease-id>"}'
```

**Fail a lease (retry or dead-letter)** (`POST /aimtp/fail`)
```sh
curl -X POST "http://127.0.0.1:8787/aimtp/fail" \
  -H "Content-Type: application/json" \
  -H "X-AIMTP-KEY: dev-key" \
  -d '{"recipient":"agent-b","lease_id":"<lease-id>","reason":"processing_error"}'
```

**Read dead-letter items** (`GET /aimtp/dead`)
```sh
curl "http://127.0.0.1:8787/aimtp/dead?recipient=agent-b&max=1" \
  -H "X-AIMTP-KEY: dev-key"
```

For full request/response schemas and error codes, see
`/Users/solo446/Documents/AIMTP/docs/runtime.md`.

## Documentation
- Runtime + API reference: `/Users/solo446/Documents/AIMTP/docs/runtime.md`
- System architecture: `/Users/solo446/Documents/AIMTP/docs/architecture.md`
- Security model: `/Users/solo446/Documents/AIMTP/docs/security.md`
- Protocol spec: `/Users/solo446/Documents/AIMTP/spec/aimtp-v0.1.md`

## Operations
For deployment, environment configuration, and recovery guidance, see
`/Users/solo446/Documents/AIMTP/docs/operations.md`.

## Authentication and Signatures

AIMTP envelopes can include an optional `signature` object with
`alg`, `kid`, and `sig` fields (optional `created_at`, `expires_at`). Backward-
compatible aliases `key_id` and `signature` are also accepted. The protocol is
chain-agnostic and does not mandate a specific blockchain. Signature validation
behavior is runtime policy-driven (`off`, `warn`, `enforce`).

## Capability Enforce Mode (Dev)

1. Enable capability checks in your relay environment:
   `AIMTP_CAPABILITIES=on` and `AIMTP_CAP_MODE=enforce`.
2. Set signing keys in env vars:
   `AIMTP_CAP_PRIVATE_KEY` and `AIMTP_CAP_PUBLIC_KEY`.
3. Mint a capability with exact audience including base path:
   `node tools/aimtp-cap.mjs mint --issuer orchestrator.local --subject agent.demo --aud http://localhost:8787/aimtp --actions intentos.read --resources intentos:intents --out /tmp/agent-cap.json`.
4. Run `node tools/aimtp-cap.mjs verify --file /tmp/agent-cap.json --aud http://localhost:8787/aimtp`.
5. Attach the capability presentation to runtime requests.
6. JSON embedding option: include the presentation in request envelope metadata.
7. Header helper option: use `--as-header` to print `X-AIMTP-CAPABILITY: <base64>`.
8. Repeat minting for orchestrator, agent, and optional read-only viewer roles.
9. Keep capabilities short-lived (15–60 minutes) and exact-scope only.
10. Open IntentOS UI at `/aimtp/intentos/ui` and validate read-only behavior.
11. In enforce mode, the UI requires a capability loaded into the "IntentOS Capability (JSON)" box.
12. Minimal mint command for UI reads:
    `node tools/aimtp-cap.mjs mint --issuer local-admin --subject demo-ui --aud http://localhost:8787/aimtp --ttl 900 --actions intentos.read --resources intentos:intents,intentos:tasks --out /tmp/demo-ui-cap.json`.
13. Paste the JSON from `/tmp/demo-ui-cap.json` into the UI and click `Load Capability`.

## System Architecture

AIMTP separates protocol semantics from transport. The reference relay accepts
HTTP requests, validates envelopes, and stores messages in a mailbox backend.
Recipients poll and lease messages, then acknowledge or fail them.

See `/Users/solo446/Documents/AIMTP/docs/architecture.md` for a detailed flow,
store choices, and scaling guidance.

## Testing

```sh
npm test
```

## Troubleshooting

Common issues and fixes are documented in
`/Users/solo446/Documents/AIMTP/docs/runtime.md`.

## Contributing

We welcome issues and pull requests.
- Open an issue with a clear description and reproduction steps.
- Keep changes focused and update both `spec/` and `schemas/` together.
- Run `npm test` and include new tests or vectors when behavior changes.
- Use a feature branch and small, reviewable commits.

## Examples
- `examples/python-client/` — Python interop demo (validates schemas + calls relay)
- `examples/web-inbox/` — Browser demo (send + mailbox peek/poll)
- `examples/reference-agents/` — Router + executor reference agents with local negotiation/execution demo (`node examples/reference-agents/demo.js`)

## License
See `/Users/solo446/Documents/AIMTP/LICENSE`.
