# AIMTP documentation map

- **Document status:** Canonical inventory
- **Last updated:** 2026-08-07

New contributors should begin with [`docs/README.md`](README.md), then read the
canonical overview, glossary, architecture, base specification, and the
documentation for the implementation surface they intend to use.

Each meaningful document has exactly one curation status:

- **CANONICAL:** current source of truth for its stated subject.
- **ACTIVE:** current supporting or operational documentation.
- **NEEDS_UPDATE:** still useful, but its scope, version framing, or structure
  needs reconciliation before it can be authoritative.
- **HISTORICAL:** retained as a record; not current guidance.
- **DEPRECATED:** should no longer be used; follow its replacement.

These curation states do not indicate product maturity. See
[`DOCUMENT_VERSIONING.md`](DOCUMENT_VERSIONING.md).

## Canonical navigation and governance

| Path | Status | Purpose | Authoritative for | Replacement | Action needed |
| --- | --- | --- | --- | --- | --- |
| `README.md` | CANONICAL | Repository landing page and runnable orientation | Concise project positioning, current maturity summary, and first-run path | — | Keep concise; link to detailed canonical docs rather than expanding definitions here. |
| `docs/README.md` | CANONICAL | Documentation index | Source-of-truth hierarchy and contributor reading order | — | Review whenever a canonical document changes responsibility. |
| `docs/overview.md` | CANONICAL | Current project overview | AIMTP scope, protocol/product distinction, and maturity overview | — | Keep aligned with README without duplicating implementation detail. |
| `docs/GLOSSARY.md` | CANONICAL | Terminology registry | Preferred terms, deprecated synonyms, and ambiguity notes | — | Update with architecture terminology changes. |
| `docs/architecture.md` | CANONICAL | Current system architecture | Protocol, Gateway, relay, federation, settlement, and security boundaries | — | Keep implementation claims traceable to tests/code. |
| `docs/DOCUMENTATION_MAP.md` | CANONICAL | Documentation inventory | Document authority and curation status | — | Review during material documentation or architecture changes. |
| `docs/DOCUMENT_VERSIONING.md` | CANONICAL | Lifecycle policy | Documentation status, version, and supersession conventions | — | Apply selectively to high-impact documents. |
| `CONTEXT.md` | ACTIVE | Working context for contributors and coding agents | Concise contributor guardrails and current architecture summary | — | Keep short and point to canonical docs. |
| `CODEX_PROJECT.md` | DEPRECATED | Former duplicate coding-agent context | Nothing current | `CONTEXT.md` | Retain only as a redirect until external references are confirmed absent. |
| `AGENTS.md` | ACTIVE | Repository working instructions | Required development workflow and validation commands | — | Keep synchronized with actual package scripts and branch policy. |
| `.claude/skills/release/SKILL.md` | ACTIVE | Release automation instructions | Claude-specific release workflow | `docs/release-flow.md` for human-facing behavior | Review with release tooling changes. |
| `CHANGELOG.md` | ACTIVE | Release history | Completed implementation changes by package version | — | Continue recording releases; do not use as a roadmap. |

## Protocol, product, and implementation

