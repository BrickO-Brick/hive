NIP-FI-CONF
===========

Conformance evidence profile
----------------------------

`draft` `optional`

**Dependencies**: NIP-FI core. Applies additionally to any claimed
NIP-FI-EDGE, NIP-FI-LIFECYCLE, and NIP-FI-DELEG profile.

The key words "MUST", "MUST NOT", "REQUIRED", "SHOULD", "SHOULD NOT", and
"MAY" in this document are to be interpreted as described in BCP 14 (RFC 2119
and RFC 8174) when, and only when, they appear in all capitals.

## Abstract

NIP-FI core and its profiles state required behavior. This profile states what
counts as evidence that an implementation has it: the claim unit, the evidence
rules, the complete denial-fixture enumeration, mutation adequacy, and the
interoperability exit test.

This profile is separately claimable and is never advertised in discovery.
Conformance is a property of a reviewed revision, not a wire feature, and a
public claim of it would be an unverifiable assertion about the server's own
testing.

This profile defines no wire behavior, denial mapping, invariant, or admission
rule. Where it names one, NIP-FI core or the owning profile is normative.

## Claim unit

A conformance claim names exactly one immutable tuple:

```text
(implementation revision,
 adapter revision,
 build artifact digest,
 deployment revision,
 claimed profiles,
 assertion_policy_id,
 transport_contract_id,
 enrollment mode)
```

Changing any element creates a new claim. Results from one tuple MUST NOT be
carried into another. A report contains every applicable oracle from core and
every claimed profile exactly once, with status `pass` or `not-applicable`
only. Blank, skipped, expected-failure, and not-run results cannot support a
claim (`FI-CONF-CLAIM-COMPLETE`).

Enrollment mode is part of the claim unit and is private. It is recorded in the
access-controlled report, never in discovery or any public artifact.

## Evidence rules

Each passing oracle records the claim tuple, a stable test identifier and
adapter entry point, the command with start time, end time, exit status, and
any random seed, the synthetic input or a privacy-safe digest of it, the
before-and-after authoritative state relevant to the oracle, the expected
outcome and the observed outcome, and artifact locations with SHA-256 digests.
Stateful oracles use an isolated database or namespace and inspect committed
state rather than inferring it from a response. Concurrency oracles record
every contender and the single serialized outcome. Time-boundary oracles use a
controlled clock.

Adapters MUST drive public or production-equivalent entry points. A storage
helper MAY inspect state or inject a dependency outage; it MUST NOT replace the
operation under test. Calling an internal authorization function without
traversing the protected ingress does not satisfy ingress coverage.

None of the following satisfies any oracle: searching source, documentation,
schemas, or binaries for a token; asserting that a route calls a named
function; recording a test name without its execution result; using a mock to
prove a deployed network boundary; citing a check from another revision; or
marking an oracle passed because the feature is configured.

`FI-TRACE-TOFU-THEFT` takes an access-controlled **configuration** witness
only. Under the private-posture rule no discovery output distinguishes
enrollment mode, so a discovery witness for that oracle cannot exist; requiring
one would make the oracle unsatisfiable. Discovery invariance is proved
separately by `FI-TRACE-DISCOVERY-PRIVATE`, which compares complete discovery
bytes across enrollment modes.

Deployment-obligation requirements — those marked in core or a profile as
`[deployment artifact: ...]` — are evidenced by the named access-controlled
review record at the claimed deployment revision, not by a behavioral oracle.
A claim listing an artifact without the record is incomplete.

Reports and artifacts hold private deployment detail and MUST remain access
controlled. They MUST NOT enter public reports, examples, discovery, or
protocol output, and MUST NOT contain raw assertions, secrets, or unredacted
`iss`, `sub`, or claim values.

## Denial fixtures

`FI-TRACE-DENIAL-ORACLE` requires one fixture per **private condition**, not
one per public class. A per-class suite passes trivially: it compares a class
against itself. The enumeration below is the required fixture set
(`FI-CONF-DENIAL-FIXTURES`). Its public-class column restates NIP-FI core,
which owns that mapping and the exact response bytes.

