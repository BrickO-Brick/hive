# OneBrick production deployment

This bundle runs Hive as Compose project `hive`. Only the relay publishes a
host port, fixed to loopback by default (`127.0.0.1:3300`). The relay also joins
the existing `onebrick-stack_private_net` under the unique `hive-relay` alias
so the shared containerized Caddy can reach it. PostgreSQL, Redis, MinIO,
metrics, health, and agent administration remain on `hive_hive-net` and never
join the shared ingress network.

Do not copy Mantap environment files, networks, volumes, or credentials into
this stack. The optional `bricko-agent` profile is intentionally inactive until
SaGad, BrickO, persistent ChatGPT authentication, and a repository-scoped
read-only GitHub credential have been provisioned and tested.

Use the root scripts and the commands in `docs/OPERATOR_RUNBOOK.md`. Never run
`docker compose down -v`.

## BrickO-Brick repository catalog

The Repositories view inside `/app` reads repository metadata through the
authenticated relay endpoint. GitHub credentials never reach the browser.
Before deployment, set these values in the owner-only Hive environment file:

```dotenv
BUZZ_ONEBRICK_GITHUB_ORG=BrickO-Brick
BUZZ_ONEBRICK_GITHUB_TOKEN=<fine-grained read-only token>
```

Restrict the token to the `BrickO-Brick` organization, select **All
repositories**, and grant only repository **Metadata: read-only** access. Do
not grant contents, administration, pull-request, or write permissions. The
catalog endpoint fails closed with `503 Service Unavailable` when the token is
missing or still contains the template placeholder.
