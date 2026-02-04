# Changelog

All notable changes to this project will be documented in this file.

Note: The protocol surface is frozen since v0.1.0; later versions are runtime/sdk/docs/examples only.

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