| # | Private condition | Public class | Defined by |
|---|---|---|---|
| 1 | assertion, proof, or delegation evidence absent | `missing_evidence` | core |
| 2 | evidence present but rejected: signature, key selection, issuer, audience, time, size, ambiguity, token class, body binding, or edge provenance/replay | `evidence_rejected` | core, NIP-FI-EDGE |
| 3 | `key_mismatch` — asserted key is not the proven actor | `authorization_denied` | core |
| 4 | `attestation_required` — attested-key enrollment without a matching key claim | `authorization_denied` | core |
| 5 | `binding_conflict` — either side of the active relation is taken | `authorization_denied` | core |
| 6 | `pair_retired` | `authorization_denied` | core |
| 7 | `key_revoked` | `authorization_denied` | core |
| 8 | `policy_denied` — local operation policy | `authorization_denied` | core |
| 9 | `binding_required` — provisioned mode, no binding | `authorization_denied` | NIP-FI-LIFECYCLE |
| 10 | `identity_disabled` | `authorization_denied` | NIP-FI-LIFECYCLE |
| 11 | `explicit_replacement_required` — pending lineage | `authorization_denied` | NIP-FI-LIFECYCLE |
| 12 | `binding_expired` — administrative expiry | `authorization_denied` | NIP-FI-LIFECYCLE |
| 13 | `delegation_not_current` — owner or relationship no longer current | `authorization_denied` | NIP-FI-DELEG |
| 14 | `dependency_unreadable` | `authorization_unavailable` | core |

The names in the private-condition column are fixture identifiers for this
enumeration. Four of them — `key_mismatch`, `binding_conflict`, `pair_retired`,
and `key_revoked` — are core's own denial symbols; the rest name conditions that
core and the profiles define in prose. None is a wire value, and a deployment
MAY use different private reason codes internally as long as every enumerated
condition has a fixture.

Rows 3–13 are the private-state anonymity set. Their public responses MUST
compare byte-identical to each other, not merely equal in prefix or status.
Rows for an unclaimed profile are `not-applicable` with absence evidence. A
profile that introduces a new private condition MUST add its row; an
unenumerated condition escapes this oracle entirely.

**Compared object.** Byte-identity is asserted over the response bytes an
implementation chooses, which excludes bytes a conforming HTTP server cannot
hold constant. Over Nostr the compared object is the complete relay message
excluding only the event or subscription identifier echoed from the request.
Over HTTP it is the status code, the ordered sequence of header field names,
every header field value except `Date`, and the complete body. `Date` is
excluded because RFC 9110 Section 6.6.1 requires an origin server with a clock
to generate it on every 4xx response, so two denials at different instants can
never be identical over the literal wire bytes; a suite comparing those would
fail every conforming implementation. Any other excluded field MUST be named in
the report with the reason it cannot be held constant, and its value MUST be
independent of the private condition.

The oracle runs a fixed positive iteration count on a pinned isolated runner at
the exact claimed head. Before the run the operator records the environment,
public-response corpus, bounds, sampling method, statistical rule, noise
treatment, and acceptance threshold. A breach fails the gate, MUST NOT trigger
an automatic retry, and is retained and investigated before a separately
authorized rerun.

`authorization_unavailable` is observably distinct from `authorization_denied`.
This is accepted residual: it discloses no per-principal state, and collapsing
it would make fail-closed behavior undiagnosable.

The suite MUST include a negative control: an implementation deliberately
patched to vary its denial response by private condition MUST fail this oracle.
Without it the suite asserts that it works instead of demonstrating it.

## Mutation adequacy

Naming an oracle for a requirement proves the requirement is claimed, not that
the oracle can fail. A requirement whose oracle cannot fail is untested and
reads as tested, which is worse than an acknowledged gap.

For each normative requirement in core and each claimed profile, the suite MUST
retain at least one **mutant**: an implementation variant that violates exactly
that requirement, together with the failing output of the oracle that requirement
names (`FI-CONF-MUTATION`). Evidence is the exact patch identity, the oracle
identifier, and the retained failure output at the claimed head.

Four rules make the mutant meaningful:

1. **One at a time.** Mutants are applied singly against an otherwise unmodified
   implementation. Layered defenses mask each other: a guard looks covered
   because a different guard denies first.
2. **Attribution.** The kill MUST come from the oracle the requirement names. A
   mutant killed only by some other oracle establishes coverage for neither.
