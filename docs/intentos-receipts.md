# IntentOS Receipts and Receipt Routing (v2.1)

- **Status:** Active implementation profile
- **Compatibility:** IntentOS v2.1 receipt contract frozen; not part of the
  `aimtp/0.1` base protocol

## Scope
This document defines the protocol contract for runtime-generated receipts and optional internal receipt routing. It is normative for IntentOS v2.1.
Federation trust boundaries are specified separately in `docs/intentos-federation.md`.

## Receipt Types
Receipt `type` MUST be one of:
- `receipt.admitted`
- `receipt.denied`
- `receipt.completed`
- `receipt.failed`

## Receipt Object Contract
Each receipt MUST contain:
- `receiptId` (string)
- `envelopeId` (string)
- `intentId` (string)
- `type` (receipt type)
- `timestamp` (ISO-8601 string)
- `metadata` (JSON-safe object)

Receipts are runtime artifacts and are immutable once created.

Optional trust extension fields:
- `trustVersion` (`v2` when v2 trust semantics are emitted; absent implies v1 compatibility)
- `issuer`
- `sigAlg`
- `signature`

## Metadata Contract by Type
- `receipt.admitted`: `{}`
- `receipt.denied`: `{ "reason": "<string>" }`
- `receipt.completed`: `{ "outputHash": "<sha256-hex>" }`
- `receipt.failed`: `{ "error": "<string>" }`

## Deterministic Output Hash
For `receipt.completed`, `outputHash` MUST be computed as:
- `sha256(JSON.stringify(output))`
- SHA-256 digest encoded as lowercase hex

## Local Sink (Audit Trail)
Receipts MUST be appended as JSON lines (JSONL), append-only.

- Default path: `runtime/intentos-receipts.jsonl`
- Override: `INTENTOS_RECEIPTS_PATH`
- One receipt per line, serialized JSON object

## Optional Receipt Routing
Receipt delivery is optional and controlled by:
- `INTENTOS_RECEIPTS_DELIVER=on|off`
- Default: `off`

When delivery is `on`, runtime MAY enqueue a receipt message into the existing mailbox substrate.

### Recipient Derivation Rule
If requester identity is available, delivery recipient MUST be:
- `receipt://<requester>`

Requester is derived in this order:
1. `env.intent.requester`
2. `env.sender` (if present)
3. `env.from` (if present)

If none is available, runtime MUST NOT deliver and MUST still write JSONL.

## Receipt Message Contract (for routing)
A routed receipt message MUST contain:
- `id` (string)
- `recipient` (string, `receipt://<requester>`)
- `createdAtSec` (number)
- `receipt` (Receipt object)
- `traceId` (optional string)

## Best-Effort Guarantees
- JSONL sink and mailbox delivery are side effects.
- Failures in sink write or delivery enqueue MUST be swallowed.
- Admission logic, capability checks, and execution state transitions are unchanged.
- Receipt side effects MUST NOT alter execution semantics.

## Trust Semantics Versioning
- Runtime trust policy selection is controlled by `INTENTOS_TRUST_VERSION=v1|v2` (default `v1`).
- v2 trust semantics are defined in `docs/intentos-federation.md`.
- This receipts contract remains execution-semantics stable across trust versions.

## v2 Trust Semantics Quickstart
Use this profile when turning on trusted-only receipt acceptance in operations.

```sh
INTENTOS_TRUST_VERSION=v2
INTENTOS_RECEIPT_POLICY=enforce
INTENTOS_TRUSTED_RECEIPT_KEYS_JSON='{"relay://X":"<PUBLIC_KEY_PEM>"}'
# Optional:
INTENTOS_TRUST_V2_MAX_TIMESTAMP_SKEW_SEC=300
```

Expected behavior:
- Signed receipt + trusted issuer + valid signature => trusted.
- Unsigned terminal receipt => `accepted=false` in v2.
- Tampered or unknown-issuer receipt => `accepted=false` in v2.
- Under v2, `warn` vs `enforce` affects diagnostics, not acceptance outcomes.

## Examples
Receipt (completed):
```json
{"receiptId":"r-1","envelopeId":"env-1","intentId":"intent-1","type":"receipt.completed","timestamp":"2026-02-10T10:00:00.000Z","metadata":{"outputHash":"3c7f..."}}
```

Routed receipt message:
```json
{"id":"receipt-msg-r-1","recipient":"receipt://did:example:alice","createdAtSec":1770000100,"receipt":{"receiptId":"r-1","envelopeId":"env-1","intentId":"intent-1","type":"receipt.completed","timestamp":"2026-02-10T10:00:00.000Z","metadata":{"outputHash":"3c7f..."}}}
```

Receipt (denied):
```json
{"receiptId":"r-2","envelopeId":"env-2","intentId":"intent-2","type":"receipt.denied","timestamp":"2026-02-10T10:01:00.000Z","metadata":{"reason":"capability-expired"}}
```

## Replay tool
Use the deterministic replay CLI to re-evaluate admission/dispatch predicates and compare expected receipts with optional record/JSONL evidence.

Basic:
```sh
npm run replay:intentos -- --envelope /path/to/envelope.json
```

With record + JSON output:
```sh
npm run replay:intentos -- --envelope /path/to/envelope.json --record /path/to/record.json --json
```

With receipt sink scan:
```sh
npm run replay:intentos -- --envelope /path/to/envelope.json --receipt-jsonl /path/to/intentos-receipts.jsonl
```

Notes:
- The tool is read-only: no dispatch, no sink writes, no mailbox writes.
- If `dist/protocol/intentos-execution.js` is missing, run `npm run build` first.
