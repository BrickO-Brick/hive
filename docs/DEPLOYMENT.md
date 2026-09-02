# Deployment

## Prerequisites

- A clean, pushed `BrickO-Brick/hive` revision.
- A/AAAA for `hive.onebrick.io` pointing to the intended EC2.
- SaGad's 64-hex Nostr public key.
- Immutable relay and agent image digests in GHCR.
- Owner-only `/srv/hive/secrets/hive.env`, an external RDS `DATABASE_URL`,
  the RDS CA bundle, and an encrypted backup recipient.
- Caddy configured to join `hive_hive-net`; no Hive service joins a Mantap
  network.

## Host layout

```text
/srv/hive/source
/srv/hive/deploy
/srv/hive/secrets/codex-home
/srv/hive/backups
/srv/hive/agent-workspaces
/srv/hive/logs/bricko-agent
/srv/hive/state/releases
```

Create a locked `hive` Linux service account and make only that account the
owner of `/srv/hive`. Run `scripts/preflight.sh` before any build or deployment.
Stop if DNS is absent, port 3300 is occupied, the host is under sustained CPU or
memory pressure, or the proxy cannot be changed and rolled back independently.

Build with `scripts/build-images.sh`; set `HIVE_PUSH_IMAGES=true` only after GHCR
authentication and package permission have been verified. Resolve the published
digests, provision stable secrets once with `scripts/bootstrap-secrets.sh`, then
run `scripts/deploy.sh`.

Before enabling public ingress, add `deploy/onebrick/Caddyfile.hive` as an
isolated site block to the existing Caddy configuration, add the external
`hive_hive-net` network to the `reverse-proxy` service in the authoritative
OneBrick stack, run `caddy validate`, and retain a timestamped backup and exact
rollback command. Never replace the whole Caddyfile.
