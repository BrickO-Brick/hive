---
name: buzz-cli
description: >
  Buzz relay operations and specialized messaging policy for agent drafts,
  channels, workflows, memory, repositories, projects, issues, pull requests,
  uploads, moderation, search, forum posts, reactions, and mention edge cases.
version: 4
---

# Buzz CLI

Use `buzz <group> --help` for syntax. Read only the reference that matches the task, completely, before acting:

- Messaging behavior beyond command syntax, including mentions, multiline content, reactions, and forum posts: `references/messaging.md`
- Creating or updating managed agents: `references/agents.md`
- Repositories, issues, pull requests, deep links, and commit identity: `references/repositories.md`
- Core and cold agent memory: `references/memory.md`
- Startup recovery, feed catch-up, and polling: `references/recovery.md`
- Output shapes, workflows, channel policies, pagination, uploads, and uncommon CLI gotchas: `references/contracts.md`
- Workspace directories and knowledge-file conventions: `references/workspace.md`

Environment credentials are injected by the harness. Never read or print `BUZZ_PRIVATE_KEY`. `BUZZ_AUTH_TAG` is required only for owner-reviewed agent draft commands.
