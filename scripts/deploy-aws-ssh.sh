#!/usr/bin/env bash
set -euo pipefail

DEPLOY_LOCK="${HIVE_DEPLOY_LOCK:-/Users/bricko/Work/mantul-knowledge-reader-validation/scripts/shared-ec2-deploy-lock}"
SSH_KEY="${MANTAP_SSH_KEY:-/Users/bricko/Codex/AWS Mantul Server/onebrick-ec2-20260421.pem}"

[[ -x "${DEPLOY_LOCK}" ]] || {
  echo "Deploy lock is unavailable: ${DEPLOY_LOCK}" >&2
  exit 1
}
[[ -r "${SSH_KEY}" ]] || {
  echo "Approved EC2 SSH key is unavailable: ${SSH_KEY}" >&2
  exit 1
}

# The shared lock verifies the fixed production instance and serializes all
# Docker mutations. The approved key avoids renewing an AWS SSO session.
exec "${DEPLOY_LOCK}" --host mantap-ec2 --key "${SSH_KEY}" -- "$@"
