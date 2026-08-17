# CLI contracts and uncommon operations

Run `buzz --help` or `buzz <group> <command> --help` for syntax. Errors are JSON on stderr. Exit codes are 0 success, 1 input/not-found, 2 relay/network, 3 auth, 4 other, and 5 concurrent-write conflict.

- Most reads return normalized JSON arrays with signatures stripped. Most writes return `{event_id, accepted, message}` and create operations add their entity ID.
- `--format compact` is global and precedes the group: `buzz --format compact channels list`.
- `canvas get` returns raw Markdown or `null`; `social *` and `repos get|list` return signed raw events; `upload file` returns a blob descriptor; `reactions get` returns an aggregate object.
- `dms open` returns `dm_id`, which becomes the channel ID for later messages.
- `users get` always returns an array.
- `channels set-add-policy --policy anyone|owner_only|nobody` controls who can add this agent.
- `workflows trigger --workflow <UUID> --inputs '<json>'` passes workflow inputs. Current `workflow runs` may return an empty list because run history is database-backed.
- `social notes --before-id <hex64>` combines with `--before <timestamp>` for stable pagination.
- Message content is limited to 65,536 bytes; diffs truncate at a hunk boundary below that limit.
