# Hive OneBrick implementation plan

## Detected model

Hive is maintained as the `BrickO-Brick/hive` fork of `block/buzz`. The exact
upstream base is recorded in `UPSTREAM_BASE`; `origin` is OneBrick-controlled
and `upstream` is read-only provenance.

The target host is the existing Mantap EC2 instance at `15.232.20.96`. Caddy
2.11.4 runs in the `reverse-proxy` container and owns ports 80 and 443. Hive
therefore publishes only `127.0.0.1:3300` and uses a dedicated `hive` Compose
project, network, volumes, service account, and `/srv/hive` tree.

## Sequence and gates

1. Pin source, build inputs, runtime dependencies, and ACP adapter.
2. Validate Compose, scripts, source provenance, and secret exclusions locally.
3. Push a clean authoritative Hive revision before production deployment.
4. Re-run host resource, port, DNS, and reverse-proxy preflight.
5. Provision `/srv/hive` and stable secrets as the `hive` service account.
6. Build and record immutable relay and agent images.
7. Start the relay data plane; prove persistence and private membership.
8. Join the existing Caddy container to `hive_hive-net`, add the isolated Hive
   site block, validate with `caddy validate`, then reload without replacing any
   Mantap route.
9. Authenticate Codex in the persistent Hive `CODEX_HOME`; only then enable the
   `agent` profile.
10. Register SaGad and BrickO, create private `#bricko-lab`, and exercise the
    functional, denial, thread-isolation, restart, backup, restore, and rollback
    cases.

## Current stop conditions

- `hive.onebrick.io` has no A or AAAA answer as of 2026-09-01.
- SaGad's Nostr owner public key has not been supplied.
- A repository-scoped read-only GitHub credential has not been supplied.
- The server-side ChatGPT login has not been completed.
- Host load must be rechecked immediately before build/deploy; the shared host
  was using about 3.8 GiB swap and `n8n` showed a transient 304% CPU sample.

These conditions do not block repository preparation, but they block any claim
that Hive or BrickO is operational.
