#!/usr/bin/env bash
set -euo pipefail

HIVE_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HIVE_DEPLOY_DIR="${HIVE_REPO_ROOT}/deploy/onebrick"
HIVE_PROJECT="${HIVE_PROJECT:-hive}"
HIVE_ENV_FILE="${HIVE_ENV_FILE:-/srv/hive/secrets/hive.env}"

if [[ ! -f "${HIVE_ENV_FILE}" && -f "${HIVE_DEPLOY_DIR}/.env" ]]; then
  HIVE_ENV_FILE="${HIVE_DEPLOY_DIR}/.env"
fi

hive_compose() {
  docker compose \
    --project-name "${HIVE_PROJECT}" \
    --env-file "${HIVE_ENV_FILE}" \
    --file "${HIVE_DEPLOY_DIR}/compose.yml" \
    "$@"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Required command not found: $1" >&2
    exit 1
  }
}

require_hive_env() {
  [[ -f "${HIVE_ENV_FILE}" ]] || {
    echo "Missing Hive environment file: ${HIVE_ENV_FILE}" >&2
    exit 1
  }
  [[ "$(stat -c '%a' "${HIVE_ENV_FILE}" 2>/dev/null || stat -f '%Lp' "${HIVE_ENV_FILE}")" == "600" ]] || {
    echo "Hive environment file must have mode 0600: ${HIVE_ENV_FILE}" >&2
    exit 1
  }
  if grep -Eq '^[A-Za-z_][A-Za-z0-9_]*=.*CHANGE_ME' "${HIVE_ENV_FILE}"; then
    echo "Hive environment contains CHANGE_ME placeholders." >&2
    exit 1
  fi
  local image
  image="$(sed -n 's/^HIVE_IMAGE=//p' "${HIVE_ENV_FILE}")"
  [[ "${image}" =~ @sha256:[0-9a-f]{64}$ ]] || {
    echo "HIVE_IMAGE must be pinned by sha256 digest." >&2
    exit 1
  }
}

timestamp_utc() {
  date -u +%Y%m%dT%H%M%SZ
}
