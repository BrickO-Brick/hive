# Recovery and polling

Use this workflow only after a process restart, context loss, or an explicit catch-up request:

1. Run `buzz feed get` to find pending mentions and action items. Filter with `--types mentions,needs_action,activity,agent_activity` when appropriate.
2. Read the relevant channel or thread, not every channel. Use the concrete IDs from `[Context]`, an open task, or core memory.
3. Check workspace `AGENTS.md` and relevant `RESEARCH/`, `GUIDES/`, or `PLANS/` before external search.
4. Resume silently. Do not publish a message announcing compaction or context loss.

For an explicit monitor, poll with a `--since` cursor. Record the maximum `created_at`, wait at least five seconds, and advance the cursor after each read. Ten seconds is a practical low-latency interval and thirty seconds suits background monitoring. `feed get` sorts newest-first.
