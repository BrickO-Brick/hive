#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hive-common.sh
source "${SCRIPT_DIR}/hive-common.sh"

owner_pubkey="${1:?Usage: bootstrap-secrets.sh <SaGad 64-hex public key>}"
[[ "${owner_pubkey}" =~ ^[0-9a-fA-F]{64}$ ]] || {
  echo "Owner public key must be exactly 64 hexadecimal characters." >&2
  exit 1
}
target="${HIVE_ENV_FILE}"
[[ ! -e "${target}" ]] || {
  echo "Refusing to overwrite stable Hive secrets: ${target}" >&2
  exit 1
}

image="${HIVE_BOOTSTRAP_IMAGE:?Set HIVE_BOOTSTRAP_IMAGE to an immutable relay image digest}"
[[ "${image}" =~ @sha256:[0-9a-f]{64}$ ]] || exit 1
agent_image="${HIVE_BOOTSTRAP_AGENT_IMAGE:?Set HIVE_BOOTSTRAP_AGENT_IMAGE to an immutable agent image digest}"
[[ "${agent_image}" =~ @sha256:[0-9a-f]{64}$ ]] || exit 1
tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT
umask 077

docker run --rm --entrypoint /usr/local/bin/buzz-admin "${image}" generate-key > "${tmp_dir}/relay-key"
docker run --rm --entrypoint /usr/local/bin/buzz-admin "${image}" generate-key > "${tmp_dir}/bricko-key"
relay_private="$(awk '/Secret key:/ {print $3}' "${tmp_dir}/relay-key")"
bricko_private="$(awk '/Secret key:/ {print $3}' "${tmp_dir}/bricko-key")"
bricko_public="$(awk '/Public key:/ {print $3}' "${tmp_dir}/bricko-key")"
[[ "${relay_private}" =~ ^[0-9a-f]{64}$ && "${bricko_private}" =~ ^[0-9a-f]{64}$ ]] || {
  echo "buzz-admin returned an unexpected key format." >&2
  exit 1
}

install -d -m 0700 "$(dirname "${target}")"
template="${HIVE_DEPLOY_DIR}/.env.example"
sed \
  -e "s#^HIVE_IMAGE=.*#HIVE_IMAGE=${image}#" \
  -e "s#^HIVE_AGENT_IMAGE=.*#HIVE_AGENT_IMAGE=${agent_image}#" \
  -e "s/^RELAY_OWNER_PUBKEY=.*/RELAY_OWNER_PUBKEY=${owner_pubkey,,}/" \
  -e "s/^BUZZ_RELAY_PRIVATE_KEY=.*/BUZZ_RELAY_PRIVATE_KEY=${relay_private}/" \
  -e "s/^BRICKO_PRIVATE_KEY=.*/BRICKO_PRIVATE_KEY=${bricko_private}/" \
  -e "s/^BUZZ_GIT_HOOK_HMAC_SECRET=.*/BUZZ_GIT_HOOK_HMAC_SECRET=$(openssl rand -hex 32)/" \
  -e "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 32)/" \
  -e "s/^REDIS_PASSWORD=.*/REDIS_PASSWORD=$(openssl rand -hex 32)/" \
  -e "s/^BUZZ_S3_ACCESS_KEY=.*/BUZZ_S3_ACCESS_KEY=$(openssl rand -hex 16)/" \
  -e "s/^BUZZ_S3_SECRET_KEY=.*/BUZZ_S3_SECRET_KEY=$(openssl rand -hex 32)/" \
  "${template}" > "${tmp_dir}/hive.env"
install -m 0600 "${tmp_dir}/hive.env" "${target}"
echo "Hive secrets created once at ${target}."
echo "BrickO public key: ${bricko_public}"
echo "Back up the secret file before starting the stack."
