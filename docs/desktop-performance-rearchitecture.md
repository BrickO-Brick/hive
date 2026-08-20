# Desktop performance rearchitecture

Status: implementation contract, milestone 0

Buzz Desktop will move from renderer-owned relay state and network-backed message
queries to a native Rust data plane with a durable local replica. The migration
is a strangler: the current path remains authoritative while additive native
components run dormant, then in shadow, before each read surface cuts over.

This document is normative for implementation sequencing and release safety. It
complements the existing channel-window wire contract in
[`docs/bridge-channel-window.md`](bridge-channel-window.md); it does not change
NIP-CW ordering, cursor, summary, or auxiliary-closure semantics.

## Success criteria

The shipped desktop app should:

- paint the last-known sidebar and channel state without waiting for the relay;
- reach stable first paint for a warm channel switch below 100 ms at p95 on the
  named reference device and build as a product objective, promoting that number
  to a release gate only after milestone 0 proves it against packaged current
  main;
- remain responsive during cold channel entry, live event storms, pagination,
  and reconnect;
- preserve timeline position continuously through prepend, backdated insert,
  late row growth, target navigation, and channel restoration;
- bound loaded rows, mounted DOM, retained nodes, native and webview memory,
  replica disk growth, and IPC queue pressure; and
- use one native authenticated relay session after all feature cutovers.

Absolute budgets beyond the warm-switch target are set from milestone 0's
packaged-build baseline. A budget is not valid unless it names hardware, macOS,
app commit/build, data fixture, run count, and percentile method.

## Release contract

Every slice has three independent gates:

1. **Merge-safe:** focused tests pass; additive code is dormant by default;
   migrations are transactional and compatible with existing data; failure
   cannot perturb the legacy path.
2. **Release-safe:** the shipped binary is correct with the feature disabled;
   shadow work has explicit CPU, memory, disk, and IPC limits; an unavailable,
   corrupt, or newer replica fails open to legacy reads and never blocks app
   startup.
3. **Cutover-safe:** shadow comparison and packaged-app evidence pass; the
   surface has a runtime kill switch and automatic legacy fallback; rollback
   cannot lose or duplicate user state. Any comparison lane that reports queue
   overflow, version gaps, or missing evidence is invalid, not a pass.

A red cutover gate leaves the new path off and does not prevent unrelated safe
work from shipping. A legacy implementation is not deleted in the same release
that first makes its replacement authoritative. Keep fallback for at least one
proven release cycle, then remove it in a later, separately reversible slice.

`replica.db` is rebuildable relay-derived state. An older app ignores an unknown
or newer replica and may recreate its own compatible database. The durable
outbox is the exception: once introduced, it is non-rebuildable user state and
gets an independent cutover with one authoritative sender, stable event IDs,
idempotent retry, restart proof, and duplicate-free rollback.

## Target boundaries

### Native relay fan-out

`RelaySession` becomes the one socket owner for a `(relay, identity)` scope.
Finite `fetch_events` requests remain separately multiplexed and are not routed
through persistent fan-out.

Persistent consumers register through an opaque lease. Registration is
non-destructive; lease drop/unregister is idempotent; scope replacement and
session shutdown close every consumer exactly once. Each consumer has its own
bounded queue and declared delivery policy:

- **durable ingest/archive:** ordered, lossless delivery; backpressure is
  explicit and cannot be converted into silent drops;
- **shadow comparison:** bounded; lag or overflow is observable, invalidates the
  comparison window, and never stalls or damages durable delivery; and
- **renderer projection deltas:** bounded and coalescing/invalidate-capable;
  renderer slowness never stalls durable storage.

The socket loop must not await independent consumers sequentially. Tests cover
ordered dual delivery, a slow/overflowing shadow beside lossless archive
traffic, unregister during a blocked send, same-scope remount, scope teardown,
finite-fetch coexistence, reconnect, and CLOSED/rate-limit recovery.

### Replica ownership and transactions

Use a standalone SQLite WAL database, `replica.db`, scoped by the canonical
relay/community identity (not raw URL spelling) and signer identity. Alias URLs
for the same community resolve to one store; different communities or signers
never share one. Do not reuse `archive.db`: archive authorization, retention,
and ownership are different contracts. The replica has one writer and a
versioned, marker-guarded migration ledger. Each migration and marker commit in
one transaction and is safe to rerun after a crash.

