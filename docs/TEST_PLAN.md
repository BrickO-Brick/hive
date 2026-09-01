# Test plan

## Static and build

- Shell syntax and ShellCheck for Hive scripts.
- `docker compose config --quiet` with non-secret fixture values.
- Dockerfile build for relay and agent; OCI revision/source labels inspected.
- Secret scan and dependency/image scan where tools are available.

## Runtime

- DNS points to `15.232.20.96`; TLS hostname and chain validate.
- HTTPS health and WSS upgrade succeed through Caddy.
- Only 22, 80, and 443 are public; relay is loopback; stores and metrics are
  private; no privilege, host network, Docker socket, or Mantap mount exists.
- Unknown identity cannot enumerate the workspace or private channel.
- SaGad and BrickO remain separate identities; only SaGad triggers BrickO.
- `#bricko-lab` persists across relay recreation.
- Basic identity/permissions, repository review, two-thread isolation, push
  denial, and independent relay/agent restart scenarios match the master prompt.
- Backup restores into an isolated project and rollback preserves messages,
  media, membership, and identities.
- Mantap routing and resource health remain equivalent before and after.

Use zero automatic retries. Record expected versus actual results and exact
runtime/image provenance in `docs/evidence`.