| Path | Status | Purpose | Authoritative for | Replacement | Action needed |
| --- | --- | --- | --- | --- | --- |
| `spec/aimtp-v0.1.md` | CANONICAL | Draft base protocol specification | `aimtp/0.1` envelope, message, task, signature, and conformance semantics | — | Preserve frozen wire behavior; breaking changes require a new wire version. |
| `schemas/envelope.schema.json` | CANONICAL | Base envelope schema | Machine-readable `aimtp/0.1` envelope validation | — | Update only with coordinated spec and vector changes. |
| `schemas/message.schema.json` | CANONICAL | Base message schema | Machine-readable message validation | — | Update only with coordinated spec and vector changes. |
| `schemas/bridge-proof-v1.schema.json` | ACTIVE | Experimental bridge-proof schema | Current implemented bridge-proof shape | — | Keep labeled experimental; reconsider placement/licensing if standardized. |
| `spec/federation-handshake-v0.4.schema.json` | ACTIVE | Experimental handshake schema | Current implemented handshake payload shape | Future consolidated federation profile | Preserve implemented names; keep outside base conformance claims. |
| `spec/identity-anchor-v0.4.schema.json` | ACTIVE | Experimental identity-anchor schema | Current implemented anchor shape | Future consolidated identity/federation profile | Preserve implemented names; keep labeled opt-in. |
| `spec/identity-anchor-set-v0.4.schema.json` | ACTIVE | Experimental anchor-set schema | Current implemented anchor-set shape | Future consolidated identity/federation profile | Preserve implemented names; keep labeled opt-in. |
| `spec/revocation-proof-v0.4.schema.json` | ACTIVE | Experimental revocation-proof schema | Current implemented proof shape | Future consolidated trust profile | Preserve implemented names; do not imply global revocation. |
| `spec/revocation-set-v0.4.schema.json` | ACTIVE | Experimental revocation-set schema | Current implemented set shape | Future consolidated trust profile | Preserve implemented names; do not imply global propagation. |
| `spec/trust-bundle-v0.4.schema.json` | ACTIVE | Experimental trust-bundle schema | Current implemented bundle shape | Future consolidated trust profile | Preserve implemented names; keep labeled opt-in/default-inert. |
| `runtime/schemas/mailbox-ack.schema.json` | ACTIVE | Reference relay response schema | Implemented mailbox acknowledgement response shape | Future standardized relay profile, if approved | Keep implementation-specific and ELv2 unless reclassified after review. |
| `runtime/schemas/mailbox-fail.schema.json` | ACTIVE | Reference relay response schema | Implemented mailbox failure response shape | Future standardized relay profile, if approved | Keep implementation-specific and ELv2 unless reclassified after review. |
| `runtime/schemas/mailbox-poll-item.schema.json` | ACTIVE | Reference relay payload schema | Implemented mailbox poll item shape | Future standardized relay profile, if approved | Keep implementation-specific and ELv2 unless reclassified after review. |
| `runtime/schemas/mailbox-dead-letter-item.schema.json` | ACTIVE | Reference relay payload schema | Implemented dead-letter item shape | Future standardized relay profile, if approved | Keep implementation-specific and ELv2 unless reclassified after review. |
| `docs/aimtp-1.0-freeze.md` | CANONICAL | Compatibility contract | Difference between frozen wire version and implementation semver | — | Keep aligned with release guardrails and conformance tests. |
| `docs/trust-gateway.md` | CANONICAL | Gateway product/MVP reference | Verified Gateway request, policy, approval, audit, and limitation behavior | — | Update with Gateway implementation/tests; avoid future-topology claims as current behavior. |
| `docs/security.md` | CANONICAL | Security boundary reference | Authentication/authorization distinction, signatures, key disposition, and explicit non-guarantees | — | Review with changes to trust, Gateway, or key handling. |
| `docs/runtime.md` | CANONICAL | Relay and runtime reference | Implemented relay endpoints, configuration, delivery, and IntentOS projection | — | Separate relay API facts from base protocol semantics. |
| `docs/implementing-aimtp.md` | ACTIVE | Minimal implementation guide | Practical path to an `aimtp/0.1` implementation | Base spec for normative semantics | Replace repeated field detail with spec references when it begins to drift. |
| `docs/interoperability.md` | ACTIVE | Adjacent-protocol and conformance guidance | MCP/A2A/API division of responsibility and interoperability checklist | Architecture and base spec for definitions | Keep concise and evidence-based. |
| `docs/operations.md` | ACTIVE | Local operations runbook | Reference relay and Gateway startup/recovery guidance | Runtime/Gateway docs for complete configuration | Add production guidance only when verified. |
| `docs/intentos-receipts.md` | ACTIVE | IntentOS receipt contract | Implemented v2.1 receipt objects and routing behavior | — | Later reconcile naming/version lineage with the broader IntentOS profile. |
| `docs/ops-v2-trust.md` | ACTIVE | Experimental operator procedure | Opt-in IntentOS v2 trust rollout | — | Keep explicit that it is experimental, not a production assurance. |
| `docs/release-flow.md` | ACTIVE | Release-tool behavior | Current enforced release guardrails | — | Add a current operator checklist only if one is tested against tooling. |
| `docs/mailbox-sqlite-schema.sql` | ACTIVE | SQLite mailbox reference | Current reference-store table shape | Runtime implementation | Keep implementation-specific and out of base protocol claims. |
| `cli/README.md` | ACTIVE | Envelope-sender CLI guide | Current CLI usage | — | Verify flags with CLI changes. |
| `tests/conformance/README.md` | CANONICAL | Conformance-kit guide | Running and consuming base protocol vectors | — | Keep aligned with conformance runner output. |
| `examples/minimal-client/README.md` | ACTIVE | Minimal client orientation | Smallest envelope/client example boundaries | Base spec | Keep intentionally minimal. |
| `examples/python-client/README.md` | ACTIVE | Python interop demo | Running and interpreting the Python example | Base spec and conformance kit | Avoid implying a supported Python SDK. |
| `examples/reference-agents/README.md` | ACTIVE | Local agent-flow demo | Router/executor example behavior | Gateway doc for authorization behavior | Keep relay and Gateway roles distinct. |
| `examples/webhook-relay/README.md` | ACTIVE | Reference relay demo | At-least-once webhook-relay example | Runtime doc | Verify commands and queue semantics with runtime changes. |

## Experimental material needing reconciliation

