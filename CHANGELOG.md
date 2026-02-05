# Changelog

All notable changes to this project will be documented in this file.

Note: The protocol surface is frozen since v0.1.0; later versions are runtime/sdk/docs/examples only.

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