A verified event is applied in one transaction containing:

1. event-ID dedupe;
2. canonical event and tag indexes;
3. deletions/tombstones and auxiliary closure inputs;
4. affected sidebar, channel-window, and thread projection rows; and
5. only those coverage intervals proved by the same fetch/ingest operation.

Deletion facts are order-independent. A deletion whose target is not yet stored
creates a durable pending tombstone keyed by target event ID, retaining the
signed deletion event and every reference needed to validate and resolve it.
When the target later arrives, the writer resolves its canonical channel and
applies the target, tombstone, affected projections, and pending-record
resolution atomically, so delete-before-target cannot resurrect a row. A
target-before-delete follows the same final-state transaction contract.
Channel-less deletion events inherit scope only from the resolved target; the
absence of an `h` tag is never treated as evidence that the target is global.
Pending tombstones survive crash/restart and replica reopen. Coverage cannot
advance across a fetch window while any deletion fact required by its predicate
remains unresolved; it may lag until the target is fetched or the relay page
proves resolution under an explicit protocol rule. Replica acceptance tests
cover target-before-delete and delete-before-target, including a channel-less
deletion, with process termination before and after each transaction boundary
and successful resolution after restart.

A renderer delta is emitted only after that transaction commits. Commit without
delta is repaired by the next projection read or version invalidation; delta
without commit is forbidden.

### Coverage

Coverage is a set of proved composite-key ranges, not "highest created_at
seen." Channel-window order remains `(created_at DESC, id ASC)` and pagination
remains authoritative to relay-signed kind `39006` bounds. Coverage identity
also includes every request predicate that changes the answer: community,
signer/authorization scope, channel, kind set, auxiliary-closure policy, and
wire/projection schema version. A range advances only in the same transaction as
every row and auxiliary/tombstone fact needed to answer that exact predicate.
On interruption or ambiguity, coverage may lag stored events but must never lead
them. Garbage collection removes the oldest complete ranges and invalidates
their coverage atomically.

Reconnect repair is separate from historical page coverage. Until negentropy or
a relay ingest cursor exists, the legacy TypeScript path derives replay from
`lastSeenCreatedAt`, the maximum event timestamp it has observed. Because the
relay accepts events as much as 900 seconds in the future, that cursor can lead
relay/commit time by 900 seconds. Channel-bearing live subscriptions must
therefore replay by:

```text
relay_ingest_future_tolerance
+ CREATED_AT_FLOOR_SECS
+ FENCE_CLOCK_MARGIN_SECS
= 900 + 960 + 5
= 1,865 seconds
```

The first history request has no client-clock-derived upper bound; it pages from
the relay's newest matching event down to that floor. Every page transition is
lossless under the canonical `(created_at DESC, id ASC)` order. The current
TypeScript repair orchestrator uses the existing authenticated Tauri
`POST /query` bridge for history pages and supplies the relay's composite
`(until, before_id)` continuation. Its next-page predicate is `created_at < until
OR (created_at = until AND id > before_id)`. Standard WebSocket Nostr REQ does
not expose `before_id`, so timestamp-only WS paging is not an acceptable
fallback. A reconnect generation creates one bounded repair dedupe set before
restoring the live REQ. Both restored-live delivery and bridge history dispatch
consult it before invoking the consumer, and the set remains until live EOSE and
the repair pass have both completed or aborted; this proves one callback for
either live-before-history or history-before-live overlap rather than relying on
downstream cache normalization. A future transport without a composite cursor
would need an inclusive, tie-complete boundary drain with explicit event-ID
progress; it must neither subtract one second after a full page nor repeatedly
accept the same limited page without progress. This rule applies to the
unbounded first page too: more than one full page may legally share its oldest
`created_at`, and every matching event in that second must be delivered before
paging below it. For this paged repair request, the derived or previously pinned
replay floor overrides the live subscription's original mount-time `since`;
otherwise a backdated event older than the mount timestamp remains invisible
despite the wider window. The restored live REQ keeps its original filter.
Event IDs are deduped across restored-live and history deliveries before
consumer dispatch. The lookback applies only to subscriptions with exactly one
`#h` and the full channel event set; it must not widen profile, read-state, or
other global live subscriptions. A source-coupling test reads the Rust
ingest-envelope, DB-floor, and margin definitions and fails if the TypeScript
derived value diverges.

