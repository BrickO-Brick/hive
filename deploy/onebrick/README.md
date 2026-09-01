# OneBrick production deployment

This bundle runs Hive as Compose project `hive`. Only the relay publishes a
host port, fixed to loopback by default (`127.0.0.1:3300`). PostgreSQL, Redis,
MinIO, metrics, health, and agent administration remain on `hive_hive-net`.

Do not copy Mantap environment files, networks, volumes, or credentials into
this stack. The optional `bricko-agent` profile is intentionally inactive until
SaGad, BrickO, persistent ChatGPT authentication, and a repository-scoped
read-only GitHub credential have been provisioned and tested.

Use the root scripts and the commands in `docs/OPERATOR_RUNBOOK.md`. Never run
`docker compose down -v`.