| Path | Status | Purpose | Authoritative for | Replacement | Action needed |
| --- | --- | --- | --- | --- | --- |
| `spec/aimtp-v0.4-capabilities.md` | NEEDS_UPDATE | Experimental capability operating guidance | Current exact audience/scope behavior only where verified by tests/code | Future versioned capability profile | Separate normative schema semantics from operator recommendations and clarify relation to delegated authority. |
| `spec/intentos-v0.1.md` | NEEDS_UPDATE | Accumulated IntentOS v0.1-v0.3 behavior | Implemented UI and trust behavior only where verified | Runtime and receipts docs pending a consolidated IntentOS profile | Rename/version or split so the title matches its contents; add explicit maturity and scope. |
| `docs/intentos-federation.md` | NEEDS_UPDATE | Large federation/trust implementation record | Individual implemented experimental mechanisms, not AIMTP architecture | Architecture for current boundaries; future consolidated federation profile | Split chronological milestone material from a concise current profile; verify every environment/config claim. |
| `docs/0.4-gates.md` | NEEDS_UPDATE | Historical-version gate/default matrix with current utility | Listed 0.4 gate defaults only where runtime/tests still agree | Future experimental-profile configuration reference | Re-audit against runtime, remove RC framing, and identify reserved variables clearly. |
| `docs/0.4-threat-surface.md` | NEEDS_UPDATE | Experimental federation threat summary | High-level risks for the 0.4 trust surfaces | Security doc plus future federation profile | Reconcile with implemented multi-hop/bridge work and the Gateway threat boundary. |

## Historical and white-paper material

| Path | Status | Purpose | Authoritative for | Replacement | Action needed |
| --- | --- | --- | --- | --- | --- |
| `docs/0.4.0-foundation.md` | HISTORICAL | 0.4 foundation kickoff record | Initial phase state only | Architecture and README status table | Retain unchanged behind its historical notice. |
| `docs/0.4.0-scope.md` | HISTORICAL | Original 0.4 planning scope | Original plan only | Architecture and 0.4 gate matrix | Retain unchanged behind its historical notice. |
| `docs/beta-checklist.md` | HISTORICAL | v0.3 beta operator checklist | That release line only | Operations and current package scripts | Retain; do not execute as current guidance. |
| `docs/release-governance.md` | HISTORICAL | v0.3 release workflow | That release line only | `docs/release-flow.md` | Retain; do not link as the current operator procedure. |
| `docs/trust-evolution.md` | HISTORICAL | v0.3 trust phase record | Phase chronology only | README status and federation record | Retain for provenance. |
| `docs/history/README.md` | CANONICAL | Archive notice | Status, limitations, and rights caveat for archived visuals | — | Keep archive references pointed at current architecture/security docs. |
| `docs/history/whitepaper-images/**` | HISTORICAL | Earlier white-paper visual artifacts | Historical design only | Current architecture diagrams | Preserve pending provenance review; do not use as normative diagrams. |
| `docs/whitepapers/WHITEPAPER_STATUS.md` | CANONICAL | White-paper inventory and rewrite gate | Current disposition of all white-paper material | — | Update when a rewrite starts or an archive decision is made. |
| `docs/AIMTP_Whitepaper_Final.pdf` | NEEDS_UPDATE | December 2025 white paper (ignored local artifact) | Nothing current | Future rewritten white paper; current canonical docs in the status register | Preserve unchanged, then archive after a controlled rewrite. |
| `docs/AIMTP.zip` | HISTORICAL | Original visual source bundle (ignored local artifact) | Artifact provenance only | Archived image directory | Confirm backup/provenance before local removal or redistribution. |

## Legal and brand material

| Path | Status | Purpose | Authoritative for | Replacement | Action needed |
| --- | --- | --- | --- | --- | --- |
| `LICENSE` | CANONICAL | Repository license summary | License entry point and scope pointer | `LICENSING.md` for path-level detail | Final legal review. |
| `LICENSING.md` | CANONICAL | Path-level licensing map | CC BY 4.0 vs ELv2 scope and exclusions | — | Final counsel review, especially copyright, schemas, patents, and contributions. |
| `LICENSES/CC-BY-4.0.txt` | CANONICAL | Standard CC BY 4.0 terms | Controlling CC license text | — | Keep unmodified. |
| `LICENSES/ELASTIC-LICENSE-2.0.txt` | CANONICAL | Standard ELv2 terms | Controlling software license text | — | Keep unmodified. |
| `NOTICE` | CANONICAL | Copyright and license notice | Repository notice summary | — | Confirm copyright ownership with counsel. |
| `TRADEMARKS.md` | CANONICAL | Interim brand-use policy | Descriptive and permission-required AIMTP/2600i mark uses | — | Final legal review before certification or logo programs. |

## Explicit authority boundaries

- Protocol prose cannot override the base JSON Schemas, and implementation
  guides cannot expand the frozen conformance contract.
- Gateway documentation cannot redefine the AIMTP wire protocol; Gateway
  decision tokens are product/API vocabulary.
- Runtime, relay, IntentOS, and federation documents cannot claim base protocol
  requirements unless the base specification says so.
- Historical and white-paper material cannot be cited as current architecture.
- Code and tests remain the evidence for implemented behavior. If a canonical
  document disagrees with them, mark the document `NEEDS_UPDATE` and resolve the
  discrepancy rather than inventing behavior.
