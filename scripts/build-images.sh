#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hive-common.sh
source "${SCRIPT_DIR}/hive-common.sh"
require_command docker

[[ -z "$(git -C "${HIVE_REPO_ROOT}" status --porcelain)" ]] || {
  echo "Image builds require a clean working tree." >&2
  exit 1
}
source_sha="$(git -C "${HIVE_REPO_ROOT}" rev-parse HEAD)"
upstream_sha="$(git -C "${HIVE_REPO_ROOT}" rev-parse '@{upstream}')"
[[ "${source_sha}" == "${upstream_sha}" ]] || {
  echo "Image builds require the exact pushed authoritative revision." >&2
  exit 1
}
created="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
relay_tag="ghcr.io/bricko-brick/hive:sha-${source_sha}"
agent_tag="ghcr.io/bricko-brick/hive-agent:sha-${source_sha}"
output=(--load)
if [[ "${HIVE_PUSH_IMAGES:-false}" == true ]]; then
  output=(--push --provenance=true --sbom=true)
fi

docker buildx build "${HIVE_REPO_ROOT}" \
  --file "${HIVE_REPO_ROOT}/Dockerfile" \
  --build-arg RUST_IMAGE=rust:1.95-bookworm@sha256:6258907abe69656e41cd992e0b705cdcfabcbbe3db374f92ed2d47121282d4a1 \
  --build-arg NODE_IMAGE=node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e \
  --build-arg DEBIAN_IMAGE=debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 \
  --build-arg BUZZ_SOURCE_SHA="${source_sha}" \
  --build-arg OCI_SOURCE=https://github.com/BrickO-Brick/hive \
  --build-arg OCI_URL=https://github.com/BrickO-Brick/hive \
  --build-arg OCI_DOCUMENTATION=https://github.com/BrickO-Brick/hive/tree/main/docs \
  --build-arg OCI_CREATED="${created}" \
  --tag "${relay_tag}" "${output[@]}"

docker buildx build "${HIVE_REPO_ROOT}" \
  --file "${HIVE_DEPLOY_DIR}/Dockerfile.agent" \
  --build-arg HIVE_SOURCE_SHA="${source_sha}" \
  --build-arg OCI_CREATED="${created}" \
  --tag "${agent_tag}" "${output[@]}"

echo "relay_tag=${relay_tag}"
echo "agent_tag=${agent_tag}"
if [[ "${HIVE_PUSH_IMAGES:-false}" == true ]]; then
  echo "Resolve and record both registry digests before deployment."
fi
