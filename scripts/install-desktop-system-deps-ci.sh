#!/usr/bin/env bash
# Bound apt-backed CI dependency installation. The command gets two attempts;
# each receives 85 seconds to exit after TERM and is killed at 90 seconds.
set -euo pipefail

readonly apt_config=/etc/apt/apt.conf.d/99buzz-ci-bounds
readonly max_attempts=2
readonly retry_delay_seconds=5

cleanup() {
  sudo rm -f "$apt_config"
}
trap cleanup EXIT

sudo tee "$apt_config" >/dev/null <<'APT_CONFIG'
Acquire::Retries "0";
Acquire::http::Timeout "15";
Acquire::https::Timeout "15";
DPkg::Lock::Timeout "15";
APT_CONFIG

export DEBIAN_FRONTEND=noninteractive
for attempt in $(seq 1 "$max_attempts"); do
  echo "System dependency install attempt ${attempt}/${max_attempts}"
  set +e
  timeout --signal=TERM --kill-after=5s 85s "$@"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    exit 0
  fi

  if [ "$status" -ne 124 ]; then
    echo "System dependency installation failed (status ${status}); not retrying a non-timeout failure" >&2
    exit "$status"
  fi

  if [ "$attempt" -eq "$max_attempts" ]; then
    echo "System dependency installation timed out after ${max_attempts} bounded attempts" >&2
    exit "$status"
  fi

  echo "System dependency install attempt ${attempt} timed out; retrying in ${retry_delay_seconds}s" >&2
  sleep "$retry_delay_seconds"
done
