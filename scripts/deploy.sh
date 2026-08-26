#!/usr/bin/env bash
#
# Deploy the Agent Trust Gateway demo on the Hetzner host.
#
#   ssh hetzner
#   cd /opt/2600i-aimtp && bash scripts/deploy.sh
#
# This deploys ONLY the gateway demo, from docker-compose.demo.yml. The default
# docker-compose.yml in this repo is a local development topology (relay +
# redis, no API key, fail-closed) and must never be used to deploy -- see the
# comments at the top of both files.
#
# The demo backs the live panel on aimtp.net. With the container down, the
# website renders its "unavailable" state and points at the recorded run; it
# never fakes a live Gateway. So a failed deploy here degrades the website
# rather than breaking it.
set -euo pipefail

COMPOSE_FILE="docker-compose.demo.yml"
SERVICE="gateway-demo"
CONTAINER="aimtp-gateway-demo"
NETWORK="aimtp-demo"
HEALTH_TIMEOUT=60

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> $CONTAINER: deploying from $PWD"

if ! git diff --quiet HEAD 2>/dev/null; then
  echo "ERROR: tracked files are modified on this host:" >&2
  git status --short >&2
  echo >&2
  echo "Deploy from a clean checkout. To discard local edits:" >&2
  echo "  git checkout -- ." >&2
  exit 1
fi

echo "==> Pulling"
git pull --ff-only

# Shared with the website container so it can reach this one by name. Created
# once by hand originally; recreate it here so a rebuilt host doesn't need the
# step remembered.
if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  echo "==> Creating missing network $NETWORK"
  docker network create "$NETWORK"
fi

swap_total="$(free -m 2>/dev/null | awk '/^Swap:/ {print $2}' || echo unknown)"
if [ "${swap_total:-unknown}" = "0" ]; then
  echo "WARNING: no swap configured; this build may exhaust memory." >&2
  echo "  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile" >&2
  echo "  echo '/swapfile none swap sw 0 0' >> /etc/fstab" >&2
fi

echo "==> Building (with fresh base image)"
docker compose -f "$COMPOSE_FILE" build --pull

echo "==> Starting"
docker compose -f "$COMPOSE_FILE" up -d

# This container is never published to the host -- the website reaches it over
# the shared Docker network -- so there is no port to curl. Read the health
# status Docker itself records from the image's HEALTHCHECK.
echo "==> Waiting for container health"
for i in $(seq 1 "$HEALTH_TIMEOUT"); do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo missing)"
  case "$status" in
    healthy)
      echo "==> Healthy after ${i}s"
      docker image prune -f >/dev/null
      echo "==> Deployed: $(git log --oneline -1)"
      exit 0
      ;;
    unhealthy)
      echo "ERROR: container reported unhealthy" >&2
      break
      ;;
  esac
  sleep 1
done

echo "ERROR: not healthy after ${HEALTH_TIMEOUT}s (last status: ${status:-unknown})" >&2
docker compose -f "$COMPOSE_FILE" logs --tail=100 "$SERVICE" >&2
exit 1
