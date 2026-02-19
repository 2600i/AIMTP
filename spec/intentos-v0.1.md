# IntentOS v0.1

This document tracks additive IntentOS behavior layered on AIMTP runtime endpoints.

## IntentOS v0.2 (Read-only Web Inbox)

IntentOS v0.2 adds a small read-only web inbox served by the relay HTTP server.

### UI Endpoints

- `GET /intentos/ui` MUST serve the IntentOS inbox HTML shell.
- `GET /intentos/ui/` MUST behave the same as `GET /intentos/ui`.
- `GET /intentos/ui/app.js` MUST serve the UI JavaScript.
- `GET /intentos/ui/styles.css` MUST serve the UI CSS.

### Read-only Scope

- The UI MUST be read-only.
- The UI MUST NOT issue write operations (no submit/claim/result actions).
- The UI reads from existing IntentOS read endpoints:
  - `GET /intentos/intents`
  - `GET /intentos/intent/:id`
  - `GET /intentos/tasks`

### Feature Gating

- `/intentos/ui*` routes MUST require `INTENTOS=on`.
- If `INTENTOS` is not enabled, `/intentos/ui*` MUST return `404`.

### Auth and Enforcement

- IntentOS API authorization uses AIMTP capabilities when `AIMTP_CAPABILITIES=on`.
- Audience (`aud`) MUST exactly match the relay base URL (for example `http://localhost:8787/aimtp`).
- Scope matching is exact (`action` + `resource`), without wildcard expansion.

Required scope mapping:
- `GET /intentos/intents` => `action=intentos.read`, `resource=intentos:intents`
- `GET /intentos/tasks` => `action=intentos.read`, `resource=intentos:tasks`
- `GET /intentos/intent/:id` => `action=intentos.read`, `resource=intentos:intent/<id>`
- `POST /intentos/task/:id/claim` => `action=intentos.task.claim`, `resource=intentos:task/<id>`
- `POST /intentos/task/:id/result` => `action=intentos.task.result`, `resource=intentos:task/<id>`

Mode semantics:
- In `INTENTOS_MODE=log`, missing or invalid capabilities MUST be logged and requests MAY proceed.
- In `INTENTOS_MODE=enforce` with `AIMTP_CAP_MODE=enforce`, all IntentOS API endpoints (read and write) MUST require a valid, exact-scope capability.
- Missing capability in enforce mode MUST return `403` with `code=capability_required`.
- Invalid capability (bad format/signature/aud/expired/scope mismatch) in enforce mode MUST return `403` with `code=capability_invalid`.
- The UI MUST surface read errors from those API calls to the user without attempting fallback writes.

## IntentOS v0.3 (Versioned Trust Semantics for Receipts)

IntentOS v0.3 introduces versioned trust semantics for receipt verification and policy without changing execution state transitions.

### Version Selection

- `INTENTOS_TRUST_VERSION=v1|v2` selects trust semantics. Default is `v1`.
- v1 behavior remains frozen and backward compatible.
- v2 behavior is additive and policy-gated.

### Versioning Note

- v2 trust semantics are opt-in through `INTENTOS_TRUST_VERSION=v2`.
- If unset, runtime remains on v1 trust semantics by default.
- Future trust revisions MUST remain explicitly versioned and opt-in.

### v2 Trust Requirements

- Trusted terminal receipts (`receipt.denied|receipt.completed|receipt.failed`) require valid signing proof.
- Issuer identity MUST resolve to a configured trusted key.
- Verification MUST use deterministic v2 canonicalization rules.

### Trust v2 Strict Semantics

- v2 is active when `INTENTOS_TRUST_VERSION=v2`.
- When v2 is active, trust evaluation is fail-closed for terminal receipts (`receipt.denied|receipt.completed|receipt.failed`):
  - there is no permissive acceptance path under `off` or `warn`.
  - `warn` and `enforce` MAY differ in warning/diagnostic messaging, but MUST NOT differ in acceptance.
- Terminal receipt acceptance rules in v2:
  - missing signature => `accepted=false`
  - invalid or tampered signature => `accepted=false`
  - revoked anchor or revoked key => `accepted=false`
  - expired or out-of-skew anchor => `accepted=false`
- Policy controls receipt trust acceptance only. It MUST NOT alter execution semantics.

### Error Codes

- `TRUST_BUNDLE_INVALID`: trust bundle validity failure (including malformed bundle and expired/out-of-skew anchor); surfaces in receipt policy trust evaluation and trust bundle apply rejection.
- `TRUST_ANCHOR_REVOKED`: anchor/key revocation match detected; surfaces in receipt policy trust evaluation and trust bundle apply rejection.
- `TRUST_SIGNATURE_INVALID`: required trust signature missing or invalid/tampered; surfaces in receipt policy trust evaluation and trust bundle apply rejection.

#### Compatibility Contract

- The above v2 acceptance behavior and error codes are stable within the `0.4.x` line.
- Under v2, `warn` vs `enforce` MAY affect warnings/diagnostics, but MUST NOT change receipt acceptance outcomes.

### Replay Linkage (v2)

- v2 trust verification binds receipt trust to:
  - `envelopeId + intentId + issuer + type + timestamp + metadata`
- Timestamp sanity bounds MAY be enforced when configured.
- Persistent anti-replay storage is out of scope in this phase.
