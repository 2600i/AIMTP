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

## Deploying the demo

`bash scripts/deploy.sh` on the Hetzner host deploys **only the Gateway demo**,
from `docker-compose.demo.yml`. The default `docker-compose.yml` in this repo is
a local development topology — relay plus redis, no API key, fail-closed — and
must never be used to deploy.

The demo container is not published to the host. `aimtp.net` reaches it by name
over an external Docker network called `aimtp-demo`, so there is no port to
curl; health comes from the container's own `HEALTHCHECK`. If that network is
missing the deploy script recreates it.

Failing to deploy here degrades the website rather than breaking it: with the
container down, the public page renders its "unavailable" state and points at
the recorded run. That is the honest fallback, and it should stay that way.

Two things that have caused real incidents on this host:

- **2GB of RAM, four containers.** A build alongside them has exhausted memory
  and taken `sshd` down with it; the containers keep serving, so the sites look
  fine while the box is unreachable. Swap is what makes that survivable, and the
  script warns when there is none.
- **`docker compose up -d --build` does not refresh the base image.** It reuses
  whatever base layer is on disk, however old. The script passes `--pull` so
  OS-level CVEs in the runtime actually get picked up.
