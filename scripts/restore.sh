#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hive-common.sh
source "${SCRIPT_DIR}/hive-common.sh"
require_hive_env

backup_path="${1:?Usage: restore.sh /absolute/path/to/hive-backup}"
[[ "${backup_path}" == /* && -d "${backup_path}" ]] || {
  echo "Restore requires an existing absolute backup directory." >&2
  exit 1
}
backup_id="$(basename "${backup_path}")"
expected="restore-${HIVE_PROJECT}-${backup_id}"
[[ "${HIVE_RESTORE_CONFIRM:-}" == "${expected}" ]] || {
  echo "Refusing destructive restore. Set HIVE_RESTORE_CONFIRM=${expected}" >&2
  exit 1
}

(cd "${backup_path}" && sha256sum --check SHA256SUMS)
for required in postgres.dump redis-data minio-data git-data manifest.txt DATA_SHA256SUMS; do
  [[ -e "${backup_path}/${required}" ]] || {
    echo "Backup is incomplete: ${required}" >&2
    exit 1
  }
done
(cd "${backup_path}" && sha256sum --check DATA_SHA256SUMS)

agent_was_running=false
if [[ "$(hive_compose ps --status running -q bricko-agent)" != "" ]]; then
  agent_was_running=true
fi
hive_compose stop bricko-agent relay
hive_compose exec -T postgres dropdb \
  --username "${POSTGRES_USER:-hive}" \
  --force \
  --if-exists \
  "${POSTGRES_DB:-hive}"
hive_compose exec -T postgres createdb \
  --username "${POSTGRES_USER:-hive}" \
  --owner "${POSTGRES_USER:-hive}" \
  "${POSTGRES_DB:-hive}"
hive_compose exec -T postgres pg_restore \
  --username "${POSTGRES_USER:-hive}" \
  --dbname "${POSTGRES_DB:-hive}" \
  --exit-on-error < "${backup_path}/postgres.dump"

hive_compose stop redis minio
hive_compose run --rm --no-deps --entrypoint /bin/sh redis -euc \
  'busybox find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +'
# The single quotes deliberately defer array expansion to bash inside MinIO.
# shellcheck disable=SC2016
hive_compose run --rm --no-deps --entrypoint /bin/bash minio -euc \
  'shopt -s dotglob nullglob; entries=(/data/*); ((${#entries[@]} == 0)) || /usr/bin/rm -rf -- "${entries[@]}"'
hive_compose run --rm --no-deps --entrypoint /bin/bash relay -euc \
  'find /data/git -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +'
hive_compose cp "${backup_path}/redis-data/." redis:/data
hive_compose cp "${backup_path}/minio-data/." minio:/data
hive_compose cp "${backup_path}/git-data/." relay:/data/git
hive_compose --profile operations run --rm --no-deps relay-data-init
hive_compose up -d --wait postgres redis minio minio-init relay
"${SCRIPT_DIR}/healthcheck.sh"
if [[ "${agent_was_running}" == true ]]; then
  hive_compose --profile agent up -d --wait bricko-agent
fi
echo "restore_completed=${backup_id} project=${HIVE_PROJECT}"
