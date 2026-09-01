# Acceptance report

Status as of 2026-09-01: **not operational; repository preparation in progress**.

## Verified

- `BrickO-Brick/hive` exists as a OneBrick-controlled fork.
- `origin` and `upstream` point to the intended repositories.
- Upstream base is `571c1902d0ca55cfd4ccf6b91eeb731909cc10be`.
- Candidate host is `15.232.20.96`, Ubuntu 22.04 x86_64, Docker 29.4.1,
  Compose 5.1.3, with Caddy 2.11.4 owning 80/443.
- Host snapshot showed 8 vCPU, 30 GiB RAM, about 17 GiB available memory, and
  508 GiB free disk; it also showed swap use and transient high n8n CPU.
- Official OpenAI documentation supports ChatGPT and device-code login with a
  persistent `CODEX_HOME`; codex-acp 1.7.0 advertises ChatGPT authentication.

## Blocked or not yet exercised

- DNS A/AAAA is absent for `hive.onebrick.io`.
- SaGad owner public key, scoped GitHub read credential, backup age recipient,
  and server-side Codex login are unavailable.
- No production images have been built/pushed, no services deployed, no Caddy
  change made, and no functional/backup/restore/rollback acceptance case run.
- Local Docker is not running, so full image builds are delegated to the
  non-deploying GitHub CI workflow rather than the shared Mantap EC2.
- The configured AWS CLI session is expired, so the missing Route 53 record
  cannot be created or verified authoritatively until AWS login is renewed.

No unchecked item is represented as a pass.
