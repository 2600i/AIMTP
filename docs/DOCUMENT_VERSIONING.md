# AIMTP documentation versioning

- **Document status:** Canonical
- **Last updated:** 2026-08-07

This policy keeps document authority, product maturity, and protocol versions
separate. A document can be canonical for an experimental surface; canonical
means “the current source of truth,” not “production-ready.”

## Lifecycle labels

| Label | Use it when | Do not imply |
| --- | --- | --- |
| **Draft** | Normative or design content is still being reviewed and may change before its stated compatibility boundary is frozen. | Implementation completeness, consensus, or a release commitment. |
| **Developer Preview** | The documented surface can be explored and tested but is not presented as production-ready, hardened, scalable, or compliant. | Semantic instability by itself; explicitly name any frozen sub-surfaces. |
| **v0.x** | A protocol, profile, or document has an explicit pre-1.0 compatibility line. Breaking changes require a new version according to that document's rules. | That every repository component shares the same version. |
| **v1.0+** | A defined surface has a published stability contract and change policy. | Production readiness. The implementation package may be `1.0.0` while the frozen wire contract remains `aimtp/0.1`. |
| **Historical** | A document records an earlier plan, release, architecture, or artifact and is retained for provenance. | Current guidance or future intent. Link to the current replacement. |
| **Deprecated** | A document or guidance path should no longer be used and has an identified replacement. | Immediate deletion. Preserve the redirect until links and consumers have migrated. |

The authority classifications `CANONICAL`, `ACTIVE`, `NEEDS_UPDATE`,
`HISTORICAL`, and `DEPRECATED` are maintained in
[`DOCUMENTATION_MAP.md`](DOCUMENTATION_MAP.md). They are repository curation
states, not protocol maturity labels.

## Metadata

Use metadata on canonical specifications, high-impact architecture/product
documents, and documents whose lifecycle could otherwise be misunderstood:

```text
Status: Draft | Developer Preview | Historical | Deprecated
Version: <only when the document or governed surface has a real version>
Last Updated: YYYY-MM-DD
Supersedes: <path or identifier, when applicable>
Superseded By: <path or identifier, when applicable>
```

Omit fields that add no information. Do not mechanically assign `v1.0`, update
dates for whitespace-only edits, or version small runbooks independently unless
consumers need a compatibility promise.

## Change rules

- Update canonical terminology in [`GLOSSARY.md`](GLOSSARY.md) before or with
  changes that introduce a new preferred term.
- Update protocol prose, schemas, and conformance vectors together when wire
  behavior changes. The frozen `aimtp/0.1` contract requires a new wire version
  for breaking changes.
- Add `Superseded By` before moving a document to historical or deprecated
  status. Keep old claims intact except for a concise status notice.
- Record implementation releases in [`../CHANGELOG.md`](../CHANGELOG.md), not
  by relabeling all documentation with the package version.
- Review dates and status during release preparation or a material architecture
  change; avoid date churn on unrelated edits.
