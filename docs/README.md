# AIMTP documentation

This directory is the entry point for AIMTP by 2600i documentation. The
repository is a developer preview with a frozen `aimtp/0.1` wire contract,
source-available reference software, and an experimental Agent Trust Gateway
MVP. Document authority is independent of product maturity.

## Start here

1. [`overview.md`](overview.md) — canonical project overview and current scope.
2. [`GLOSSARY.md`](GLOSSARY.md) — canonical terminology.
3. [`architecture.md`](architecture.md) — canonical architecture and system boundaries.
4. [`../spec/aimtp-v0.1.md`](../spec/aimtp-v0.1.md) — normative base protocol semantics.
5. [`trust-gateway.md`](trust-gateway.md) — current Agent Trust Gateway behavior and limitations.
6. [`DOCUMENTATION_MAP.md`](DOCUMENTATION_MAP.md) — status and authority of every meaningful document.

For implementation work, continue with [`implementing-aimtp.md`](implementing-aimtp.md),
[`runtime.md`](runtime.md), [`security.md`](security.md), and the
[`conformance kit`](../tests/conformance/README.md).

## Source-of-truth hierarchy

| Subject | Authoritative source |
| --- | --- |
| Project overview and current maturity | [`overview.md`](overview.md), with the root [`README`](../README.md) as the repository landing page |
| Terminology | [`GLOSSARY.md`](GLOSSARY.md) |
| Architecture and protocol/product boundaries | [`architecture.md`](architecture.md) |
| Base protocol semantics | [`../spec/aimtp-v0.1.md`](../spec/aimtp-v0.1.md) and the base schemas under [`../schemas/`](../schemas/) |
| Agent Trust Gateway | [`trust-gateway.md`](trust-gateway.md) |
| Security boundaries | [`security.md`](security.md) |
| Reference relay/API behavior | [`runtime.md`](runtime.md) |
| Compatibility guarantees | [`aimtp-1.0-freeze.md`](aimtp-1.0-freeze.md) |
| Roadmap and implementation status | The “What exists today” section of the root [`README`](../README.md#what-exists-today); [`CHANGELOG.md`](../CHANGELOG.md) records completed releases |
| Document lifecycle | [`DOCUMENT_VERSIONING.md`](DOCUMENT_VERSIONING.md) |
| Historical design | [`history/README.md`](history/README.md) and [`whitepapers/WHITEPAPER_STATUS.md`](whitepapers/WHITEPAPER_STATUS.md) |
| Licensing and brand | [`../LICENSING.md`](../LICENSING.md) and [`../TRADEMARKS.md`](../TRADEMARKS.md) |

## Directory policy

The current flat layout is retained to avoid unnecessary moves and broken
links. New material should be placed according to responsibility:

- base and profile specifications remain in `spec/`;
- protocol schemas remain in `schemas/`;
- reference-runtime schemas remain in `runtime/schemas/`;
- current architecture, Gateway, security, and operational documentation stays
  under `docs/` until a move provides more value than link churn;
- future white-paper drafts and their status register live in
  `docs/whitepapers/`;
- superseded design artifacts live in `docs/history/`.

Do not use folder location alone to infer authority. Consult the documentation
map, especially for versioned IntentOS and federation notes that remain useful
but need curation.
