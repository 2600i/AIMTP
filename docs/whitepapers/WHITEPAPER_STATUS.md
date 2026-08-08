# AIMTP white-paper status

- **Document status:** Canonical inventory
- **Last updated:** 2026-08-07

There is no current, authoritative AIMTP white paper in this repository. The
current source documents must remain stable before a controlled white-paper
rewrite begins. White papers do not override the protocol specification,
schemas, glossary, architecture, or documented implementation behavior.

## Inventory

| Title or path | Status | Why it is stale or limited | Stabilize before action | Recommended future action |
| --- | --- | --- | --- | --- |
| `docs/AIMTP_Whitepaper_Final.pdf` | **NEEDS_UPDATE** | The ignored local PDF was generated in December 2025. Its cover uses the deprecated “AI Message Transfer Protocol” expansion, and its associated visuals emphasize the earlier message-routing, email-adjacent, and blockchain-oriented direction. It predates the current trust-envelope framing, protocol/product separation, Gateway MVP, maturity language, and split licensing model. | [`../GLOSSARY.md`](../GLOSSARY.md), [`../overview.md`](../overview.md), [`../architecture.md`](../architecture.md), [`../../spec/aimtp-v0.1.md`](../../spec/aimtp-v0.1.md), [`../trust-gateway.md`](../trust-gateway.md), and [`../../LICENSING.md`](../../LICENSING.md) | **Rewrite** as a new version after remaining architecture/code changes settle. Do not edit the old PDF in place; preserve it as a dated source artifact. |
| [`docs/history/whitepaper-images/`](../history/whitepaper-images/) | **HISTORICAL** | These diagrams preserve early routing, email-adjacent, blockchain identity, anchoring, lifecycle, and trust concepts. They were moved under `docs/history/` but are otherwise unchanged: filenames and contents are byte-for-byte as first committed, including legacy naming such as `imtp-`. Their architecture is not current and provenance is unresolved. | Current architecture, security, glossary, and a documented asset-rights decision | **Retain as historical.** Reuse only after technical and rights review; create new diagrams for a rewritten paper. |
| `docs/AIMTP.zip` | **HISTORICAL** | This ignored local bundle contains earlier copies of the historical white-paper diagrams, including legacy naming. It is not a maintained or distributable documentation source. | Asset provenance/rights decision and the new white-paper asset plan | **Archive** outside the canonical documentation path or remove from local working copies after the owner confirms it is backed up. Do not cite it as authoritative. |

## Rewrite gate

A white-paper rewrite should begin only when:

- the canonical architecture and glossary reflect any remaining implementation
  changes;
- the boundary among the base protocol, Gateway, relay, and experimental
  federation profiles is stable;
- specification maturity and product maturity language is approved;
- the software/specification/brand licensing split has completed legal review;
- diagram provenance is resolved or all diagrams are recreated; and
- claims can be traced to code, tests, specifications, or clearly labeled
  roadmap statements.

The rewritten paper should receive a new filename and explicit status/version
metadata. The December 2025 PDF should then move from **NEEDS_UPDATE** to
**HISTORICAL**, with the new paper listed as its replacement.
