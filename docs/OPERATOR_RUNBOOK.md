# Operator runbook

Run from `/srv/hive/source` with `HIVE_ENV_FILE=/srv/hive/secrets/hive.env`.

```bash
# start core
docker compose -p hive --env-file "$HIVE_ENV_FILE" -f deploy/onebrick/compose.yml up -d --wait postgres redis minio minio-init relay

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
