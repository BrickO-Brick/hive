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
| 9 | `binding_required` — enrollment policy creates no binding at this request: provisioned mode with no binding, or any unrecognized policy value | `authorization_denied` | core |
| 10 | `identity_disabled` | `authorization_denied` | NIP-FI-LIFECYCLE |
| 11 | `explicit_replacement_required` — pending lineage | `authorization_denied` | NIP-FI-LIFECYCLE |
| 12 | `binding_expired` — administrative expiry | `authorization_denied` | NIP-FI-LIFECYCLE |
| 13 | `delegation_not_current` — owner or relationship no longer current | `authorization_denied` | NIP-FI-DELEG |
| 14 | `dependency_unreadable` | `authorization_unavailable` | core |

The names in the private-condition column are fixture identifiers for this
enumeration. Six of them — `key_mismatch`, `attestation_required`,
`binding_conflict`, `pair_retired`, `key_revoked`, and `binding_required` — are
the symbols core's preparation pseudocode denies by name, and that list MUST
equal core's set exactly. Rows 8 and 14, `policy_denied` and
`dependency_unreadable`, are core's conditions expressed only in prose — a bare
policy denial and `FI-INV-14` fail-closed — and core is not required to name
them symbolically; they are the only two core rows so exempted. The remaining
rows name conditions the profiles define in prose. None is a wire value, and a
deployment MAY use different private reason codes internally as long as every
enumerated condition has a fixture.

Rows 3–13 are the private-state anonymity set. Their public responses MUST
compare byte-identical to each other, not merely equal in prefix or status.
Rows for an unclaimed profile are `not-applicable` with absence evidence. A
profile that introduces a new private condition MUST add its row; an
unenumerated condition escapes this oracle entirely.

The anonymity comparison is **wider than the interoperability compared object
defined below, and deliberately so**. Between two private conditions on the same
implementation, every response byte MUST agree except values a server cannot
hold constant across two instants, such as `Date`. It is not limited to the
header fields core names. The narrower object below exists because two
*different* implementations cannot be required to agree on fields core does not
pin; that reasoning does not apply within one implementation, where any field
varying by private condition is a disclosure whatever its name. A suite that
reuses the interoperability object here would pass an implementation that
returns its private reason code in an unnamed header.

**Enumeration agreement.** The preceding paragraph makes a quantified claim
about this table, and a fix verified against the one row it changes can still
falsify it. Rows 8 and 14 are the **prose-only allowlist**: core's conditions
that core is not required to name symbolically. The suite MUST check,
mechanically at the claimed head (`FI-CONF-DENIAL-FIXTURES`):

1. every symbol core denies by name has a row here;
2. every symbol core denies by name is attributed to core;
3. the naming paragraph above lists exactly the symbols core denies by name;
4. the count word in that paragraph equals the number of symbols it lists;
5. every core-attributed row that is a named symbol carries the same public
   class — quantified over core's symbolic set, not over all core-attributed
   rows, since `dependency_unreadable` is correctly `authorization_unavailable`;
6. no allowlist entry appears in core's symbolic denial set; and
7. the set of core-attributed rows equals core's symbolic denial set together
   with the allowlist, exactly.

Checks 3 and 4 are independent and neither implies the other: an editor who
corrects the count without the names is caught by 3, and one who corrects the
names without the count is caught by 4.

Checks 6 and 7 guard the allowlist itself, which is otherwise unguarded state
in a document whose subject is that unguarded claims rot. Check 6 is what makes
promotion visible: if a later core turns `policy_denied` or
`dependency_unreadable` into a named symbol, check 2 does **not** fail — that
row is already attributed to core, so promotion satisfies check 2 more, not
less — and an editor who updates this paragraph honestly at the same time
satisfies 3 and 4 as well. Only check 6 fails, and the stale entry is then the
thing to delete. Check 7 restores equality in both directions, weakened by
exactly the allowlist and nothing more, so a core-attributed row that core
never emits is caught without failing a conforming document.

**Compared object.** This object governs the interoperability comparison between
two implementations. The anonymity comparison above is wider. Byte-identity is
asserted over the response bytes an implementation chooses, which excludes bytes
a conforming HTTP server cannot hold constant. Over Nostr the compared object is
the complete relay message excluding only the event or subscription identifier
echoed from the request. Over HTTP the compared object is exactly what NIP-FI
core pins: the status code, the complete body, and the exact values of only the
header fields core's denial table names. Header order and unnamed header fields
are outside it, and their values MUST NOT depend on the private condition —
which the anonymity requirement above already demands and tests directly.

Comparing the ordered sequence of header field names, or every header value
except `Date`, would fail every conforming pair. Two independent servers emit
different automatic fields in different orders — `Server` and `Connection` are
the common divergences — so an exit test comparing them can never be passed by
anyone, and an oracle that no conforming implementation can satisfy is a defect
in this document rather than evidence about either implementation. The compared
object is therefore closed over what core names and nothing more; if core later
pins an additional field, it joins the compared object with no edit here.

`Date` needs no special exclusion under this rule, since core does not name it;
RFC 9110 Section 6.6.1 requires an origin server with a clock to generate it on
every response, so it could never be held constant. Any field an implementation
must exclude despite core naming it MUST be reported with the reason it cannot
be held constant, and its value MUST be independent of the private condition.

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

Independence is a claim about code and reference implementations, not about
inputs. Two implementations given different issuers, keys, or clocks cannot
produce equal bytes however correct both are, so the run is parameterized by a
**shared exit fixture** that both sides load and neither side authors:

- one issuer identity and one JWK set, including the private key needed to mint
  assertions and the `kid` selecting it;
- one assertion per denial class and one for the valid request, each with fixed
  `iss`, `sub`, `aud`, `nostr_pubkey`, `client_id`, `iat`, `exp`, and token
  class, expressed as complete pre-signature JWT claim sets;
- one Nostr secret key for the proof, with the exact event fields including
  `created_at`, so both sides derive the same actor;
- one frozen evaluation instant, and the skew and lifetime bounds in force; and
- the domain, target resource, operation, and enrollment policy for each case.

Every value the compared object depends on MUST be pinned here. A value left to
the implementation is a divergence the test will attribute to a defect in this
document, which is the correct disposition but a slow way to discover a missing
fixture field. The fixture records the document revision it was authored
against.

The exchanged artifact per case is the complete request frame and the complete
response frame on each transport: for HTTP the request line, headers and body,
and the response status, headers and body; for Nostr the complete client
message and the complete relay message. Both sides emit whole frames even
though the compared object is narrower, because the request side and the
unnamed response fields are what the reader needs in order to explain a
mismatch.

The evidence is the produced bytes, the fixture identity, the document revision
used, and a statement of independence. The test passes when the outputs compare
equal over the compared object and each implementation accepts the other's
valid request and reproduces the other's denials. Any divergence traced to an
underspecified value is a defect in the specification, not in either
implementation, and is fixed there.

This test has a mandatory negative control. One implementation is patched to
emit a denial that differs from the other only outside the compared object —
adding a header core does not name, or reordering fields — and the run MUST
still pass. A run that fails this control is comparing more than core pins and
would reject conforming pairs; the exit test itself is then the defect. The
control is retained with the evidence, because a comparison that only ever
reports equality proves nothing about what it would have caught.

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
