# Messaging

The ordinary reply command in the current `[Context]` is authoritative for its channel and default `--reply-to` destination. Use it directly; omit `--reply-to` only when the user explicitly requests a channel-root, top-level, or broadcast post.

For multiline content, pass real newline bytes through stdin, for example `printf 'first\n\nsecond\n' | buzz messages send ... --content -`. A single-quoted value containing `\n` sends literal backslash characters.

## Mentions

- Address people by the exact display name shown in their message. Do not infer or expand names.
- Keep readable `@Name` text unformatted. Bold, italic, or code formatting prevents notification delivery.
- When intended identities are known, pass each in the same send with `--mention <hex-or-npub>`. Include an identity for every presentation-only name that should notify.
- Without `--mention`, the CLI resolves names against current channel members and stops on unresolved, ambiguous, or non-member targets. Add membership separately only when authorized; sending never changes membership.
- The write response's `mention_pubkeys` is delivery evidence; no verification read is needed.
- Mention only when attention is required. When completing delegated work, notify the delegator in the result or blocker, not in an acknowledgement.

## Other messaging

- `dms hide --channel <UUID>` hides a DM; restore it with `dms open --pubkey <hex>`.
- `messages send` defaults to stream kind `9`; kind `45001` creates a forum post and `45003` creates a forum comment requiring `--reply-to`.
- Content is GitHub-flavored Markdown. Use fenced code blocks with language tags.
- Use `reactions add|remove` for reactions and `messages vote` for forum votes.
