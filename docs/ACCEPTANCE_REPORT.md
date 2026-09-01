# Acceptance report

Status as of 2026-09-01: **not operational; deployment foundation verified**.

## Verified

- `BrickO-Brick/hive` exists as a OneBrick-controlled fork.
- `origin` and `upstream` point to the intended repositories.
- Upstream base is `571c1902d0ca55cfd4ccf6b91eeb731909cc10be`.
- Candidate host is `15.232.20.96`, Ubuntu 22.04 x86_64, Docker 29.4.1,
  Compose 5.1.3, with Caddy 2.11.4 owning 80/443.
- `hive.onebrick.io` now has an A record for `15.232.20.96`, matching the
  provider-verified `mantap-ec2` SSH target used by neighboring repositories.
- The shared reverse proxy is attached to `onebrick-stack_private_net`; Hive's
  relay joins only that shared ingress network under alias `hive-relay`, while
  PostgreSQL, Redis, MinIO, and the agent remain on the Hive-private network.
- Host snapshot showed 8 vCPU, 30 GiB RAM, about 17 GiB available memory, and
  508 GiB free disk; it also showed swap use and transient high n8n CPU.
- Official OpenAI documentation supports ChatGPT and device-code login with a
  persistent `CODEX_HOME`; codex-acp 1.7.0 advertises ChatGPT authentication.
- GitHub Actions run `33487985300` passed both the policy/configuration
  validation job and clean relay/BrickO-agent image builds at candidate commit
  `b91a55f8c302e3fdc7a6d996031b6b4877ec6c77`. The workflow did not publish or
  deploy either image.
- GitHub Actions run `33491199368` passed after aligning the relay with the
  established shared-EC2 ingress network contract.

## Blocked or not yet exercised

- SaGad owner public key, scoped GitHub read credential, backup age recipient,
  and server-side Codex login are unavailable.
- No production images have been built/pushed, no services deployed, no Caddy
  change made, and no functional/backup/restore/rollback acceptance case run.
- Local Docker is not running, so full image builds were verified in the
  non-deploying GitHub CI workflow rather than on the shared Mantap EC2.
- Caddy does not yet contain a Hive site block, so HTTPS currently fails before
  certificate issuance. The route is intentionally not activated before a
  healthy relay upstream exists.

No unchecked item is represented as a pass.
