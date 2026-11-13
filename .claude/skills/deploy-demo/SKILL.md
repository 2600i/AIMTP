---
name: deploy-demo
description: Deploy the AIMTP Gateway demo to the OVH host with scripts/deploy.sh — topology, health checking, and known host incidents (RAM exhaustion, stale base images).
---

# Deploying the demo

`bash scripts/deploy.sh` on the OVH host deploys **only the Gateway demo**,
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
