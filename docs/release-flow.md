# Hardened Release Flow

This document defines the hardened release process for AIMTP and the tooling added in `scripts/release.mjs`.

## Policy

- Never commit on `main` during feature development.
- Never create release tags from feature branches.
- Only perform hardened releases from `main` after merge.
- Release commands must run with a clean working tree and attached HEAD.

## Workflow

1. Develop and review on a feature branch.
2. Merge to `main`.
3. Sync local `main` with `origin/main`.
4. Run preflight:
   - `npm run release:preflight`
5. Run release:
   - Use current package version:
     - `npm run release`
   - Or set explicit version:
     - `npm run release:version -- 0.3.0`
6. Optionally publish a GitHub release (config-gated):
   - `npm run release:gh`

## What Hardened Release Enforces

- Rejects detached HEAD.
- Rejects if current branch is not `main`.
- Rejects dirty working tree.
- Fetches tags and validates `main` exactly matches `origin/main`.
- Runs `npm test` and `npm run build` before tagging.
- Creates annotated tag `vX.Y.Z`.
- Rejects existing tags.
- Pushes release commit and tag to `origin`.

## Version Modes

- `release --version X.Y.Z`:
  - Applies `npm version X.Y.Z --no-git-tag-version`.
  - Commits version files.
  - Runs checks, tags, and pushes.
- `release --use-current-version`:
  - Uses `package.json` version as-is.
  - Blocks prerelease versions (`-alpha`, `-beta`, etc.) unless config allows it.

## GitHub Release

- `github-release` is optional and controlled by `.aimtp/release.yml`.
- When enabled, it runs:
  - `gh release create <tag> --verify-tag [--generate-notes]`
- It fails clearly when `gh` is missing or authentication is not configured.

## Legacy Script

- `npm run ship` (`scripts/ship.js`) is retained as legacy/dev automation.
- It is not the hardened release flow and should not be used for production release policy.