3. **Reachability.** The suite MUST witness that a fixture reaches the mutated
   decision, not merely the enclosing operation. A mutant behind a bound,
   length field, or earlier denial that no fixture ever passes is never
   exercised, and the suite reports clean on an implementation that is
   provably broken.
4. **Survivors are recorded.** A mutant its named oracle fails to kill is a
   defect in the specification or the suite. It is recorded with that
   disposition and MUST NOT be waived or replaced by an easier mutant.

Two global controls bound the suite from both sides. A deny-everything
implementation MUST fail every positive oracle, proving each oracle has a
positive arm. An allow-everything implementation MUST fail every negative
oracle, proving each has a negative arm. Neither control substitutes for
per-requirement mutants; an implementation can pass both while violating any
individual requirement.

## Interoperability exit test

A claim of core conformance requires evidence that the document alone is
sufficient to build against (`FI-CONF-INTEROP-EXIT`). Two implementations that
have not shared code and have not consulted a common reference implementation
each produce, from NIP-FI core and any claimed profile documents alone:

- one byte-exact valid `client-attached` request, over WebSocket upgrade and
  over HTTP; and
- one byte-exact public denial response for each of the four public classes, on
  both transports, compared over the object defined under **Denial fixtures**.

The evidence is the produced bytes, the document revision used, and a statement
of independence. The test passes when the outputs compare equal byte for byte
and each implementation accepts the other's valid request and reproduces the
other's denials. Any divergence traced to an underspecified value is a defect
in the specification, not in either implementation, and is fixed there.

## Applicability

`not-applicable` requires a machine-readable reason and behavioral proof that
the surface is absent:

- edge oracles only when no trusted-edge profile is accepted, none is
  advertised, and executable cases reject every trusted-edge evidence shape;
- snapshot-rotation oracles only when no local key or status snapshot source is
  configured and executable evidence proves the absence;
- `FI-TRACE-TOFU-THEFT` only when TOFU is neither configurable nor configured
  and executable first-use cases deny;
- lifecycle and delegation oracles only when the profile is unclaimed, disabled,
  and denied on every ingress; and
- every other oracle is required for an enforcing deployment.

An implementation that supports an optional surface runs its oracles even when
one deployed domain does not activate it.

## Release gate

Before NIP-FI enforcement or discovery is enabled, reviewers verify that one
immutable claim tuple passes every applicable oracle at one reviewed revision;
that the protected-ingress inventory has no uncovered or competing authority;
that every core requirement has a killed, attributed, reachable mutant and every
survivor is recorded; that the denial-fixture enumeration is complete for the
claimed profiles and its negative control fails as required; that the
interoperability exit test has passed against an independent implementation;
that every named deployment artifact exists at the claimed deployment revision;
and that public and operational sinks pass privacy-canary inspection.

Documentation review, source review, and static scans are useful review inputs.
They close no item in this gate.

## Behavioral oracles

| ID | Required outcome |
|---|---|
| `FI-CONF-CLAIM-COMPLETE` | A report missing an applicable oracle, duplicating one, carrying a result from another claim tuple, or claiming a status other than `pass`/`not-applicable` is rejected. |
| `FI-CONF-DENIAL-FIXTURES` | Every enumerated private condition has a fixture; anonymity-set responses compare byte-identical; the distinguishing negative control fails. |
| `FI-CONF-MUTATION` | Every normative requirement has a singly-applied, attributed, reachability-witnessed mutant killed by its named oracle; survivors are recorded, not waived. |
| `FI-CONF-INTEROP-EXIT` | Two independent implementations produce byte-identical valid requests and per-class denials from the documents alone and accept each other's output. |

## Security considerations

Conformance evidence is a privileged artifact: it enumerates private denial
conditions, enrollment posture, and deployment topology that the protocol
deliberately keeps off the wire. Publishing a report, a fixture corpus, or a
mutant catalogue would disclose exactly what `FI-INV-13` and
`FI-TRACE-DISCOVERY-PRIVATE` protect.

A passing suite bounds the behaviors it exercises and nothing else. Mutation
adequacy raises the cost of a masked defect; it does not prove absence of
defects, and a claim that cites this profile as proof of security rather than
of tested behavior is misusing it.
