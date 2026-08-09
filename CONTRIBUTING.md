# Contributing to AIMTP

AIMTP is a developer preview maintained by a small team. Issues and pull
requests are welcome on that understanding.

This file is deliberately short and links rather than restates. If it ever
disagrees with the documents it points at, they win.

## Before you start

- [`CONTEXT.md`](CONTEXT.md) — current architecture, design principles, and the
  claims discipline this project holds itself to.
- [`docs/README.md`](docs/README.md) — the documentation hierarchy and what is
  authoritative for what.
- [`AGENTS.md`](AGENTS.md) — the full development command set.

## Reporting a security issue

**Do not open a public issue.** Follow [`SECURITY.md`](SECURITY.md), which
covers the private reporting channel, what is in and out of scope, and a
"known and accepted" list — the demo keys in git history, the simulated
purchase handler, and the fail-closed relay are documented behavior, not
findings.

## Workflow

Use a feature branch; never commit to `main` directly. Keep changes reviewable
and preserve unrelated work.

Both of these gate CI and must pass locally:

```sh
npm test
npm run test:receipts
```

There is no formatter script. Match the surrounding code's style, comment
density, and naming.

## Rules that are easy to trip over

- **The `aimtp/0.1` wire contract is frozen.** A breaking change needs a new
  wire version plus coordinated specification, schema, and conformance vector
  updates in the same change. See [`docs/aimtp-1.0-freeze.md`](docs/aimtp-1.0-freeze.md).
- **`aimtp/0.1` and `1.0.0` are different numbers.** The first is the frozen
  wire version; the second is the implementation version. Never conflate them.
- **Update specifications and schemas together.** Prose cannot override the
  JSON Schemas, and implementation guides cannot expand the conformance
  contract.
- **Claims must be traceable** to code, tests, or a clearly labeled roadmap
  statement. If a document disagrees with the code, the code is the evidence —
  mark the document `NEEDS_UPDATE` rather than inventing behavior.
- **Never commit key material.** Demo keypairs are generated on demand into
  gitignored paths by `scripts/generate-federation-keys.mjs`.
- **`.dockerignore` is deny-by-default.** If a build or an in-container test
  needs a new path, add that path to the allowlist. Do not relax the leading
  `*` — that guard exists because local credentials previously reached image
  layers.

## Licensing of contributions

Contributions are **inbound-under-outbound**: your change is licensed under the
terms this repository already applies to the files you touch. A change to a
CC BY 4.0 path is contributed under CC BY 4.0; a change to an Elastic License
2.0 path is contributed under ELv2. There is no contributor license agreement
and no copyright assignment.

Opening a pull request represents that you wrote the contribution or are
otherwise entitled to submit it under those terms, and that you are not
knowingly including third-party material under incompatible terms. Flag any
third-party material in the pull request description.

The controlling text, the path-by-path scope, and the two consequences the
split model makes non-obvious are in
[`LICENSING.md`](LICENSING.md#inbound-contributions). Brand names, logos, and
marks are never granted by a contribution — see [`TRADEMARKS.md`](TRADEMARKS.md).
