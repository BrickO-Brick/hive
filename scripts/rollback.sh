#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hive-common.sh
source "${SCRIPT_DIR}/hive-common.sh"

rollback_image="${1:?Usage: rollback.sh ghcr.io/bricko-brick/hive@sha256:<digest>}"
[[ "${rollback_image}" =~ ^ghcr\.io/bricko-brick/hive@sha256:[0-9a-f]{64}$ ]] || {
  echo "Rollback image must be an exact OneBrick GHCR digest." >&2
  exit 1
}
[[ "${HIVE_ROLLBACK_CONFIRM:-}" == "rollback-hive-preserve-volumes" ]] || {
  echo "Set HIVE_ROLLBACK_CONFIRM=rollback-hive-preserve-volumes" >&2
  exit 1
}
rollback_backup="${HIVE_ROLLBACK_BACKUP:?Set HIVE_ROLLBACK_BACKUP to the coordinated backup directory}"
[[ "${rollback_backup}" == /* && -f "${rollback_backup}/manifest.txt" && -f "${rollback_backup}/SHA256SUMS" ]] || {
  echo "Rollback requires an existing coordinated Hive backup." >&2
  exit 1
}

HIVE_IMAGE="${rollback_image}" hive_compose pull relay
HIVE_IMAGE="${rollback_image}" hive_compose up -d --wait relay
HIVE_IMAGE="${rollback_image}" "${SCRIPT_DIR}/healthcheck.sh"
echo "rollback_image=${rollback_image}"
echo "volumes_preserved=true"
