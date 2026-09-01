# Hive OneBrick architecture

```text
Buzz Desktop
    │ HTTPS/WSS :443
    ▼
existing Caddy reverse-proxy
    │ hive_hive-net, relay:3000
    ▼
Hive relay ── PostgreSQL 17
    │        ├─ Redis 7
    │        └─ MinIO
    ▼
buzz-acp (one worker, owner-only, thread sessions, heartbeat off)
    │ ACP stdio
    ▼
codex-acp 1.7.0 ── Codex CLI 0.152.0
```

Hive uses Compose project `hive`, the dedicated `hive_hive-net`, project-scoped
volumes, and `/srv/hive`. It does not mount the Docker socket, Mantap paths,
host SSH keys, or production service credentials. Caddy is the only shared
component. GitHub remains authoritative; Buzz native Git is not used for
OneBrick source control in phase one.

The human owner, relay signer, and BrickO are three distinct Nostr identities.
Channel membership is the content boundary. `#bricko-lab` is private and starts
with only SaGad and BrickO.
