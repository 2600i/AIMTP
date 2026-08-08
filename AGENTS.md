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
- Receipt/trust tests: `npm run test:receipts`
- Conformance only: `npm run conformance`

There is no `npm run format`; the repository has no formatter script.

## Working rules
- Prefer small, reviewable commits.
- Never edit on main; always use a feature branch/worktree.
- Every change must include tests or vectors when applicable.
- Update spec + schema together (no drift).
- Before marking done: run `npm test` and `npm run test:receipts`, and fix
  failures. Both gate CI.
- `.dockerignore` is deny-by-default. If a build or an in-container test needs a
  new path, add that path to the allowlist; never relax the leading `*`.

## Output expectations
- Provide a short plan before edits.
- After edits: list files changed + how to verify.


