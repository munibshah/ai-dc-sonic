#!/usr/bin/env bash
#
# Admin-only: build the GPU worker container as a multi-arch image and push it
# to Docker Hub. Users of the lab never need to run this — they just `docker
# pull` the published image (or let `make pull` do it for them).
#
# Runs anywhere with docker + buildx (Docker Desktop, OrbStack, Linux). The
# common case is "run from a Mac, push to Hub once per Dockerfile change".
#
# Usage:
#   ./scripts/publish-worker.sh                    # uses defaults
#   IMAGE=otheruser/aidc-worker:v2 ./scripts/publish-worker.sh
#   PLATFORMS=linux/amd64 ./scripts/publish-worker.sh   # single-arch only
#
# Prereqs (one-time):
#   docker login                                   # cache Hub creds
#   docker buildx version                          # confirm buildx is available

set -euo pipefail

IMAGE="${IMAGE:-munibshah/aidc-worker:latest}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILDER_NAME="${BUILDER_NAME:-aidc-builder}"

# Resolve repo root from this script's location, then point at workers/.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONTEXT="${REPO_ROOT}/workers"

if [[ ! -f "${CONTEXT}/Dockerfile" ]]; then
  echo "error: ${CONTEXT}/Dockerfile not found — is the repo intact?" >&2
  exit 1
fi

echo "==> Building & pushing ${IMAGE}"
echo "    Platforms: ${PLATFORMS}"
echo "    Context:   ${CONTEXT}"
echo

# Reuse an existing buildx builder, or create one if missing. The builder
# survives across runs so subsequent builds reuse its layer cache.
if ! docker buildx inspect "${BUILDER_NAME}" >/dev/null 2>&1; then
  echo "==> Creating buildx builder '${BUILDER_NAME}'"
  docker buildx create --name "${BUILDER_NAME}" --use
else
  docker buildx use "${BUILDER_NAME}"
fi

docker buildx build \
  --platform "${PLATFORMS}" \
  --tag "${IMAGE}" \
  --push \
  "${CONTEXT}"

echo
echo "==> Pushed ${IMAGE}"
echo "    Anyone running 'make pull' (default WORKER_IMAGE=${IMAGE}) now gets it."
