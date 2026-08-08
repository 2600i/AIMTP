# AIMTP licensing

Copyright © 2026 Steven Bianchi. All rights reserved.

AIMTP uses separate terms for the protocol, the software implementation, and
the brand. This implements the intended model of an open protocol, a controlled
commercial implementation, and a controlled brand. The structure and the
scope decisions below are subject to final legal review.

## Protocol materials — CC BY 4.0

The following materials are licensed under the Creative Commons Attribution
4.0 International license in
[`LICENSES/CC-BY-4.0.txt`](LICENSES/CC-BY-4.0.txt):

- `spec/**`
- `schemas/envelope.schema.json`
- `schemas/message.schema.json`
- `schemas/bridge-proof-v1.schema.json`
- `tests/vectors/**`
- `tests/conformance/vectors/**`
- `tests/conformance/README.md`
- `README.md`
- the following general protocol documentation:
  - `docs/0.4-gates.md`
  - `docs/0.4-threat-surface.md`
  - `docs/0.4.0-foundation.md`
  - `docs/0.4.0-scope.md`
  - `docs/aimtp-1.0-freeze.md`
  - `docs/architecture.md`
  - `docs/DOCUMENTATION_MAP.md`
  - `docs/DOCUMENT_VERSIONING.md`
  - `docs/GLOSSARY.md`
  - `docs/implementing-aimtp.md`
  - `docs/intentos-federation.md`
  - `docs/intentos-receipts.md`
  - `docs/interoperability.md`
  - `docs/overview.md`
  - `docs/README.md`
  - `docs/security.md`
  - `docs/trust-evolution.md`
  - `docs/whitepapers/WHITEPAPER_STATUS.md`

Unless the material supplies different attribution information, attribution may
be given as: "AIMTP protocol materials, Copyright © 2026 Steven Bianchi,
licensed under CC BY 4.0." Shared adaptations must identify that they were
modified and otherwise comply with CC BY 4.0.

The CC BY 4.0 grant applies to the listed copyrightable material. It does not
grant patent or trademark rights and does not imply endorsement, certification,
or sponsorship.

## Software implementation — Elastic License 2.0

The implementation is source available, not open source. Except for the
protocol materials and exclusions expressly listed in this document, tracked
repository files are software or implementation material licensed under the
unmodified Elastic License 2.0 in
[`LICENSES/ELASTIC-LICENSE-2.0.txt`](LICENSES/ELASTIC-LICENSE-2.0.txt). This
includes, without limitation:

- `src/**`, `sdk/**`, `runtime/**`, `cli/**`, `tools/**`, and `scripts/**`
- `examples/**`
- executable test and conformance tooling under `tests/**`
- build, deployment, CI, and configuration files
- Gateway, relay, mailbox, storage, and backend/server implementation
- product, operator, release, and deployment documentation not listed above

ELv2 includes its own patent grant and patent-termination provision. Use of the
ELv2-licensed AIMTP software does not require a separate patent agreement. No
additional standalone patent grant or patent non-assert is provided.

ELv2 permits use, inspection, modification, creation of derivative works, and
distribution subject to its terms. Among its limitations, the software may not
be provided to third parties as a hosted or managed service where users receive
access to any substantial set of its features or functionality. Consult the
license text for the controlling terms.

## Reference relay profile — Elastic License 2.0

The mailbox API schemas under `runtime/schemas/**` and their vectors under
`tests/runtime-vectors/**` describe implementation-specific operations of the
ELv2-licensed reference relay. They are experimental implementation material,
not part of the base AIMTP envelope specification or the CC BY 4.0 protocol
grant. If AIMTP later standardizes an interoperable relay delivery profile,
that profile and the schemas necessary to implement it independently should be
reviewed for reclassification as protocol material.

## Exclusions and third-party material

- `docs/history/whitepaper-images/**` is excluded from the grants above pending
  a provenance and rights review. All rights are reserved.
- `LICENSE`, `LICENSING.md`, `NOTICE`, and `TRADEMARKS.md` are repository legal
  and administrative notices, not protocol or software material. Copyright in
  those notices is reserved, except to the extent reproduction is required to
  comply with an applicable license.
- Files under `LICENSES/**` reproduce standard license terms and are governed
  by the notices in those texts and the rights of their respective publishers.
- Brand rights are governed separately by [`TRADEMARKS.md`](TRADEMARKS.md).
- Dependency licenses and third-party notices remain governed by their
  respective owners and license terms. Nothing here relicenses third-party
  material.
- A file containing its own license or attribution notice is governed by that
  notice to the extent it conflicts with this repository-level map.

## Inbound contributions

Contributions are inbound-under-outbound: **a contribution is licensed under the
same terms this document already assigns to the file it touches.** A change to
`spec/**` or another CC BY 4.0 path is contributed under CC BY 4.0; a change to
`src/**`, `runtime/**`, or another ELv2 path is contributed under ELv2. A pull
request that spans both categories is contributed under each category's terms
for the files in it. There is no separate contributor license agreement, and
contributors are not asked to assign copyright.

By opening a pull request you represent that you wrote the contribution or are
otherwise entitled to submit it under these terms, and that you are not
knowingly including third-party material under incompatible terms. Flag any
third-party material in the pull request description so its license can be
recorded under [Exclusions and third-party material](#exclusions-and-third-party-material).

Two consequences worth stating plainly, because the split model makes them
non-obvious:

- Moving a file between the CC BY 4.0 and ELv2 sets changes the terms that apply
  to it going forward. Propose such a move as its own pull request, and update
  the path lists above in that same change rather than afterwards.
- The maintainers may relicense or dual-license the project's own materials.
  They cannot unilaterally relicense a contribution outside the terms it came in
  under, so a contribution that must carry different terms needs to say so at
  submission time.

Brand names, logos, and marks are never granted by a contribution; see
[`TRADEMARKS.md`](TRADEMARKS.md).

## Legal review

Final counsel review is required before a public standards/specification
release, particularly for copyright ownership, schema classification, patent
strategy for CC BY 4.0 protocol materials, trademark policy, and the inbound
contribution terms above. Commercial licensing inquiries may be directed to
`steve@2600i.com`.
