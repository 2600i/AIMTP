# CLAUDE.md — AIMTP

Read [`CONTEXT.md`](CONTEXT.md) for architecture and claims discipline, and
[`AGENTS.md`](AGENTS.md) for commands and commit rules. This file covers only
what neither of those says.

## Do not touch

- `docs/` is maintained by a separate Codex agent. Do not restructure, rename,
  or re-index it. Fix factual errors in place, and say what you changed.
- `notes/` and `AIMTP_Story/` are gitignored and contain unredacted host and API
  credentials. Never stage them and never quote their contents.

## Two version numbers

`aimtp/0.1` is the frozen wire version. `1.0.0` is the implementation version.
Never conflate them — a release note implying a wire change is a bug, not a
wording choice.

## Generated figures are generated

Conformance counts and every Gateway verdict shown on the website come from
`tests/conformance/run.mjs --json` and from driving the real
`AgentTrustGateway`. After changing the Gateway or any schema, run
`npm run trace` in `../2600i-aimtp-web` or its `trace:check` fails. Never
hand-type these numbers; they have gone stale that way before.

## Keys

Demo keypairs are minted on demand by `scripts/generate-federation-keys.mjs`
into gitignored `runtime/federation-keys.json`. Never commit key material.
Historic demo keys remain in git history by decision — see
[`docs/security.md`](docs/security.md).
