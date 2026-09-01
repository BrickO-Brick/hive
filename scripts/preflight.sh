#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hive-common.sh
source "${SCRIPT_DIR}/hive-common.sh"

require_command docker
require_command git

evidence_dir="${HIVE_EVIDENCE_DIR:-${HIVE_REPO_ROOT}/docs/evidence}"
mkdir -p "${evidence_dir}"
evidence_file="${evidence_dir}/preflight-$(timestamp_utc).txt"

exec > >(tee "${evidence_file}") 2>&1

echo "=== DATE ==="
date -u +%Y-%m-%dT%H:%M:%SZ
echo "=== REPOSITORY ==="
git -C "${HIVE_REPO_ROOT}" status --short --branch
git -C "${HIVE_REPO_ROOT}" remote -v
git -C "${HIVE_REPO_ROOT}" log -1 --decorate --oneline
echo "upstream_base=$(tr -d '\n' < "${HIVE_REPO_ROOT}/UPSTREAM_BASE")"
echo "=== HOST ==="
hostname
uname -a
uname -m
if [[ -f /etc/os-release ]]; then
  cat /etc/os-release
fi
echo "=== CPU ==="
getconf _NPROCESSORS_ONLN 2>/dev/null || nproc
uptime
echo "=== MEMORY ==="
free -h 2>/dev/null || vm_stat
echo "=== DISK ==="
df -h
df -i
echo "=== DOCKER ==="
docker --version
docker compose version
timeout 15 docker system df || true
echo "=== CONTAINERS ==="
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
echo "=== NETWORKS ==="
docker network ls
echo "=== VOLUMES ==="
docker volume ls
echo "=== LISTENING PORTS ==="
if command -v ss >/dev/null 2>&1; then
  sudo -n ss -lntp 2>/dev/null || ss -lntp || true
else
  lsof -nP -iTCP -sTCP:LISTEN || true
fi
echo "=== DNS ==="
getent hosts hive.onebrick.io 2>/dev/null || dig +short hive.onebrick.io || true
echo "=== REVERSE PROXY ==="
docker ps --format '{{.Names}} {{.Image}}' | grep -Ei 'nginx|caddy|traefik|haproxy' || true
echo "=== HIVE COLLISIONS ==="
docker ps -a --format '{{.Names}}' | grep -E '(^|_)hive([_-]|$)' || true
docker network ls --format '{{.Name}}' | grep -E '^hive_' || true

echo "evidence=${evidence_file}"
