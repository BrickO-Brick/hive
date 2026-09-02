#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hive-common.sh
source "${SCRIPT_DIR}/hive-common.sh"
require_hive_env
require_command age

[[ -n "${AGE_RECIPIENT:-}" ]] || {
  echo "AGE_RECIPIENT is required; Hive backups containing secrets must be encrypted." >&2
  exit 1
}

backup_root="${HIVE_BACKUP_ROOT:-/srv/hive/backups}"
backup_id="hive-$(timestamp_utc)"
destination="${backup_root}/${backup_id}"
install -d -m 0700 "${destination}"

relay_was_running=false
if [[ "$(hive_compose ps --status running -q relay)" != "" ]]; then
  relay_was_running=true
fi
agent_was_running=false
if [[ "$(hive_compose ps --status running -q bricko-agent)" != "" ]]; then
  agent_was_running=true
fi
resume_services() {
  if [[ "${relay_was_running}" == true ]]; then
    hive_compose up -d --wait relay >/dev/null
  fi
  if [[ "${agent_was_running}" == true ]]; then
    hive_compose --profile agent up -d --wait bricko-agent >/dev/null
  fi
}
trap resume_services EXIT

hive_compose stop bricko-agent relay
# Use the same external PostgreSQL authority as the relay. The client runs as
# an ephemeral operations container; credentials remain in the owner-only
# Compose environment and are not placed on the host process command line.
# DATABASE_URL expands inside the client container.
# shellcheck disable=SC2016
hive_compose --profile operations run --rm --no-deps --entrypoint /bin/sh postgres \
  -euc 'pg_dump --dbname "$DATABASE_URL" --format custom' \
  > "${destination}/postgres.dump"
# The inner shell expands REDIS_PASSWORD from the container environment.
# shellcheck disable=SC2016
hive_compose exec -T redis sh -euc \
  'redis-cli --no-auth-warning -a "$REDIS_PASSWORD" SAVE >/dev/null'
hive_compose cp redis:/data "${destination}/redis-data"
hive_compose cp minio:/data "${destination}/minio-data"
hive_compose cp relay:/data/git "${destination}/git-data"
(cd "${destination}" && find redis-data minio-data git-data -type f -print0 \
  | LC_ALL=C sort -z | xargs -0r sha256sum > DATA_SHA256SUMS)

secret_parent="$(dirname "${HIVE_ENV_FILE}")"
secret_name="$(basename "${HIVE_ENV_FILE}")"
secret_items=("${secret_name}")
if [[ "${HIVE_BACKUP_CODEX_AUTH:-false}" == true ]]; then
  codex_home="${HIVE_CODEX_HOME:-/srv/hive/secrets/codex-home}"
  [[ "$(dirname "${codex_home}")" == "${secret_parent}" ]] || {
    echo "Codex home must share the governed secret parent for encrypted backup." >&2
    exit 1
  }
  secret_items+=("$(basename "${codex_home}")")
fi
tar -C "${secret_parent}" -cf - "${secret_items[@]}" \
  | age -r "${AGE_RECIPIENT}" -o "${destination}/secrets.tar.age"

{
  echo "backup_id=${backup_id}"
  echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "hive_commit=$(git -C "${HIVE_REPO_ROOT}" rev-parse HEAD)"
  echo "upstream_base=$(tr -d '\n' < "${HIVE_REPO_ROOT}/UPSTREAM_BASE")"
  echo "compose_project=${HIVE_PROJECT}"
  hive_compose images --format json
} > "${destination}/manifest.txt"
(cd "${destination}" && sha256sum postgres.dump secrets.tar.age manifest.txt DATA_SHA256SUMS > SHA256SUMS)
chmod -R go-rwx "${destination}"
trap - EXIT
resume_services
echo "backup_id=${backup_id}"
echo "backup_path=${destination}"
