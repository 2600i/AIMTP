# AIMTP

AIMTP (AI Message Transfer Protocol) is a minimal, transport-agnostic JSON envelope for exchanging AI messages between systems.

## Status
- Version: 0.1 (draft)
- Stability: Experimental

## Goals
- Provide a small, well-defined envelope for AI message exchange.
- Keep transports decoupled from message semantics.
- Enable validation via JSON Schema.

## Non-goals
- Defining a complete conversation protocol.
- Mandating a transport or authentication scheme.

## Repo Layout
- `spec/aimtp-v0.1.md`
- `schemas/`
- `docs/`
- `sdk/`
- `examples/`
- `tests/`

## Quick Start
- Read the spec: `spec/aimtp-v0.1.md`.
- Validate envelopes against the JSON Schemas in `schemas/`.

## Versioning
- The spec version string is `aimtp/0.1`.
- Backward-incompatible changes require a new major version.

## License
- TBD
