# Changelog

All notable changes to this project will be documented in this file.

Note: The protocol surface is frozen since v0.1.0; later versions are runtime/sdk/docs/examples only.

## [v1.0.0]

Implementation reaches 1.0. **The wire version is unchanged at `aimtp/0.1`** —
this release changes nothing on the wire. See
[`docs/aimtp-1.0-freeze.md`](docs/aimtp-1.0-freeze.md) for the stability
contract.

### Fixed
- **`POST /aimtp` rejected every documented recipient.** With no
  `AIMTP_ALLOWED_RECIPIENTS` configured, the endpoint fell through to an
  in-process registry lookup that only ever contained the hardcoded
  `aimtp-relay` agent, so a relay started per the README returned
  `404 unknown_recipient` for every envelope. It now validates the recipient
  against `RECIPIENT_PATTERN`, consistent with `/peek`, `/poll`, `/dead`, and
  `/aimtp/mailbox`. An explicit allowlist is still enforced exactly as before,
  and auth is unchanged. Fixed in both `src/runtime/relay.ts` and
  `runtime/http.js`.
- Schema `$id` namespace was split across two domains (`aimtp.dev` for
  envelope/message/bridge-proof and the five `spec/*.schema.json` files,
  `aimtp.net` for the four mailbox schemas), making `$ref` resolution ambiguous
  for outside implementers. All 16 `$id`s and absolute `$ref`s are now rooted at
  `https://aimtp.net`.
- `BRIDGE_PROOF_SCHEMA` in `src/protocol/bridge-proof.ts` carried a stale `$id`
  that disagreed with `schemas/bridge-proof-v1.schema.json`.
- **`npm run smoke:dist` was failing.** It wrote an unsigned trust bundle, but
  strict v2 implies `requireSignature`, so the fs and http adapters both
  rejected it with `TRUST_SIGNATURE_INVALID`. The bundle is now signed the same
  way `tools/trust-bundle-sign.mjs` signs, with the signer supplied via
  `INTENTOS_TRUST_BUNDLE_TRUSTED_SIGNERS_JSON`. This was pre-existing: the
  earlier `fix(smoke): align rc smoke with v2 fail-closed` change updated
  `rc-smoke.mjs` and missed this one.
- **Both shipped example clients returned 401 and could not run.** The relay is
  intentionally fail-closed — with no `AIMTP_API_KEY` configured it rejects
  every request rather than serving unauthenticated traffic — but neither
  `examples/webhook-relay/demo.js` nor `examples/python-client/client.py` set a
  key. Both now default to a demo key. The fail-closed behavior is unchanged.
- **Both example READMEs documented a request/response model the relay no longer
  has.** `examples/webhook-relay/README.md` claimed a registered agent's task
  responses are returned in the HTTP response; the HTTP path actually enqueues
  to the mailbox and returns `202`. Registering a handler has no effect on the
  HTTP path (handler dispatch lives on `relay.receive()`). Both demos now walk
  the real lifecycle — send, peek, poll, ack, drain, plus the rejection path —
  and both READMEs describe the at-least-once queue model accurately.
- The Python interop client validated the `202` acceptance receipt as though it
  were an envelope, which could never succeed. It now validates the acceptance
  shape, then polls the envelope back out of the mailbox and re-validates the
  round trip against the same schemas — which is the actual cross-language
  interop proof — then acks.
- Both example demos pinned `AIMTP_STORE=memory` so repeated runs start from an
  empty queue instead of inheriting `runtime/aimtp-mailbox.sqlite`.

### Added
- **Conformance kit** (`tests/conformance/`, `npm run conformance`) with 58
  checks across four suites: schema vector validation, canonical signing payload
  byte-equality, signature accept/reject behavior, and schema integrity.
  - 9 canonicalization vectors pinning the exact canonical bytes, SHA-256, and
    byte length for key reordering, signature stripping, array order, nested
    sorting, unicode and escapes, numeric forms, and empty containers.
  - 8 signing vectors covering valid verification, order-independence,
    legacy `key_id`/`signature` aliases, tampering, untrusted kid, unsupported
    alg, and expiry windows — reproducible from a fixed ed25519 seed.
  - Integrity checks asserting a single schema origin, resolvable absolute
    `$ref`s, the frozen `aimtp/0.1` spec constant, and no drift between the
    embedded and file copies of the bridge-proof schema.
  - Runs as part of `npm test`, so CI covers it with no workflow change.
