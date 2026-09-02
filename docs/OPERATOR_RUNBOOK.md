# Operator runbook

Run from `/srv/hive/source` with `HIVE_ENV_FILE=/srv/hive/secrets/hive.env`.

Every production Docker mutation on the shared EC2 must be run through the
governed OneBrick shared deploy lock from an authorized operator workstation:

```bash
/Users/bricko/Work/mantul-knowledge-reader-validation/scripts/shared-ec2-deploy-lock \
  --host mantap-ec2 -- bash -lc '<one or more commands below>'
```

Read-only status and log checks may use SSH directly. Never run concurrent
Compose mutations outside the lock.

```bash
# start core (PostgreSQL is external RDS; local Postgres is operations/test only)
docker compose -p hive --env-file "$HIVE_ENV_FILE" -f deploy/onebrick/compose.yml up -d --wait redis minio minio-init relay

# stop without deleting state
docker compose -p hive --env-file "$HIVE_ENV_FILE" -f deploy/onebrick/compose.yml down

# status, logs, health
docker compose -p hive --env-file "$HIVE_ENV_FILE" -f deploy/onebrick/compose.yml ps
docker compose -p hive --env-file "$HIVE_ENV_FILE" -f deploy/onebrick/compose.yml logs --tail 200 relay
scripts/healthcheck.sh

# backup and isolated restore test
AGE_RECIPIENT='<governed age recipient>' scripts/backup.sh
scripts/restore-test.sh /srv/hive/backups/<backup-id>

# upgrade and rollback
AGE_RECIPIENT='<governed age recipient>' scripts/upgrade.sh 'ghcr.io/bricko-brick/hive@sha256:<digest>'
HIVE_ROLLBACK_BACKUP='/srv/hive/backups/<backup-id>' HIVE_ROLLBACK_CONFIRM=rollback-hive-preserve-volumes scripts/rollback.sh 'ghcr.io/bricko-brick/hive@sha256:<previous-digest>'

# membership
docker compose -p hive --env-file "$HIVE_ENV_FILE" -f deploy/onebrick/compose.yml exec relay buzz-admin add-member --pubkey '<pubkey>'
docker compose -p hive --env-file "$HIVE_ENV_FILE" -f deploy/onebrick/compose.yml exec relay buzz-admin remove-member --pubkey '<pubkey>'

# restart BrickO only
docker compose -p hive --profile agent --env-file "$HIVE_ENV_FILE" -f deploy/onebrick/compose.yml restart bricko-agent
```

For headless ChatGPT authentication, keep the agent stopped and run the exact
agent image interactively as UID 10001 with `/srv/hive/secrets/codex-home`
mounted at `/var/lib/bricko/.codex`, then run `codex login --device-auth`.
Confirm with `codex login status`; never paste or log `auth.json`. Official
guidance: <https://developers.openai.com/codex/auth>.

To create `#bricko-lab`, authenticate the Buzz CLI as SaGad and run:

```bash
buzz channels create --name bricko-lab --type stream --visibility private
```

Record the returned channel ID, then use the Desktop membership UI or the
current Buzz membership command to add only BrickO. Re-check command help
against the pinned revision before use; private-channel membership APIs are
still evolving.

## Mantap SSO and web chat

The relay expects `BUZZ_MANTAP_SSO_SHARED_SECRET` and
`BUZZ_MANTAP_SSO_CHANNEL_ID` in the owner-only Hive environment file. The
secret must exactly match Mantap backend's `MANTUL_HIVE_SSO_SHARED_SECRET`; the
channel ID is the private `#bricko-lab` UUID. Never put either secret in a URL,
image, or tracked file.

An authenticated Mantap user launches **Open Hive**. Mantap issues a 45-second
single-use ticket in the URL fragment, and the browser exchanges it with a
NIP-98 proof from a browser-local key. The relay binds the Mantap subject to the
browser's Nostr key, synchronizes the signed Mantap access claim into Hive
workspace membership, and adds ordinary channel membership. A user can then
return to `/app` from the same browser. A fresh browser creates a separate key
bound to the same Mantap subject; subsequent exchanges synchronize the subject's
role across every bound key. Remove lost or retired device keys through the
governed membership workflow.

## RDS authority and restore credentials

Production `DATABASE_URL` points to a DML-only RDS runtime role and uses
`sslmode=verify-full` with the CA mounted from
`/srv/hive/secrets/rds-global-bundle.pem`. The relay never receives the
DDL-capable migration credential. Backups use the runtime role. A destructive
restore requires a temporary owner-only environment file whose `DATABASE_URL`
uses the database owner/migration role; run it only under the shared deploy
lock, then remove that temporary credential and restore the runtime URL before
starting Hive.

Mantap is authoritative for Hive workspace RBAC during SSO provisioning:
`editor` and `admin` map to Hive `owner`; `reader` maps to ordinary Hive
`member`. A subject's role is synchronized across all of its bound browser
keys on every successful ticket exchange.