The future Rust engine may use the narrower
`CREATED_AT_FLOOR_SECS + FENCE_CLOCK_MARGIN_SECS` window (currently 965 seconds)
only after it records an authoritative sync-time watermark rather than an
observed event timestamp. Both forms cover backdated edits and kinds `5`,
`9005`, and `40003`; reconnect proof therefore includes a backdated tombstone
that would otherwise resurrect a ghost row. The compatibility fix lands now in
the existing TypeScript replay loop because the first Rust slice is fan-out
only and does not own replay. Parity tests keep the invariant portable when
replay later migrates to the native engine.

The replica hot-zone rule is channel-scoped. The DB fence exempts
`channel_id IS NULL`; profiles and other channel-less coordinates use
coordinate supersession plus explicit refetch. A channel-less deletion targeting
a channel event is applied under the target event's resolved channel, never the
deletion's absent `h` tag. Once the native engine uses an authoritative
sync-time watermark, a local coverage claim is trustworthy only for reads older
than `now - 965s`; the hot zone continues to consult live state. The legacy TS
replay cursor remains subject to the wider 1,865-second compatibility bound
above. The current five-second replay skew is unsound for accepted backdated
events. A monotonic ingest cursor would require explicit relay schema, indexing,
and protocol work; `received_at` is not such a cursor.

### Outbox

The future outbox uses explicit states: `pending -> publishing -> accepted` or
`retryable`, with terminal rejection recorded separately. The signed event and
its ID are created once and reused for every retry. Sign, persist the durable
outbox row, and apply its optimistic projection in one local transaction before
any socket write. Publishing then claims a persisted row through an atomic
compare-and-set, so exactly one worker owns an attempt. Relay `OK,true` records
acceptance idempotently; echoed live ingest and relay event-ID dedupe reconcile
the projection without minting or inserting a second event. Restart treats
`publishing` as ambiguous, first reconciles by event ID, then retries the same
signed bytes under bounded attempts/backoff. Rebuild or downgrade must preserve
pending, publishing, and retryable rows independently of rebuildable
`replica.db`. No outbox cutover is combined with read-path cutover.

### Projection and delta contract

Projection rows are normalized, versioned pure data, never cached React output.
Window deltas are versioned and contain `prepend`, `append`, positioned
`insert`, `patch`, and `removeIds`. Backdated events are positioned inserts
under NIP-CW ordering, not appends. A version gap, overflow, or unknown geometry
invalidates the window and triggers a local projection reread.

Row preprocessing is incremental and bounded at both temporary receipt points:
legacy query response and native engine delta. Track per-switch preprocessing,
per-delta work, loaded-window count, mounted DOM, retained nodes, and memory
plateau. Markdown cache keys include every parse input that changes output,
including mention/channel context and custom emoji, rather than event ID alone.

## Timeline ownership contracts

### One scroll owner

One channel-scoped state machine is the only component allowed to write the
active scroller. Virtualizer, pagination, router restoration, targeting, and row
measurement submit intents. Its states are:

- **BOOTSTRAP:** perform initial/deep-link placement, then enter `FOLLOW_TAIL` or
  `READER`;
- **FOLLOW_TAIL:** own true-bottom writes and exit immediately on reader input or
  loss of tail intent;
- **READER:** wheel, touch, and keyboard own position; programmatic writes are
  forbidden;
- **PREPEND_HOLD:** after input/momentum is quiet, preserve an ID plus viewport
  offset while admitting a pure prepend, then return to `READER`;
- **GEOMETRY_HOLD:** preserve an ID plus offset across measured-height change,
  then return to the prior logical mode; and
- **RESTORE:** perform one channel/history restoration, then enter
  `FOLLOW_TAIL` or `READER`.

Every programmatic write carries `{channelId, epoch, intentId}`. Its matching
scroll event is self-authored and ignored. Real reader input or channel teardown
increments the epoch and cancels stale writes, animation frames, measurements,
targets, and asynchronous completions immediately.

The machine covers:

- initial bottom placement and bottom-follow;
- prepend and positioned insert above, inside, or below the viewport;
- late growth from media, code highlighting, embeds, reactions, and thread
  summaries;