- `tests/quickstart-open-mailbox.test.js` — regression guard pinning the
  documented Quick Start: envelope POST, peek, poll, ack, malformed-recipient
  rejection, allowlist enforcement, and auth enforcement.
- `open_mailbox_mode` startup log so operators are told when no recipient
  allowlist is configured.
- `docs/aimtp-1.0-freeze.md` — stability contract separating the frozen wire
  surface from the semver-tracked implementation surface.

### Changed
- `tests/conformance/validate_schemas.py` now auto-discovers all envelope
  vectors by `valid-`/`invalid-` prefix instead of checking a hardcoded three,
  and asserts the frozen spec version.
- README rewritten for a first-time reader: correct status, the two-version
  explanation, a Quick Start that works verbatim, and an environment variable
  table documenting `PORT`, `AIMTP_ALLOWED_RECIPIENTS`, and `INTENTOS`, none of
  which were previously documented in the Quick Start path.

### Removed
- 55 untracked macOS duplicate files (`* 2.ext`, `* 3.ext`) across `src/`,
  `tests/`, `tools/`, `dist/`, `docs/`, `.github/workflows/`, and the repo root.
  One of them, `src/protocol/federation-handshake 2.ts`, was a stale copy that
  `tsc` compiled into `dist/` and shipped via the `files` array.

## [v0.1.14]
### Added
- Redis mailbox store implementation (`AIMTP_STORE=redis`) with FIFO enqueue/poll behavior and TTL-aware message handling.
- Mailbox store conformance test coverage for store selection and Redis-to-SQLite fallback behavior.
### Changed
- Store selection now supports `AIMTP_STORE=sqlite|redis` while keeping `AIMTP_MAILBOX_STORE` as a compatible alias.
- Relay gracefully falls back to SQLite when Redis is unavailable.

## [v0.1.13]
### Added
- Minimal CORS support for relay browser demo requests, including OPTIONS preflight on `/aimtp`, `/aimtp/peek`, and `/aimtp/poll`.
### Changed
- Relay now applies origin allowlisting via `AIMTP_CORS_ORIGINS` (default localhost demo origins) and returns CORS headers for allowed origins.
- README Web Demo docs updated with CORS defaults and configuration.

## [v0.1.12]
### Added
- Browser demo at `examples/web-inbox/index.html` for send + peek + poll flows.
- Optional `npm run demo:web` static server for local demo hosting on `http://localhost:8080`.
### Changed
- README now includes Web Demo usage and zsh-safe quoted curl examples for peek/poll.

## [v0.1.11]
### Added
- In-memory mailbox relay with polling endpoints (`/aimtp/peek`, `/aimtp/poll`) plus TTL and queue limits.
- Recipient isolation via per-recipient keys, with admin key support for full access.
### Changed
- `POST /aimtp` now enqueues envelopes and returns `202` with queue depth.
- Auth is required for `/aimtp`, `/aimtp/peek`, and `/aimtp/poll`.

## [v0.1.10]
### Fixed
- Enforced allowlist handling in the relay entrypoint build (dist/runtime/relay.js).

## [v0.1.9]
### Fixed
- Allowlisted recipients are treated as known recipients via a default handler.

## [v0.1.8]
### Added
- Env-based recipient/sender allowlists for the relay.
### Changed
- Removed in-memory admin recipient endpoints (deferred).

## [v0.1.7]
### Added
- Recipient allowlist via `AIMTP_ALLOWED_RECIPIENTS` with in-memory admin endpoints.
- Optional sender allowlist via `AIMTP_ALLOWED_SENDERS`.
### Changed
- Relay returns `unknown_recipient`/`unknown_sender` when allowlists reject a request.

## [v0.1.6]
### Added
- Optional shared API key auth for the webhook relay.
### Changed
- Health/readiness endpoints remain unauthenticated when auth is enabled.
- Structured relay logs include auth status (`disabled`, `ok`, `missing`, `invalid`).

## [v0.1.5]
### Added
- Health endpoint (`/healthz`) and optional readiness endpoint (`/readyz`).
- Graceful shutdown on SIGINT/SIGTERM.

## [v0.1.3]
### Added
- Python interop client that validates schemas and auto-starts relay.

## [v0.1.4]
### Changed
- Hardened webhook relay: config, limits, error handling.

## [v0.1.2]
### Changed
- Runtime emits schema-conformant v0.1 envelopes and distinct `TaskResponse.id` (if present).

## [v0.1.1]
### Added
- SDK/runtime exports wired with relay test/demo.

## [v0.1.0]
### Added
- Initial v0.1 spec, schemas, conformance tests, and reference implementation.
