#!/usr/bin/env bash
# Build and push the 1618.dev image to Docker Hub.
# Usage:
#   ./deploy.sh              # tags as :latest and :<git-sha>
#   ./deploy.sh v1.2.3       # tags as :latest and :v1.2.3

set -euo pipefail

IMAGE="awmanoj/healthlog"
TAG="${1:-$(git rev-parse --short HEAD)}"

echo ">> Building $IMAGE:$TAG"

if docker buildx version >/dev/null 2>&1; then
  echo ">> Using docker buildx (multi-arch: linux/amd64,linux/arm64)"
  docker buildx build \
    --platform linux/amd64,linux/arm64 \
    -t "$IMAGE:$TAG" \
    -t "$IMAGE:latest" \
    --push \
    .
else
  echo ">> buildx not available; falling back to classic docker build (single-arch)"
  docker build -t "$IMAGE:$TAG" -t "$IMAGE:latest" .
  docker push "$IMAGE:$TAG"
  docker push "$IMAGE:latest"
fi

echo ">> Done. Pull on the server with: docker pull $IMAGE:latest"
