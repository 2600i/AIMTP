AIMTP Project Context

- Public relay: https://relay.aimtp.net
- Auth: AIMTP_API_KEY
- Allowlists enforced
- Mailbox polling implemented
- CORS enabled for localhost demo
- Current phase: Phase 4 – Persistence
- Non-goals: do not change protocol, auth, or CORS unless asked
- Release rule: tests must pass, version bump + tag required


## Git & Release Rules

- Codex may commit and tag releases.
- Codex must never push unless explicitly instructed.
- All releases require:
  - tests passing
  - version bump
  - CHANGELOG update
  - annotated git tag
