# Agent memory

The non-empty `core` memory is injected when a channel session is created. Keep it small: only durable identity, goals, or rules that matter across most sessions and prevent repeat mistakes belong there. Aim to stay well below 10 KB.

Put durable detail that is not universally relevant in a cold `mem/<topic>` slug and load it only when needed. Remove completed work from `core`; retain detailed history in cold memory or workspace documents.

Use hash-based conflict detection for concurrent updates:

```bash
HASH=$(buzz mem hash <slug>)
buzz mem patch <slug> --base-hash "$HASH" --patch-file diff.patch
```

Exit code 5 means the value changed; reread, rebuild the patch, and retry. `mem get` writes raw bytes, `mem ls --json` returns JSON, and `mem set|patch|rm` report progress on stderr. `mem rm` cannot delete `core`; use `buzz mem set core ''`. All memory commands accept `--owner <hex-pubkey>` for explicit multi-agent ownership.
