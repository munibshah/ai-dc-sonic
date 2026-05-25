#!/usr/bin/env bash
#
# Admin-only: build the Next.js UI container as a multi-arch image and push it
# to Docker Hub. Users of the lab never need to run this — they just
# `docker pull` the published image (or let `make pull` do it).
#
# Runs anywhere with docker + buildx (Docker Desktop, OrbStack, Linux). The
# common case is "run from a Mac, push to Hub once per UI code change".
#
# Usage:
#   ./scripts/publish-ui.sh
#   IMAGE=otheruser/aidc-ui:v2 ./scripts/publish-ui.sh
#   PLATFORMS=linux/amd64 ./scripts/publish-ui.sh  # single-arch
#
# Prereqs (one-time):
#   docker login
#   docker buildx version

set -euo pipefail

IMAGE="${IMAGE:-munibshah/aidc-ui:latest}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILDER_NAME="${BUILDER_NAME:-aidc-builder}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONTEXT="${REPO_ROOT}/ui"

if [[ ! -f "${CONTEXT}/Dockerfile" ]]; then
  echo "error: ${CONTEXT}/Dockerfile not found — is the repo intact?" >&2
  exit 1
fi

echo "==> Building & pushing ${IMAGE}"
echo "    Platforms: ${PLATFORMS}"
echo "    Context:   ${CONTEXT}"
echo

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
echo "    Anyone running 'make pull' (default UI_IMAGE=${IMAGE}) now gets it."
