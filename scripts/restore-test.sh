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
postgres_user="$(sed -n 's/^POSTGRES_USER=//p' "${test_env}")"
postgres_user="${postgres_user:-hive}"
postgres_db="$(sed -n 's/^POSTGRES_DB=//p' "${test_env}")"
postgres_db="${postgres_db:-hive}"
postgres_password="$(sed -n 's/^POSTGRES_PASSWORD=//p' "${test_env}")"
[[ -n "${postgres_password}" ]] || {
  echo "Restore test requires POSTGRES_PASSWORD for its isolated local database." >&2
  exit 1
}
sed -i.bak \
  "s#^DATABASE_URL=.*#DATABASE_URL=postgresql://${postgres_user}:${postgres_password}@postgres:5432/${postgres_db}#" \
  "${test_env}" 2>/dev/null || \
  sed -i \
    "s#^DATABASE_URL=.*#DATABASE_URL=postgresql://${postgres_user}:${postgres_password}@postgres:5432/${postgres_db}#" \
    "${test_env}"
rm -f "${test_env}.bak"
sed -i.bak 's/^HIVE_HTTP_BIND=.*/HIVE_HTTP_BIND=127.0.0.1:13300/' "${test_env}" 2>/dev/null || \
  sed -i 's/^HIVE_HTTP_BIND=.*/HIVE_HTTP_BIND=127.0.0.1:13300/' "${test_env}"
rm -f "${test_env}.bak"
docker network create \
  --label io.onebrick.hive.network=restore-test \
  "${test_ingress}" >/dev/null

HIVE_PROJECT="${test_project}" HIVE_ENV_FILE="${test_env}" \
ONEBRICK_INGRESS_NETWORK="${test_ingress}" \
  hive_compose --profile local-db up -d --wait postgres redis minio minio-init relay
HIVE_PROJECT="${test_project}" \
HIVE_ENV_FILE="${test_env}" \
ONEBRICK_INGRESS_NETWORK="${test_ingress}" \
HIVE_RESTORE_CONFIRM="restore-${test_project}-$(basename "${backup_path}")" \
  "${SCRIPT_DIR}/restore.sh" "${backup_path}"
HIVE_PROJECT="${test_project}" HIVE_ENV_FILE="${test_env}" \
ONEBRICK_INGRESS_NETWORK="${test_ingress}" HIVE_EXPECT_LOCAL_POSTGRES=true \
  "${SCRIPT_DIR}/healthcheck.sh"
HIVE_PROJECT="${test_project}" HIVE_ENV_FILE="${test_env}" \
ONEBRICK_INGRESS_NETWORK="${test_ingress}" hive_compose down
echo "restore_test=PASS project=${test_project}"
echo "Note: isolated test volumes are retained for audit and explicit cleanup."
