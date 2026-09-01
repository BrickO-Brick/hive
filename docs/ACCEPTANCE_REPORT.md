# Acceptance report

Status as of 2026-09-01: **Hive backend and BrickO are operational**. The
official, notarized Buzz Desktop 0.5.20 is installed locally; SaGad identity
import and the resulting Desktop UI session remain the only manual acceptance
step because they require handling the owner's private identity key.

## Executive result

- `https://hive.onebrick.io` and `wss://hive.onebrick.io` are live behind the
  existing shared Caddy proxy.
- The private relay, PostgreSQL, Redis, MinIO, and BrickO agent are healthy in
  the dedicated `hive` Compose project.
- SaGad is the relay and `#bricko-lab` owner. BrickO is a separate bot member.
- A real SaGad mention reached BrickO through `buzz-acp` and `codex-acp` 1.7.0,
  and a ChatGPT-authenticated Codex turn returned the response.
- BrickO successfully inspected only `/workspace/hive`; the Docker bind and
  container root filesystem enforce read-only access.
- Backup, isolated restore, immutable-image upgrade, rollback, and final
  redeployment all completed without deleting persistent volumes.

## Exact provenance

| Item | Value |
|---|---|
| Upstream Buzz base | `571c1902d0ca55cfd4ccf6b91eeb731909cc10be` |
| Relay image | `ghcr.io/bricko-brick/hive@sha256:8589f840d0f45d7f39c14a7df3149547a48f3905095c35f265a43d88b010a478` |
| Agent image | `ghcr.io/bricko-brick/hive-agent@sha256:ffdd685d104be96701fe8f75a3682c16a7d147c702916fd29319c24316794e1c` |
| `codex-acp` | `1.7.0` |
| Publish workflow | GitHub Actions run `33497180391` |
| Coordinated backup | `/srv/hive/backups/hive-20260901T110909Z` |
| Isolated restore | project `hive-restore-103641`, PASS |

The authoritative Hive commit is recorded in the final release manifest after
this report commit is pushed. The runtime repository revision used by the
BrickO read test was `7c07783a486ff8f66f636593d44e0546cdc409d1`.

## Acceptance results

### Infrastructure — PASS

- DNS A record resolved to the provider-verified EC2 address `15.232.20.96`.
- HTTPS health returned 200 with HSTS and security headers.
- TLS certificate subject and SAN are `hive.onebrick.io`, issued by Let's
  Encrypt YE2, valid 2026-09-01 through 2026-11-30.
- A raw HTTP/1.1 WebSocket upgrade returned `101 Switching Protocols` and the
  relay emitted a NIP-42 `AUTH` challenge.
- Caddy configuration validation passed; reverse-proxy restart count remained
  zero. `https://mantap.onebrick.io/` continued to return 200.
- Relay is exposed only as `127.0.0.1:3300->3000`. PostgreSQL 5432, Redis 6379,
  MinIO 9000, health 8080, and metrics 9102 have no host publication.
- No Hive container is privileged, uses host networking, mounts the Docker
  socket, or mounts a Mantap directory.
- Final sampled memory use was approximately 8 MiB relay, 93 MiB PostgreSQL,
  5 MiB Redis, 76 MiB MinIO, and 3 MiB idle agent.

### Private Hive workspace — PASS

- `#bricko-lab` ID `62ae672f-ab7b-4619-b013-13eec0111943` exists after relay
  restart, upgrade, rollback, and final redeployment.
- Its exact membership remained SaGad as `owner` and BrickO as `bot`.
- An ephemeral unknown identity received HTTP 403
  `relay_membership_required` when requesting the private channel.
- Existing messages and BrickO replies remained readable after all restart and
  rollback operations.

### BrickO — PASS

- BrickO uses a dedicated identity, one worker, per-thread sessions,
  `owner-only` inbound policy, lazy pool, and heartbeat zero.
- The agent container runs non-root, unprivileged, with read-only rootfs and
  `/workspace:ro`; it has no Docker socket, SSH key, Mantap, production DB, or
  GitHub write credential.
- `codex login status` reported `Logged in using ChatGPT` before and after an
  intentional agent restart. An empty Codex home reported `Not logged in` and
  exited non-zero.
- BrickO read the exact repository HEAD and `package.json` name, and confirmed
  the production Compose file exists. An attempted OS-level write probe failed
  with `Read-only file system` and left no file behind.
- Two independent threads retained only their own markers: `ARCH-ALPHA` and
  `QA-BETA`.
- A request to create and push a commit was explicitly refused; no repository
  mutation occurred.
- Relay restarts caused autonomous reconnect and resubscription to exactly one
  channel. Agent restart count remained zero outside intentional restarts.

### Data safety — PASS with scoped limitation

- Backup `/srv/hive/backups/hive-20260901T102925Z` completed and its encrypted
  secrets archive was decrypted and enumerated with the governed recovery key
  without exposing secret contents.
- Isolated restore project `hive-restore-103641` restored PostgreSQL, Redis,
  MinIO, Git state, configuration, and Codex auth successfully.
- A fresh coordinated backup `/srv/hive/backups/hive-20260901T110909Z` preceded
  the release rehearsal.
- Runtime upgraded from relay digest `226881…` to `8589f8…`, rolled back to
  `226881…`, then returned to `8589f8…`; health, membership, and messages
  remained intact. This validates the prescribed volume-preserving rollback
  path. It does not simulate a schema-incompatible future downgrade.

## Not yet passed

- **Desktop owner session:** Buzz Desktop 0.5.20 is installed and its Developer
  ID/notarization are verified, but importing the SaGad private identity into
  the Desktop requires explicit user approval at the sensitive-data entry step.
- **Media recreation:** object storage was included in backup/restore, but a
  user-visible upload/download round trip was not exercised.
- **OpenObserve forwarding:** bounded local Docker logs and documented metrics
  exist; centralized forwarding was not enabled because no scoped collector
  credential or approved endpoint was provided.
- **Private unapproved repository denial:** no broad or private GitHub
  credential is installed, so private access fails closed. Public Internet
  repository visibility is not a private-repository authorization boundary.
- **Image/dependency scanning:** CI build and secret-policy checks passed;
  Docker Scout, Trivy, and `cargo audit` were unavailable in the deployment
  environment and are not represented as passes.

No unchecked item is represented as a pass. Full sanitized command evidence is
in `docs/evidence/acceptance-20260901T111300Z.md`.
