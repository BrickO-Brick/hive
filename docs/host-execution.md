# Host execution foundations (not yet an enabled remote feature)

The native transition seam exists, but host discovery still advertises
`accepts_start: false`. There is no Start/Move host-picker wiring or relay command
receiver/publication yet. Kinds 50001/50002 are reserved protocol constants, **not
admitted relay operations**. Do not enable the advertisement merely because a
command can be signed or a native IPC call returns.

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
execution result. Authorization and command lifetime are rechecked even on retry;
after expiry the future receiver needs an authenticated history/reconciliation
path, not a replay with a new operation ID.

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

## Remaining integration gates

1. Admit the private command/receipt kinds through existing relay authorization,
   registration revocation, owner-only result gates/queries and FTS exclusion.
   Add tenant, malicious payload and revocation integration tests before admission.
2. Owner-operated Desktop receiver/outbox, durable receipt retry/history and actual
   authenticated lifecycle receipt updates. Do not grant host keys general access.
3. Destination provisioning/minimal encrypted handoff if the agent is absent;
   explicit destination-local credentials and config, not exported source files.
4. Workload-owner teardown and confirmed selected-run Stop, then the approved
   fresh-runtime/no-file-transfer Move. No workspace migration.
5. Native two-executor tracer bullet and UI, second-host/provider prerequisites,
   real workload verification, final mesh-enabled packaging and matching captures.
   Two local processes prove routing, not two physical machines.
