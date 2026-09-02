#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hive-common.sh
source "${SCRIPT_DIR}/hive-common.sh"
require_hive_env

bind="$(sed -n 's/^HIVE_HTTP_BIND=//p' "${HIVE_ENV_FILE}")"
bind="${bind:-127.0.0.1:3300}"
host_port="${bind##*:}"

hive_compose ps
curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:${host_port}/health"
echo

services=(relay redis minio)
if [[ "${HIVE_EXPECT_LOCAL_POSTGRES:-false}" == true ]]; then
  services+=(postgres)
fi
for service in "${services[@]}"; do
  cid="$(hive_compose ps -q "${service}")"
  [[ -n "${cid}" ]] || { echo "Missing service: ${service}" >&2; exit 1; }
  state="$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "${cid}")"
  echo "${service}: ${state}"
  [[ "${state}" == running\ healthy* ]] || exit 1
  privileged="$(docker inspect --format '{{.HostConfig.Privileged}}' "${cid}")"
  socket_mounts="$(docker inspect --format '{{range .Mounts}}{{.Source}} {{end}}' "${cid}" | grep -c '/var/run/docker.sock' || true)"
  [[ "${privileged}" == false && "${socket_mounts}" == 0 ]] || {
    echo "Unsafe container configuration detected for ${service}." >&2
    exit 1
  }
done

published="$(docker inspect --format '{{json .NetworkSettings.Ports}}' "$(hive_compose ps -q relay)")"
echo "relay_ports=${published}"
[[ "${published}" == *'127.0.0.1'* ]] || {
  echo "Relay is not restricted to loopback." >&2
  exit 1
}