- deep-link, search, and unread targeting;
- real user interruption/cancellation;
- channel teardown/reopen and restoration; and
- resize, width, zoom, text scale, density, and font changes.

Current tail buffering, settle-gated prepend (including the current 80 ms
input-quiet rule), bottom settle, Virtua `shift`, and anchored-scroll defenses
stay in place until the replacement state machine has passed their adversarial
cases. The presently encoded correctness ceilings remain hard gates: physical
bottom at most 1 px; cascading and settle-gated prepend anchor drift below 5 px
with no reversal or snap-to-newest; rich-row resize drift at most 2 px; and
mounted rows below 400 in the existing deterministic fixture. Defenses are
removed one at a time behind independent flags.

### Geometry

A measurement keyed only by event ID is invalid. Geometry identity is never a
list index; it includes stable event ID and content/revision, available-width
bucket, zoom/text scale and font generation, density and metric-affecting theme
inputs, markdown/parser/render-schema version, media/embed reserve and realized
state, reaction/aux/thread-summary version, and row chrome/grouping state.
Reserve aspect-ratio or bounded geometry for known media and embeds. Unknown or
late size changes flow through `ResizeObserver` as `GEOMETRY_HOLD` intents.
Before remeasurement capture `{messageId, viewportOffset}` and restore the same
ID; if it was removed, choose a deterministic adjacent survivor, never the old
index. Invalidate one row for edit/content/aux/media realization, affected
neighbors for grouping changes, the channel for width/scale/density/font/parser
changes, and all persisted geometry on schema mismatch.

## Evidence matrix

There is no packaged macOS WKWebView acceptance runner today. The release smoke
serves `desktop/dist` to Desktop Chrome; it is deterministic merge evidence, not
proof of the shipped Tauri shell. Chromium Playwright instruments therefore
remain frozen diagnostics and regression comparators, not release gates for
WKWebView compositor behavior:

- `cold-switch-longtask.perf.ts`: cold-switch longest/total long tasks;
- `warm-switch-markdown.perf.ts`: warm-switch paint and markdown cost;
- `typing-latency.perf.ts`: Event Timing and busy/storm deltas;
- `scroll-smoothness.perf.ts`: layout/style and prepend cost;
- `scrollback-buzzbugs.perf.ts`: pagination latency, payload, and duplicate
  behavior; and
- deterministic timeline/virtualization tests: correctness gates, including the
  existing physical-bottom, anchor-drift, reversal, input-quiet, buffering, and
  mounted-row ceilings.

Milestone 0 must establish a package-equivalent Tauri `.app` runner using release
features, sidecars, entitlements, and bundled frontend against an isolated,
deterministic relay fixture. This is a real-WKWebView lane, not another
Playwright project: the runner contract permits a native macOS automation driver
or manual reference run until an automatable driver is selected, but it may not
substitute Desktop Chrome evidence. Milestone 0 may land the schemas, launch and
fixture seams, environment capture, and a reproducible current-main reference
run; full automation is not implied before the native driver exists. Drive
native wheel/trackpad and keyboard input at narrow/wide widths and every supported
zoom/text-scale setting. Record raw sample JSON with build SHA,
package/signing identity, fixture and relay versions, hardware, macOS/WebKit,
display refresh, and power/thermal state. The matrix exercises:

- cold/warm switch and repeated channel teardown/reopen;
- prepend during momentum and backdated insert at every viewport position;
- append at bottom and while reading;
- late media/code/embed/reaction/thread-summary growth;
- deep-link/search/unread targets plus user interruption;
- reconnect, offline recovery, restart, migration, and injected crash points;
- agent-storm IPC/backpressure; and
- repeated full traversal/switches until DOM, memory, and disk reach a plateau.

Collect p50/p95/p99 switch-to-stable-first-paint and input responsiveness,
frame/presentation evidence, longest and total long tasks, anchor drift during
motion, mounted/retained node counts, native/webview RSS, replica size, and IPC
queue/overflow counters. Continuously assert no blank or stale-channel frame,
scroll reversal, target yank, or regression of the existing physical-bottom and
anchor tolerances. Preserve commit-at-rest and rollback tests until their
successor proves the same invariant in packaged WKWebView.

