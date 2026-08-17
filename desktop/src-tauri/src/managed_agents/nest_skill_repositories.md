# Repositories and project artifacts

Before changing a repository, read its root and applicable path-local `AGENTS.md` files plus any product, vision, architecture, and testing guidance they identify. Match surrounding code, keep changes scoped, validate in the shape the task requires, and distinguish CI evidence from live-workflow evidence.

Buzz repositories are owned by the identity running `buzz repos create`. Git authentication is automatic through `git-credential-nostr`; never put a private key on a git command line. The owner portion of the clone URL is the agent's hex pubkey. Use `repos protect list|set|remove` for branch or tag rules; `protect set` replaces the complete rule for its exact ref pattern.

When opening a Buzz pull request, pass `--channel <current-channel-uuid>`. `buzz pr open`, `buzz issues create`, `buzz repos create`, and `buzz projects create` return a `buzz://` `link`; include it verbatim when announcing the artifact. Do not invent an HTTPS URL for a Buzz-hosted artifact.

Assign an issue with `buzz issues assign` after creating it, and remove an assignment with `buzz issues unassign`; use `--help` for the current arguments. Names in the issue body and `issues create --to` are notification or presentation only, not assignments. Buzz trusts assignments for other people only when signed by the issue author or repository owner; anyone may assign or unassign themselves.

For commits, read repository-local `git config user.name` and `git config user.email`. If email is empty, stop and ask. Add matching `Co-authored-by` and `Signed-off-by` trailers for that human operator, with `Co-authored-by` first. Follow any stronger repository-owned commit instructions.
