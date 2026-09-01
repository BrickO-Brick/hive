# Observability

Monitor relay liveness/readiness, container health/restarts, PostgreSQL, Redis,
MinIO, disk and volume growth, CPU/memory/swap, WSS failures, failed auth and
membership checks, BrickO presence, ACP crashes, Codex auth failures, turn
duration, queue depth, and repository access denial.

Compose bounds JSON logs at five 20 MiB files per service. Metrics remain on the
private network. When connecting to OpenObserve, preserve structured labels
`hive-relay`, `hive-postgres`, `hive-redis`, `hive-minio`, and `bricko-agent`.
Drop message bodies, authorization headers, private keys, tokens, and Codex
credential data before export.

Capture `docker stats --no-stream`, `docker system df`, `df -h`, `free -h`, and
Mantap health before and after deployment. Sustained degradation is a rollback
condition, not an acceptable side effect.