Baseline current main and each candidate in alternating AB/BA order on a pinned
reference device and fixture. Use at least five clean launches and 200 measured
observations per build/scenario; cold samples reset relevant state and warm
samples get one untimed prime. Report nearest-rank percentiles with paired
bootstrap 95% confidence intervals, retain raw samples, and repeat release gates
on a second supported macOS/WebKit version. Never pool unlike hardware or OS.
Until that baseline exists, correctness ceilings, any unbounded DOM/RSS/disk/IPC
slope, and queue overflow are hard failures. A relative performance lane fails
only when its paired regression is materially larger than 5% at p50, 10% at
p95, or 15% at p99 and the confidence interval excludes parity. Freeze named
absolute latency, plateau, disk, and IPC budgets only after repeated packaged
runs; do not manufacture them from Chromium.

## Milestone 0 delivery

Milestone 0 is exactly two PRs:

1. **Reconnect correctness:** change the existing TypeScript replay floor from
   five seconds to the derived, channel-scoped 1,865 seconds required by its
   event-time cursor (`900 + 960 + 5`), preserving the current batching,
   pinned-floor, rate-limit, and generation behavior. TypeScript remains the
   replay owner/orchestrator, but history pages use a narrow Tauri command over
   the existing authenticated `POST /query` bridge so pagination is tie-complete
   under `(created_at DESC, id ASC)` with composite `(until, before_id)`
   continuation. Do not use timestamp-only WebSocket paging or skip the
   remainder of a full boundary second. The paged repair floor overrides the
   live filter's mount-time `since`; the restored live REQ itself remains
   unchanged. Do not use a client-clock `until` for the first page, and dedupe
   event IDs across restored-live/history overlap before consumer dispatch.
   Acceptance covers source-constant coupling, exact floor math, a
   future-dated cursor followed by an older accepted event, backdated kinds
   `5`/`9005` and `40003`, overlap dedupe, failed replay floor pinning,
   multi-page replay, an unbounded first page followed by more than one full
   page sharing one `created_at`, and exclusion of channel-less/global
   subscriptions.
2. **Contracts and baseline harness:** land this document, immutable fixture and
   result schemas, package-equivalent WKWebView launch/driver seams, environment
   capture, manifest/report validation tooling, and a reproducible current-main
   reference run where the available driver supports it. It changes no relay
   ownership, replica, renderer delta, timeline routing, or authoritative read
   behavior. Existing deterministic timeline correctness remains gating;
   Chromium perf specs remain non-gating diagnostics; packaged correctness and
   boundedness become gating per scenario as the real-WKWebView driver can
   exercise them, while absolute budgets remain `TBD-by-M0-baseline` until
   frozen from repeated evidence. An unavailable native driver is recorded as a
   release-evidence blocker, never silently replaced by Chromium.

The first implementation PR after milestone 0 is persistent fan-out only. It
must not include a replica DB, renderer deltas, timeline routing, or cutover, and
must not disturb `set_subscriptions`, immutable subscription/filter identity,
reconnect reconciliation, or CLOSED/rate-limit recovery.

## Milestones

1. **M0, contracts and proof:** land this contract, baseline current main,
   establish packaged-app harness seams, and fix reconnect replay independently.
2. **M1, native foundation:** first land persistent fan-out only; then add the
   replica writer/schema in shadow; then compare real channels. No renderer
   deltas or query routing yet.
3. **M2, sidebar:** shadow/compare the projection, flag the local read, retain
   polling fallback for one release, then remove polling.
4. **M3, channel windows:** use `get_channel_window` as the strangler seam;
   local read inside coverage, bridge on miss; shadow equality before flagged
   cutover.
5. **M4, threads and timeline:** project aux/thread data, land the single scroll
   owner and geometry contract, then remove existing defenses individually.
6. **M5, socket consolidation:** move presence, typing, and huddle subscriptions;
   ship native-authoritative with renderer fallback before deleting the renderer
   relay stack.
7. **M6, measured optimizations:** negentropy first; ingest cursor, FTS, or LMDB
   only if evidence justifies their separate relay/storage cost.

The implementation should prefer the fewest PRs that preserve these review and
rollback boundaries. M0 targets one documentation/harness-foundation PR and one
focused reconnect-correctness PR. M1 fan-out is independently reviewable from
replica persistence because it changes socket delivery semantics and is the
prerequisite for attaching shadow ingest safely.
