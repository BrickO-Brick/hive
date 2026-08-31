# Host execution foundations (not yet an enabled remote feature)

The owner-operated native Start outbox, receiver and Hosts picker are implemented
behind the **non-default `remote-start-preview` Cargo feature**. Default builds
advertise `accepts_start: false` and reject queuing. Even a preview build advertises
Start only with a successful same-owner/community receiver pump in the last 15s
and at least one destination-local provisioned, compatible configuration. A
runtime catalog entry alone is not launch capability. This is not a release or
physical-host/provider certification.

Kinds 50001/50002 are admitted only through the owner's global transport with an
exact nondeleted registration. Commands are owner-signed, receipts host-signed;
host keys receive no general login privilege. Query/result gates remain owner-only
and additive migration 0042 excludes both ciphertext kinds from FTS (heap rewrite;
plan deployment maintenance). Private profile v3 carries only agent public key,
runtime catalog ID and opaque configuration revision. No source keys, environment,
workspace or files are transferred.

## Native seams

- `inspect_local_execution_config`: owner/community-scoped inspection of an agent
  already provisioned on this Desktop. Returns only Rust catalog runtime ID and
  a destination configuration digest; never a launch payload/key/environment.
- `execute_host_command`: verifies an owner-signed NIP-44 command addressed to this
  host, reads the exact nondeleted registration using the **existing owner's**
  selected-community authority, checks freshness, then runs the native transition.
  No independent host login or owner credentials export is introduced.
- Start uses the existing launch machinery and destination configuration. Its
  revision is rechecked against the actual resolved inputs at the spawn boundary.
  Unknown/missing runtime or authentication, setup mode, provider-backed records,
  unsupported mesh preflight, prior receipt or live destination peer fail closed.
  There is no arbitrary received command/env/path or source-host loopback endpoint.
  This does **not** yet provision a source-only agent onto a second Desktop.
- The Start operation's random ID governs the launcher `start_nonce`, durable
  receipt `run_id`, authenticated lifecycle correlation and public ACP run ID.
  Ordinary local starts get a fresh generation as before. Legacy receipts deserialize
  with no generation and cannot establish selected-run Stop authority.

## Durable semantics

A secret-free journal is keyed by local owner plus canonical agent/community
placement. An OS file lock serializes controllers sharing the store. Atomic
restricted writes and directory sync persist intent **before** side effects.
The immutable signed command event ID and request are retained with outcomes.
Retries reuse the same event/operation, return the recorded observation and never
repeat launch. A crash after intent but before a recorded result is `unknown`,
not an invitation to spawn again. A different command reusing an operation ID is
rejected. Journal corruption/unreadability and retention saturation fail closed.
There is no automatic garbage collection or recovery override.

The placement remains fenced through Stop and unknown outcomes. Ordinary/config-
driven starts consult that fence too. A stale Stop checks the tracked generation
under the transition locks **before** writing a new fence, so it neither signals
nor takes control of a successor. Other agent/community placements are untouched.

`spawned` means a child was actually created, **not** listening, ready, a model turn
or conversational presence. The protocol reserves listening/ready observations;
the native executor currently records spawn only, not asynchronous receipt updates.
Results are host-signed, encrypted to the owner, and correlated to the exact signed
command, request, host registration and generation. Expired presence is never an
execution result. Authorization is rechecked even on retry. Historical bytes authenticate at their
signed timestamp, but the native transition checks actual wall-clock expiry after
immutable ledger replay and before creating any new intent or side effect. Future
timestamps are rejected. Expiration never creates a replacement operation.

The native outbox uses restricted atomic writes, directory fsync and OS file locks.
It retains signed commands and receipts through ACK loss/reconnect/restart.
Publication errors are recorded per entry, remain visible and retry independently;
a revoked old registration does not starve another operation. Corrupt bindings,
missing receipts and invalid/cyclic supersession chains fail closed. Transport ACK
means only relay acceptance. The app-scoped pump runs independently of the Hosts
page, and generation-matched public run presence supplies the actual location.

