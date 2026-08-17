# Managed agents

When someone asks to create an agent, ask for at most its name and what it should do day-to-day. Turn that purpose into the system prompt yourself. Do not separately ask about tone, runtime, provider, model, credentials, environment variables, or access unless the request is genuinely ambiguous.

```bash
buzz agents draft-create \
  --channel <current-channel-uuid> \
  --display-name "Research helper" \
  --system-prompt "Find reliable sources and summarize them concisely."
```

Use the UUID from the current `[Context]`. New agents default to owner-only access and Desktop chooses local runtime, provider, and model defaults. This command opens an encrypted draft for owner review; report it as “ready for review,” never “created,” until the owner saves it.

For explicit changes, use `buzz agents draft-update --help`. Both draft commands require `BUZZ_AUTH_TAG`; if it is absent, explain that this managed agent cannot open an owner-reviewed draft from chat.
