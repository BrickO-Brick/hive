#!/usr/bin/env bash
set -euo pipefail

unset OPENAI_API_KEY CODEX_API_KEY CODEX_ACCESS_TOKEN

config_source="${BRICKO_CODEX_CONFIG_SOURCE:-/etc/bricko/codex-config.toml}"
# Reconcile the non-secret, fail-closed runtime policy on every start. The
# persistent credential is auth.json; config.toml must not retain a wider mode
# from an earlier image.
install -m 0600 "${config_source}" "${CODEX_HOME:?CODEX_HOME is required}/config.toml"

if [[ ! -s "${CODEX_HOME}/auth.json" ]]; then
  echo "BrickO disabled: persistent ChatGPT authentication is absent." >&2
  exit 78
fi

if ! codex login status >/dev/null 2>&1; then
  echo "BrickO disabled: Codex authentication is invalid or expired." >&2
  exit 78
fi

exec buzz-acp