`queue_host_start` without `new_attempt_after` always reuses the saved current
intent, even if completed or rejected. A genuinely new user intent supplies that
exact previous operation ID. It requires either its signed rejected outcome or a
host-signed `stopped` receipt correlated to an owner-signed Stop of that exact run.
Neither `root_exited`, missing presence nor expiry qualifies. A persisted
supersession chain selects the current intent without timestamp tie ambiguity.
Destination placement fences still revalidate admission; this does not implement
Stop or Move, and never bypasses a successor/unknown placement fence.

## Exact Stop: important containment limit

The current native Stop only signals an exact tracked generation and waits for its
root and owned process group to exit. An already-reaped root cannot be signaled by
its potentially recycled PID. Unknown teardown retains the fence.

**This does not prove full tree teardown.** ACP agents and buzz-agent MCP servers
create their own process groups (`buzz-acp/src/acp.rs`, `buzz-agent/src/mcp.rs`).
The executor therefore records **`root_exited`**, never `stopped`, after observing
root-group teardown. `root_exited` is explicitly insufficient to permit a new
Start. The journal's `stopped` state is reserved for a future containment-backed
proof; no production native path currently emits it. A healthy goodbye, exit code,
lease expiry or relay acknowledgement cannot substitute for that proof.

Move remains unimplemented, but its product meaning is approved: stop-confirm
only the selected generation, then a fresh runtime session for the same agent on
the destination, with **no automatic workspace or file transfer**. Unknown or
root-only outcomes continue blocking replacement; unrelated placements must not
be touched. Do not use identity-wide `!shutdown`.

The first workload-owner correction is in `buzz-dev-mcp`: connection EOF/error
closes shell admission and cancels running shell calls before the MCP response
drain, and server teardown waits for those calls. Shell cancellation signals its
own process group, waits for its direct child, and joins its output-reader tasks.
A real-process test drives MCP EOF with a shell/grandchild in a separate group and
checks that an unrelated peer survives. This fixes cooperative MCP connection
teardown, **not** the full Desktop Stop chain or arbitrary daemon containment.

The remaining concrete ownership gap is upstream: native escalation currently
allows only one second; ACP immediately kills its agent group; buzz-agent spawns
session/prompt tasks without joining them on EOF and kills MCP groups in Drop
instead of awaiting rmcp's existing graceful transport close. Those owners must
propagate cancellation, join their work and await child teardown before an
exact-generation authenticated completion can be trusted. A killed/hung owner,
unobserved cleanup or unsupported runtime must remain unknown, not stopped.
There is no universal containment promise for arbitrary programs that detach from
managed groups.

## Validation and integration gates

The opt-in debug-only `remote-start-tracer` feature builds a separate
`host-start-tracer` executable. It uses two local native Wry executors, fresh
synthetic keys, independent keyring/HOME/app-data scopes, the actual native
queue/pump/transition, and real buzz-acp/buzz-agent binaries. It requires an
isolated loopback relay and a newly initialized fixture directory. See source
`desktop/src-tauri/src/host_start_tracer.rs`; never use live credentials or a
shared production profile. Fixture provider configuration is explicitly synthetic;
a spawned process and public live run label are not an inference-turn proof or
two physical machines. On macOS the tracer pins each executor to a native keychain
file under its fixture HOME; it does not change the user's default keychain or
search list.

The local two-executor tracer was exercised on 2026-08-31: native destination
spawn, a verified host-signed `spawned` receipt, and matching public run/host label
were observed. A restarted source reused the same immutable operation. The
fixture initialized real buzz-agent ACP sessions but did not request inference.
Cleanup reaped only the fixture's tracked root, not a certified Stop.

Remaining gates include real-provider and second-physical-host validation,
actual Hosts native UI capture, authenticated asynchronous lifecycle receipt
updates beyond spawned, destination provisioning UX, and independent confirmed
selected-run Stop integration before Move. No final mesh-enabled DMG or combined
feature certification is implied by this slice.
