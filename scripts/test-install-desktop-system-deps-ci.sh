#!/usr/bin/env bash
# Linux regression coverage for the outer timeout/retry contract.
set -euo pipefail

if [ "$(uname -s)" != Linux ]; then
  echo "This harness requires Linux and GNU timeout" >&2
  exit 1
fi

tmp=$(mktemp -d)
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

cat > "$tmp/sudo" <<'SUDO'
#!/usr/bin/env bash
exec "$@"
SUDO
cat > "$tmp/attempt" <<'ATTEMPT'
#!/usr/bin/env bash
mode=$1
count_file=$2
count=0
[ ! -f "$count_file" ] || count=$(cat "$count_file")
echo $((count + 1)) > "$count_file"
case "$mode" in
  success) exit 0 ;;
  quick-137) exit 137 ;;
  cooperative-timeout) sleep 10 ;;
  forced-kill-timeout)
    trap '' TERM
    while :; do sleep 1; done
    ;;
  *) exit 99 ;;
esac
ATTEMPT
chmod +x "$tmp/sudo" "$tmp/attempt"

run_case() {
  local mode=$1
  local expected_status=$2
  local expected_attempts=$3
  local count_file="$tmp/${mode}.count"

  set +e
  PATH="$tmp:$PATH" \
    BUZZ_APT_CONFIG="$tmp/${mode}.apt.conf" \
    BUZZ_DEPENDENCY_TIMEOUT_SECONDS=1 \
    BUZZ_DEPENDENCY_KILL_GRACE_SECONDS=1 \
    BUZZ_DEPENDENCY_RETRY_DELAY_SECONDS=0 \
    scripts/install-desktop-system-deps-ci.sh "$tmp/attempt" "$mode" "$count_file"
  local status=$?
  set -e

  if [ "$status" -ne "$expected_status" ]; then
    echo "$mode: expected status $expected_status, got $status" >&2
    exit 1
  fi
  if [ "$(cat "$count_file")" -ne "$expected_attempts" ]; then
    echo "$mode: expected $expected_attempts attempt(s), got $(cat "$count_file")" >&2
    exit 1
  fi
  if [ -e "$tmp/${mode}.apt.conf" ]; then
    echo "$mode: apt config was not cleaned up" >&2
    exit 1
  fi
  echo "$mode: PASS (status $status, attempts $expected_attempts)"
}

run_case success 0 1
run_case quick-137 137 1
run_case cooperative-timeout 124 2
run_case forced-kill-timeout 137 2
