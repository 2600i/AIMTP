# Changelog

All notable changes to this project will be documented in this file.

Note: The protocol surface is frozen since v0.1.0; later versions are runtime/sdk/docs/examples only.

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
