# AIMTP — Agentic Intelligent Message Transfer Protocol

**Wire version:** `aimtp/0.1` (frozen) · **Implementation:** `1.0.0` (stable)

AIMTP is a **schema-first, transport-agnostic** protocol for structured
agent-to-agent message and task exchange. It defines **what is sent and why**,
not **how it is transported**. Implementations can pick their own transports
(HTTP, queues, files, etc.) while sharing a consistent envelope, message model,
and task semantics.

## Two version numbers

| | Value | Meaning |
|---|---|---|
| **Wire version** | `aimtp/0.1` | The envelope `spec` field. The interoperability contract. Frozen. |
| **Implementation** | `1.0.0` | This repo: reference relay, SDK, tooling. Semver. |

The wire version stays `aimtp/0.1` — every deployed peer expects that exact
string, and the schemas pin it with `"const"`. Reaching implementation 1.0
changes nothing on the wire. See
[`docs/aimtp-1.0-freeze.md`](docs/aimtp-1.0-freeze.md) for the full stability
contract and what it takes to claim conformance.

**Goals**
- Protocol stability with explicit versioning
- Clear JSON Schemas for validation
- Minimal, auditable surface area
- Interop across runtimes and teams
- Extensible metadata without breaking changes

## What you get

- A frozen envelope + message model with JSON Schemas ([`schemas/`](schemas/))
- A reference HTTP relay with at-least-once mailbox delivery: leasing, ack,
  fail, retry, dead-letter
- Chain-agnostic envelope signing with a normative canonical payload
- A **conformance kit** that pins canonical signing bytes across implementations
  ([`tests/conformance/`](tests/conformance/))
- An opt-in, default-inert federation trust surface (handshake, identity
  anchors, trust bundles, revocations, transparency log, bridge proofs)

## Conformance

Any implementation claiming `aimtp/0.1` conformance must agree byte-for-byte on
the canonical signing payload. That is pinned by committed vectors, not prose:

```sh
npm run conformance
```

```
AIMTP conformance report
  wire version: aimtp/0.1
  schema origin: https://aimtp.net

  [PASS] schema     16 passed, 0 failed
  [PASS] canonical  10 passed, 0 failed
  [PASS] signing     8 passed, 0 failed
  [PASS] integrity  24 passed, 0 failed

OK: conformance (58 checks)
```

The vectors are plain JSON, so non-Node implementations can consume them
directly. See [`tests/conformance/README.md`](tests/conformance/README.md).

## Trust Surface (Operator Summary)
- `v1` trust semantics are the frozen baseline.
- `v2` is opt-in via `INTENTOS_TRUST_VERSION=v2` with policy modes `off|warn|enforce`.
- `v3+` trust features are additive/experimental opt-ins (transparency, snapshots, distribution adapters, content-addressed IDs).

Execution semantics and receipt/crypto behavior are unchanged; trust additions
are opt-in and default inert. Per-release detail lives in
[`CHANGELOG.md`](CHANGELOG.md).

## Quick Start

**Prerequisites**
- Node.js 20+ and npm

```sh
npm ci
npm run build
npm test              # full suite, including the conformance kit
npm run conformance   # conformance kit on its own
```

**Run the relay**
```sh
AIMTP_API_KEY=dev-key node dist/runtime/relay.js
# -> AIMTP relay listening on port 8787/aimtp
```

That is all you need to follow every example below. Useful overrides:

| Variable | Default | Purpose |
|---|---|---|
| `AIMTP_API_KEY` | *(none)* | Admin key. Requests without it get `401`. |
| `PORT` | `8787` | Listen port. |
| `AIMTP_ALLOWED_RECIPIENTS` | *(unset)* | Comma-separated recipient allowlist. **Unset means any well-formed recipient is accepted** and the relay logs an `open_mailbox_mode` warning at startup. Set this in any deployment you care about. |
| `AIMTP_STORE` | `sqlite` | `sqlite`, `redis`, or `memory`. |
| `INTENTOS` | *(off)* | Set to `on` to enable the IntentOS endpoints and UI at `/aimtp/intentos/ui`. |

Full reference: [`docs/runtime.md`](docs/runtime.md).

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
[`docs/runtime.md`](docs/runtime.md).

## Documentation
- **[1.0 freeze and stability contract](docs/aimtp-1.0-freeze.md)** — what is frozen, what may extend, how to claim conformance
- **[Conformance kit](tests/conformance/README.md)** — how to verify an implementation
- [Release flow](docs/release-flow.md)
- [Release governance](docs/release-governance.md)
- [Trust evolution](docs/trust-evolution.md)
- [IntentOS federation trust boundaries](docs/intentos-federation.md)
- [0.4 gate/default matrix](docs/0.4-gates.md)
- [0.4 threat surface](docs/0.4-threat-surface.md)
- Runtime + API reference: [docs/runtime.md](docs/runtime.md)
- IntentOS v2.1 receipts contract (frozen): [docs/intentos-receipts.md](docs/intentos-receipts.md)
- IntentOS v1 trust semantics (frozen): [docs/intentos-federation.md#intentos-v1-trust-semantics-frozen](docs/intentos-federation.md#intentos-v1-trust-semantics-frozen)
- System architecture: [docs/architecture.md](docs/architecture.md)
- Security model: [docs/security.md](docs/security.md)
- Protocol spec: [spec/aimtp-v0.1.md](spec/aimtp-v0.1.md)

## Operations
For deployment, environment configuration, and recovery guidance, see
[`docs/operations.md`](docs/operations.md).

## Trust Diagnostics
```sh
npm run trust:diag
npm run trust:diag -- --json
npm run trust:diag -- --strict
npm run trust:diag -- --ci
```

## Operator Recipe: Enable v2 Trust
Set `INTENTOS_TRUST_VERSION=v2` and `INTENTOS_RECEIPT_POLICY=enforce`.
Set `INTENTOS_TRUSTED_RECEIPT_KEYS_JSON='{"relay://X":"<PUBLIC_KEY_PEM>"}'`.
Optional hardening: `INTENTOS_TRUST_V2_MAX_TIMESTAMP_SKEW_SEC=300`.
Recommended rollout: start with `INTENTOS_RECEIPT_POLICY=warn`, then switch to `enforce`.
Execution semantics do not change; only receipt trust acceptance changes.
Details: [`docs/ops-v2-trust.md`](docs/ops-v2-trust.md).

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

See [`docs/architecture.md`](docs/architecture.md) for a detailed flow,
store choices, and scaling guidance.

## Testing

```sh
npm test              # full suite; ends with the conformance kit
npm run conformance   # conformance kit only
```

Optional cross-language schema check (needs `pip install jsonschema`):
```sh
python3 tests/conformance/validate_schemas.py
```

Opt-in trust distribution smoke (local FS + local HTTP only):
```sh
npm run smoke:dist
```

Opt-in revocation smoke (local FS + local HTTP adapters; hermetic):
```sh
npm run smoke:revocations
```

Opt-in trust bundle smoke (local FS + local HTTP adapters; hermetic):
```sh
npm run smoke:bundle
```

This smoke is opt-in and not part of the default `npm test` path.

## Troubleshooting

Common issues and fixes are documented in
[`docs/runtime.md`](docs/runtime.md).

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
See [`LICENSE`](LICENSE).
