#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hive-common.sh
source "${SCRIPT_DIR}/hive-common.sh"

backup_path="${1:?Usage: restore-test.sh /absolute/path/to/hive-backup}"
test_suffix="$(date -u +%H%M%S)"
test_project="hive-restore-${test_suffix}"
test_ingress="${test_project}-ingress"
test_env="$(mktemp)"
cleanup() {
  HIVE_PROJECT="${test_project}" HIVE_ENV_FILE="${test_env}" \
  ONEBRICK_INGRESS_NETWORK="${test_ingress}" hive_compose down >/dev/null 2>&1 || true
  rm -f "${test_env}" "${test_env}.bak"
  docker network rm "${test_ingress}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cp "${HIVE_ENV_FILE}" "${test_env}"
chmod 0600 "${test_env}"
sed -i.bak 's/^HIVE_HTTP_BIND=.*/HIVE_HTTP_BIND=127.0.0.1:13300/' "${test_env}" 2>/dev/null || \
  sed -i 's/^HIVE_HTTP_BIND=.*/HIVE_HTTP_BIND=127.0.0.1:13300/' "${test_env}"
rm -f "${test_env}.bak"
docker network create \
  --label io.onebrick.hive.network=restore-test \
  "${test_ingress}" >/dev/null

HIVE_PROJECT="${test_project}" HIVE_ENV_FILE="${test_env}" \
ONEBRICK_INGRESS_NETWORK="${test_ingress}" \
  hive_compose up -d --wait postgres redis minio minio-init relay
HIVE_PROJECT="${test_project}" \
HIVE_ENV_FILE="${test_env}" \
ONEBRICK_INGRESS_NETWORK="${test_ingress}" \
HIVE_RESTORE_CONFIRM="restore-${test_project}-$(basename "${backup_path}")" \
  "${SCRIPT_DIR}/restore.sh" "${backup_path}"
HIVE_PROJECT="${test_project}" HIVE_ENV_FILE="${test_env}" \
ONEBRICK_INGRESS_NETWORK="${test_ingress}" "${SCRIPT_DIR}/healthcheck.sh"
HIVE_PROJECT="${test_project}" HIVE_ENV_FILE="${test_env}" \
ONEBRICK_INGRESS_NETWORK="${test_ingress}" hive_compose down
echo "restore_test=PASS project=${test_project}"
echo "Note: isolated test volumes are retained for audit and explicit cleanup."
