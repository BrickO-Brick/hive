# Buzz Collections

## Intention

- Give people a lightweight way to group related work and context across Buzz.
- A collection is both a navigable, searchable view for people and a named shorthand for orienting agents to the same context.

## Design decisions

- Call the object a Collection for now; it may replace Projects later if it proves to be the better model.
- A collection groups channels, repositories, tasks, threads, messages, documents, files, and arbitrary external references.
- Membership is many-to-many: an item can belong to multiple collections.
- Related content can be discovered dynamically, such as pull requests in channels and documents attached to meetings.
- Each collection has a home for navigating its contents, understanding current activity, and orienting agents.
- A collection may have an emoji or icon; otherwise it uses a neutral default glyph.
- Persisted collection operations are available to people and agents.
- Tasks do not inherently require a repository; repository relationships are optional.
- Canvases belong to channels and are not a separate member type.

## First prototype

- Keep Collections separate from Projects and local to one machine, with no relay changes.
- Share persisted state between the desktop app and CLI without reading or copying installed production data during ordinary development.
- Support adding and removing channels, repositories, repository-linked tasks, threads, messages, notes, and external references.
- Resolve source titles from their native objects when available; do not expose editable member aliases yet.
- Provide a lightweight home for overview, activity, and source management.
- Show Collection membership on associated Buzz objects; access files through their messages rather than as standalone members.

## Later ideas

- If collections prove to be the better model, replace the current Projects model and consider presenting collections as Projects.
- Allow optional alias and notes metadata on a membership.
- Support standalone tasks that do not require a repository.
- Make documents and files first-class Buzz objects that can be uploaded directly or linked from external systems and added to collections.
