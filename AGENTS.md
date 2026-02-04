# AGENTS.md — AIMTP (TypeScript)

## Goal
Build AIMTP as a schema-first protocol:
- spec in /spec
- JSON Schemas in /schemas
- reference SDK in /src
- conformance vectors in /tests/vectors
- CI in /.github/workflows

## Project commands
- Install: `npm ci`
- Build: `npm run build`
- Test: `npm test`
- Format: `npm run format`

## Working rules
- Prefer small, reviewable commits.
- Never edit on main; always use a feature branch/worktree.
- Every change must include tests or vectors when applicable.
- Update spec + schema together (no drift).
- Before marking done: run `npm test` and fix failures.

## Output expectations
- Provide a short plan before edits.
- After edits: list files changed + how to verify.

## Prepare a release:
- Ensure tests pass: npm test
- Update CHANGELOG.md if needed
- Bump version in package.json (patch/minor as appropriate)
- Commit with message "chore(release): vX.Y.Z"
- Tag annotated "vX.Y.Z"
- Push commit + tags to origin
- Output the final: git log -1, git tag --points-at HEAD, and git push output

