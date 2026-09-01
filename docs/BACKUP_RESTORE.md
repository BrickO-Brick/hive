# Backup and restore

`scripts/backup.sh` pauses the relay, takes a PostgreSQL custom-format dump,
captures Redis, MinIO, and Buzz Git state, encrypts the stable environment with
age, records source/image provenance, hashes the manifest, and then resumes the
relay. `AGE_RECIPIENT` is mandatory.

A backup is not ready until `scripts/restore-test.sh <absolute-backup-path>`
passes in an isolated Compose project. Test volumes are intentionally retained
for audit and must be removed later by exact name after review; no script uses
`docker compose down -v`.

Production restore requires the exact confirmation string printed by
`scripts/restore.sh`. Restore changes only Hive project volumes. It never
touches Mantap volumes or rewrites the environment automatically. Codex auth is
included only through the separately governed secret backup policy; do not copy
mutable login caches to multiple concurrent runners.
