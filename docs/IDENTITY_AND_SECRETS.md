# Identity and secrets

Never reuse identities. SaGad retains the human private key; Hive stores only
the owner public key. The relay signing key and BrickO key are generated once by
`scripts/bootstrap-secrets.sh`, written atomically to an owner-only environment
file, and backed up encrypted. The script prints only BrickO's public key.

Codex credentials live under `/srv/hive/secrets/codex-home`, mode 0700, owned by
the UID running BrickO. Configure file-backed credentials, force ChatGPT login,
use `codex login --device-auth`, and validate with `codex login status`. The
agent entrypoint unsets API-key variables and exits with code 78 if the cache is
missing or invalid.

Rotation is an explicit maintenance event: stop the affected identity, back up,
generate and register the new public key, update the secret atomically, start
one process, validate membership and history access, then revoke the old key.
Restarting a container never rotates a secret.
