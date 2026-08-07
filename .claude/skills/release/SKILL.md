---
name: release
description: Cut an AIMTP release — run tests, update CHANGELOG, bump the version, tag, and push commit + tags to origin.
---

# Prepare a release

- Ensure tests pass: `npm test`
- Update CHANGELOG.md if needed
- Bump version in package.json (patch/minor as appropriate)
- Commit with message "chore(release): vX.Y.Z"
- Tag annotated "vX.Y.Z"
- Push commit + tags to origin
- Output the final: `git log -1`, `git tag --points-at HEAD`, and `git push` output
