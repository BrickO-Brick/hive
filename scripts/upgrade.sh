#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hive-common.sh
source "${SCRIPT_DIR}/hive-common.sh"

new_image="${1:?Usage: upgrade.sh ghcr.io/bricko-brick/hive@sha256:<digest>}"
[[ "${new_image}" =~ ^ghcr\.io/bricko-brick/hive@sha256:[0-9a-f]{64}$ ]] || {
  echo "Upgrade image must be the exact OneBrick GHCR digest." >&2
  exit 1
}
[[ -n "${AGE_RECIPIENT:-}" ]] || { echo "AGE_RECIPIENT is required." >&2; exit 1; }

"${SCRIPT_DIR}/backup.sh"
previous="$(sed -n 's/^HIVE_IMAGE=//p' "${HIVE_ENV_FILE}")"
HIVE_IMAGE="${new_image}" hive_compose pull relay
HIVE_IMAGE="${new_image}" hive_compose up -d --wait relay
if ! HIVE_IMAGE="${new_image}" "${SCRIPT_DIR}/healthcheck.sh"; then
  echo "Upgrade failed; restoring previous relay image without changing volumes." >&2
  HIVE_IMAGE="${previous}" hive_compose up -d --wait relay
  exit 1
fi
echo "previous_image=${previous}"
echo "current_image=${new_image}"
echo "Persist the tested digest in ${HIVE_ENV_FILE} using an atomic owner-only edit."
