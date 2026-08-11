#!/usr/bin/env bash
# Pull the latest image and (re)start it as a long-running service on the host.
# Run this on the server. It is idempotent — safe to re-run after each deploy.
#
# Usage:
#   ./run.sh             # uses :latest
#   ./run.sh v1.2.3      # pins a specific tag

set -euo pipefail

IMAGE="awmanoj/healthlog"
TAG="${1:-latest}"
NAME="healthlog"
HOST_PORT="7432"

echo ">> Pulling $IMAGE:$TAG"
docker pull "$IMAGE:$TAG"

echo ">> Replacing container '$NAME'"
docker rm -f "$NAME" >/dev/null 2>&1 || true

docker run -d \
  --name "$NAME" \
  --restart unless-stopped \
  -p "${HOST_PORT}:80" \
  "$IMAGE:$TAG"

echo ">> Running. Site is on http://<host>:${HOST_PORT}"
docker ps --filter "name=^${NAME}$"
