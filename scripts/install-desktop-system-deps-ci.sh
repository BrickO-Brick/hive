#!/usr/bin/env bash
# Bound apt-backed CI dependency installation. The command gets two attempts;
# each receives 85 seconds to exit after TERM and is killed at 90 seconds.
set -euo pipefail

readonly apt_config=${BUZZ_APT_CONFIG:-/etc/apt/apt.conf.d/99buzz-ci-bounds}
readonly max_attempts=2
readonly attempt_timeout_seconds=${BUZZ_DEPENDENCY_TIMEOUT_SECONDS:-85}
readonly kill_grace_seconds=${BUZZ_DEPENDENCY_KILL_GRACE_SECONDS:-5}
readonly retry_delay_seconds=${BUZZ_DEPENDENCY_RETRY_DELAY_SECONDS:-5}

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
  started_at=$SECONDS
  set +e
  timeout \
    --signal=TERM \
    --kill-after="${kill_grace_seconds}s" \
    "${attempt_timeout_seconds}s" \
    "$@"
  status=$?
  set -e
  elapsed_seconds=$((SECONDS - started_at))
  if [ "$status" -eq 0 ]; then
    exit 0
  fi

  timed_out=false
  if [ "$status" -eq 124 ]; then
    timed_out=true
  elif [ "$status" -eq 137 ] && [ "$elapsed_seconds" -ge "$attempt_timeout_seconds" ]; then
    # GNU timeout returns 137 when its post-TERM grace expires. Elapsed time
    # distinguishes that case from a command that exits 137 immediately.
    timed_out=true
  fi

  if [ "$timed_out" != true ]; then
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
