# Historical: AIMTP v0.3.x Release Governance

This was the canonical operator workflow for `v0.3.x` releases. It is retained
for release history and must not be used as the current package-version or
branch plan. Current release-tool behavior is documented in
[`docs/release-flow.md`](release-flow.md).

## Policy Baseline

- Runtime/trust/crypto semantics are frozen unless explicitly versioned.
- New tooling and docs are allowed; defaults stay inert unless opted in.
- Stable tags are cut from `main` only.
- Stable release merge policy is config-driven via `.aimtp/release.yml`.

## Branch Roles

- `main`: protected stable line. Only merged PRs. Stable tags (`vX.Y.Z`) are cut here.
- `feature/*` (or `codex/*`): active development and experiments.
- `rc/v0.3.x`: stabilization lane for prerelease cuts (`-alpha.N`, `-beta.N`, `-rc.N`).

## Channel Policy

- `alpha` (`v0.3.x-alpha.N`): early integration snapshots. Cut when risky changes need broad testing.
- `beta` (`v0.3.x-beta.N`): feature-complete branch with bugfix-only focus.
- `rc` (`v0.3.x-rc.N`): candidate expected to go stable unless blockers appear.
- `stable` (`v0.3.x`): cut after RC sign-off and merge into `main` with a PR-first merge.

## Merge Strategy (Required)

- Stable merge strategy is read from `.aimtp/release.yml` (`stableMergeStrategy`):
  - `merge_commit`: allow merge commit (`2+` parents) or legacy subject marker `merge:`.
  - `merge_or_squash`: allow merge commit or squash merge with configured markers (`squashMarkers`), for example:
    - `feat(relay): harden release gating (#123)`
- Current repo setting:
  - `stableMergeStrategy: merge_or_squash`
  - `squashMarkers: "(#", "merge:"`
- Guardrail source of truth:
  - local preflight: `scripts/release.mjs` + `scripts/release-guardrails.mjs`
  - tag CI: `scripts/release-tag-guardrails.mjs`

## Command Checklists

### 1) Start an RC branch (once per patch line)

```sh
git checkout main
git pull --ff-only origin main
git checkout -b rc/v0.3.x
git push -u origin rc/v0.3.x
```

### 2) Cut alpha/beta/rc from rc branch

```sh
git checkout rc/v0.3.x
git pull --ff-only origin rc/v0.3.x
npm run release:verify -- --version 0.3.1-rc.1
npm run release:version -- 0.3.1-rc.1
```

Use the same flow for alpha/beta by changing the version suffix.

### 3) Cut stable from main

Version bump must already be merged via PR into `main`.

```sh
git checkout main
git pull --ff-only origin main
npm run release:verify -- --version 0.3.1
npm run release
```

Do not run `npm run release:version -- 0.3.1` for stable.

### 4) Optional GitHub release (if enabled in config)

```sh
npm run release:gh
```

## Verification Bundle

`npm run release:verify` runs:

1. `node scripts/release.mjs preflight`
2. `npm test`
3. `npm run build`
4. `npm run test:receipts`
5. `npm run smoke:rc`

Pass `--version <semver>` to force preflight checks for a target tag version.
