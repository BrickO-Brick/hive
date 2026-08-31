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

## Exact Stop: supported owned-work completion

Native Stop signals only the retained selected-generation ACP owner and allows
90 seconds for nested cleanup. It never signals a reaped/recycled root or a newer
run. Deadline escalation is `unknown`, not successful Stop. The legacy PID-only
best-effort path remains separate.

Root/group exit alone remains **`root_exited`**, blocking replacement. `stopped`
now additionally requires a verified agent-signed local owned-work proof for the
same agent, canonical community and existing launcher `start_nonce`, plus a
successfully reaped root. No binary-name, timing, goodbye/log, presence or exit-code
heuristic can produce this proof. The host subsequently issues the existing
host-signed encrypted execution Receipt for the immutable Stop command.

### Minimal supported capability chain

1. ACP installs SIGTERM/SIGINT handlers **before spawning**. The same sticky watch
   cancels eager/lazy initialization and respawn/backoff; startup errors explicitly
   drain partial pools. Stop cancels checked-out channel and heartbeat work before
   joining it. Bounded abort/escalation never clears incomplete-child evidence.
2. `buzz-agent` advertises `_meta.buzzOwnedWorkShutdown: 1` at ACP initialize.
   `_buzz/shutdown_v1` closes request admission, cancels sessions and joins all
   session/new and prompt tasks, including partial initialization. It returns
   `{v:1, ownedWorkStopped:true}` only when all lifetime MCP children completed.
   EOF/broken output still performs cleanup, but cannot issue this acknowledgement.
3. MCP discovery of `_buzz_shutdown_v1` negotiates the supervisor-only capability
   (underscore tools are hidden from the model). It closes shell admission,
   cancels and drains shell owners, and returns exactly
   `buzz.owned-work.stopped.v1` only when owned shell roots were reaped and their
   groups disappeared. Dropped/aborted/unobserved shell work is sticky uncertainty.
4. The agent retains each actual MCP child through an rmcp `Transport` adapter:
   explicit work acknowledgement **and** successful child reap are both required.
   rmcp 1.8's default transport masks timeout-kill/nonzero exits, so waiting for its
   `cancel()` alone was insufficient. Failed initialization, restart, borrowed
   clients, noncooperative tools and forced exits cannot certify completion.
5. ACP requires the negotiated agent acknowledgement and successful agent reap.
   A process-lifetime incomplete-child count includes failed/aborted respawns.
   Only zero incomplete children permits writing the final local proof, using the
   agent key already entrusted to this runtime. No new run ID/key/kill authority
   or relay kind is introduced. Native stamps `BUZZ_STOP_RECEIPT_PATH` beside the
   runtime log (`.stop-<start_nonce>.json`); ACP strips this variable from agent
   children. The file is create-new, mode0600, synced, signature-checked and bounded
   to4096 bytes. Missing, altered or wrong-scope files cannot authorize replacement.

**Supported boundary and failure model:** this is trusted cooperative
`buzz-acp → buzz-agent → buzz-dev-mcp → shell process-group` execution on Unix,
not hostile-code containment. Ordinary shell children/grandchildren in their
owned group are included, even if ignoring TERM (the tool owner kills and reaps
them). Deliberately detached/daemonized work, external services/jobs created by
commands, arbitrary third-party tools, compromised executors/agent keys and
OS-level unobservable workloads are outside the supported capability contract.
Do not present it as universal descendant or remote-job termination. Unsupported
servers do not silently inherit support from their name or exit status; they
remain `root_exited`/`unknown`. Windows lacks the required observation here and
fails closed. Lifetime uncertainty persists even if a later replacement child
shuts down cleanly. A native restart without a retained child also stays unknown.

Move's approved meaning remains: confirmed selected-run Stop, then a fresh runtime
session for the same agent at the destination, **no automatic file/workspace
transfer**. Unknown/root-only outcomes block replacement; unrelated placements
are preserved. This Stop candidate does not implement Move UI; the Start transport above remains default-off.

### Repeatable real-process check (fixture relay/provider)

```sh
cargo build --locked -p buzz-acp -p buzz-agent -p buzz-dev-mcp
export BUZZ_STOP_CHAIN_BIN_DIR="$PWD/target/debug" # use actual CARGO_TARGET_DIR if set
# Optional: a fresh directory for process-tree snapshots and per-owner logs.
export BUZZ_STOP_CHAIN_ARTIFACTS="$(mktemp -d)"
# Source-only native test; this does not test packaged mesh sidecars.
export TAURI_CONFIG='{"bundle":{"externalBin":[]}}'
cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml \
  selected_generation_process_chain -- --ignored --nocapture
```

Requires Unix and Node. The test starts real `buzz-acp`, `buzz-agent`, and
`buzz-dev-mcp` binaries, uses the production native selected-generation guard and
termination seam, and observes real shell/grandchild PIDs in independently owned
process groups. A same-identity peer on another fixture relay remains running
through selected Stop, stale-generation rejection and retry-after-reap rejection.
Every peer process is then stopped by its own owner. Fixture services bind only
loopback, accept test auth, and supply a canned OpenAI tool call. The test clears
inherited configuration and uses only a public deterministic test key.

This is **not** a Desktop UI test, signed command receiver/outbox test, real LLM
provider run or second physical machine. It verifies the signed supported
completion proof and rejects different-community/generation proof reuse.
The source-level native journal tests separately pin crash/ACK-loss deduplication
and the rule that only confirmed exact Stop permits replacement.

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
