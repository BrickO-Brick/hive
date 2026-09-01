# Upstream synchronization

```bash
git fetch --prune upstream main
git log --oneline --left-right main...upstream/main
git switch -c upstream-sync/<date> main
git merge --no-commit --no-ff upstream/main
```

Inspect every conflict and migration. Update `UPSTREAM_BASE` only to the exact
reviewed upstream commit. Run focused Rust tests, Compose validation, image
build, migration checks, relay/ACP integration tests, and the full acceptance
plan in a non-production namespace. Build immutable images from the pushed Hive
commit, scan them, back up production, deploy the exact digest, and validate
WSS plus persistence. Never auto-merge upstream.

Rollback selects the recorded prior image digest and preserves volumes. If the
new release applied an irreversible migration, stop and restore the coordinated
backup into an isolated namespace before any production action.
