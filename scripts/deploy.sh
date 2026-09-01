#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hive-common.sh
source "${SCRIPT_DIR}/hive-common.sh"
require_hive_env

[[ -z "$(git -C "${HIVE_REPO_ROOT}" status --porcelain)" ]] || {
  echo "Deployment requires a clean working tree." >&2
  exit 1
}
head_sha="$(git -C "${HIVE_REPO_ROOT}" rev-parse HEAD)"
upstream_sha="$(git -C "${HIVE_REPO_ROOT}" rev-parse '@{upstream}')"
[[ "${head_sha}" == "${upstream_sha}" ]] || {
  echo "Deployment requires the clean, pushed authoritative revision." >&2
  exit 1
}

if ! getent hosts hive.onebrick.io >/dev/null 2>&1; then
  echo "DNS stop condition: hive.onebrick.io has no address record." >&2
  exit 1
fi

hive_compose config --quiet
hive_compose pull postgres redis minio minio-init
hive_compose up -d --wait postgres redis minio minio-init relay
"${SCRIPT_DIR}/healthcheck.sh"

mkdir -p "${HIVE_RELEASE_DIR:-/srv/hive/state/releases}"
manifest="${HIVE_RELEASE_DIR:-/srv/hive/state/releases}/release-$(timestamp_utc).txt"
{
  echo "hive_commit=$(git -C "${HIVE_REPO_ROOT}" rev-parse HEAD)"
  echo "upstream_base=$(tr -d '\n' < "${HIVE_REPO_ROOT}/UPSTREAM_BASE")"
  echo "relay_image=$(hive_compose images --format json relay | tr -d '\n')"
  echo "deployed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "operator=$(id -un)"
} > "${manifest}"
chmod 0600 "${manifest}"
echo "release_manifest=${manifest}"
