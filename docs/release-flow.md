# Hardened Release Flow

This document describes what release tooling enforces. For operator procedures,
see `docs/release-governance.md`.

## Tooling Entry Points

- `npm run release:preflight`
- `npm run release:verify`
- `npm run release` (`--use-current-version`)
- `npm run release:version -- <version>` (prerelease only)
- `npm run release:gh`

## Stable Guardrails

Stable versions (`X.Y.Z`) must satisfy:

- branch is `main`
- clean working tree
- local `main` matches `origin/main`
- PR-first merge check from `.aimtp/release.yml`:
  - `stableMergeStrategy=merge_commit`: `HEAD` is merge commit (`2+` parents) or subject starts with `merge:`
  - `stableMergeStrategy=merge_or_squash`: `HEAD` is merge commit (`2+` parents) or full commit message contains one of `squashMarkers` (for example `(#123)`)
- tag is annotated (`vX.Y.Z`)

Stable releases are cut with `npm run release` after the version bump PR has
already merged into `main`.

## Prerelease Guardrails

Prerelease versions (`-alpha.N`, `-beta.N`, `-rc.N`) can be cut with:

```sh
npm run release:version -- 0.3.1-rc.1
```

Preflight still enforces detached-head, clean-tree, and tag safety checks.

## Offline-safe Tag Checks

Preflight attempts:

1. `git fetch <remote> --tags`
2. fallback to `git ls-remote --tags <remote>`
3. offline fallback to local tag-only checks when `FETCH_HEAD` and DNS/network
   access are unavailable and branch-sync gates already prove safety

## CI Tag Guardrails

On `v*` tag push, CI runs `scripts/release-tag-guardrails.mjs` to enforce the
same stable policy without GitHub API dependencies.
