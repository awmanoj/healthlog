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
# The image runs nginx unprivileged, which cannot bind a port below 1024.
# Pointing this at 80 makes docker-proxy accept on the host and then find
# nothing inside the container: the upstream closes and Caddy reports 502 EOF.
CONTAINER_PORT="8080"

echo ">> Pulling $IMAGE:$TAG"
docker pull "$IMAGE:$TAG"

echo ">> Replacing container '$NAME'"
docker rm -f "$NAME" >/dev/null 2>&1 || true

docker run -d \
  --name "$NAME" \
  --restart unless-stopped \
  -p "${HOST_PORT}:${CONTAINER_PORT}" \
  "$IMAGE:$TAG"

echo ">> Running. Site is on http://<host>:${HOST_PORT}"
docker ps --filter "name=^${NAME}$"

# Fail loudly here rather than leaving Caddy to return 502s.
echo ">> Checking health"
for i in $(seq 1 10); do
  if curl -fsS "http://127.0.0.1:${HOST_PORT}/healthz" >/dev/null 2>&1; then
    echo ">> OK — serving on 127.0.0.1:${HOST_PORT}"
    exit 0
  fi
  sleep 1
done
echo ">> FAILED — nothing answering on 127.0.0.1:${HOST_PORT}" >&2
docker logs --tail 30 "$NAME" >&2
exit 1
