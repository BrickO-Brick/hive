# Security model

## Trust boundaries

- Caddy terminates TLS/WSS; the relay is reachable from the host only on
  `127.0.0.1:3300` and from Caddy on `hive_hive-net`.
- Closed relay membership and private channel membership gate content.
- SaGad, relay, and BrickO use separate stable Nostr keys.
- BrickO starts with one worker, admits authors only after relay and private
  channel membership checks, requires an explicit mention, uses thread-scoped
  sessions, disables heartbeat, and runs Codex in `read-only` mode.
- PostgreSQL, Redis, MinIO, health, metrics, and agent control have no published
  ports.
- Containers drop Linux capabilities, set `no-new-privileges`, have PID/CPU/RAM
  limits, and use bounded logs. No service is privileged or mounts Docker.

## GitHub

Use a GitHub App or fine-grained token installed only on one approved repository
with Contents, Metadata, PRs, Issues, and Actions read permissions. Do not use
the current operator's broad personal token. Credential enforcement—not a
prompt—is the write-denial boundary.

## Residual risks

Buzz is fast-moving pre-production software. The shared EC2 creates a resource
and proxy blast-radius risk. ChatGPT cached login data is a bearer credential.
The agent can read any file mounted into its workspace. Caddy network membership
must be maintained in the authoritative OneBrick stack. These risks require
resource gates, encrypted backup, minimal mounts, and acceptance testing after
every upgrade.
