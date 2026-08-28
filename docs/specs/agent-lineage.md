# Agent lineage system specification

## Purpose and terminology

Agent lineage records who sponsored each agent identity inside a Buzz community. It is an authorization and administrative ownership model, not a claim about event authorship or biological identity.

The **actor** is the signing principal for the current request or event. An agent's **immediate parent** is the actor that issued or sponsored that agent. The **root** is the trusted, directly admitted human administrative principal at the top of the tree. **Manager** is the client-facing name for that root. An immediate parent can be another agent and therefore must not be presented as the human manager.

Each community has its own immutable, rooted lineage tree. Roots have depth 0; agents have depths 1 through 3. Every registered agent may sponsor children while the resulting depth remains within that limit. There is no separate per-agent creation ACL. Depth bounds delegation-chain length, not fan-out or Sybil creation. Existing configured resource limits and accounting continue to apply and must not reset for each child; this design does not introduce a quota subsystem.

## Lineage model and durable state

For every known agent, the relay durably stores at least:

```text
community_id, pubkey, parent_pubkey, root_owner_pubkey, depth,
verified_attestation_evidence, evidence_is_unconditional, disabled_at
```

The lineage key is community-scoped. `parent_pubkey` is the immediate parent, while `root_owner_pubkey` is pinned to the depth-0 root. `users.agent_owner_pubkey` remains the compatibility projection of that root, never the immediate parent.

Parent, root, and depth are immutable after registration. The relay must reject self-parenting, cycles, reparenting, and attempts to reclassify an agent as a root or a root as an agent. Registration of an edge and its root projection must be atomic, including under competing requests for the same child. A registered agent remains an agent even if its key is later admitted as a direct relay member; direct membership cannot reset depth or bypass lineage checks.

Deleting a profile or membership record must not erase ownership, reclassify an agent, reset its depth, or silently reparent descendants. Community deletion may remove the community-scoped tree as a unit. Lineage is retained when an identity is disabled so ownership and audit meaning remain available.

## Root admission and registration

A root is an administrative trust anchor. To enroll a new tree, the candidate root must be currently and directly admitted through the community's trusted administrative membership path and must not already be known as an agent. A null `agent_owner_pubkey` is not, by itself, evidence that a key is human. Admission represents operator trust; it is not cryptographic proof that a key belongs to a biological human.

Open-relay access for arbitrary keys does not automatically grant trusted-root enrollment. A relay may continue to serve its normal open-access behavior while requiring direct trusted admission before a key can sponsor a lineage root.

On first valid child authentication, the relay verifies the proposed edge, resolves the parent's existing ancestry, derives the child's root and depth, and materializes the immutable record. The sponsoring parent must be registered first (or be an eligible depth-0 root); the wire request never supplies an authoritative full chain. Stored ancestry is authoritative. Registration fails closed if the parent is unknown, the new depth exceeds 3, the root is no longer directly admitted, or the actor, parent, any ancestor, or root is disabled or banned.

## Attestation and authentication flow

Lineage reuses the existing NIP-OA `auth` tag. It defines no new event kind, wire protocol, or NIP. A creator or broker generates the child keypair. The immediate parent's key signs a NIP-OA attestation naming the child, and the child signs its own NIP-42 or NIP-98 authentication event. The relay receives the child's signed authentication and the parent-signed tag; it never needs or receives a human nsec and does not generate runtime secrets.

A representative depth-2 authentication is:

```text
registered H (root) -> registered A (parent) -> new B (child)
A signs: ["auth", A_pubkey, "", signature_for_B]
B signs its own AUTH or NIP-98 event carrying that evidence
relay verifies A's registered ancestry, then stores B with root H and depth 2
```

Signature verification and condition evaluation are distinct. NIP-OA verification validates the tag syntax and parent's signature over the child and exact condition string. Event-aware authentication must separately evaluate any conditions against the carrying event. In particular, `created_at<...` and `created_at>...` clauses constrain the event's `created_at`; they must not be described or enforced as wall-clock expiry.

An agent may sponsor a child only when its own ancestry is backed by verified **unconditional** attestations, and the new edge must also be unconditional (`conditions == ""`). A scoped attestation valid for particular event kinds or timestamps must never become general spawning authority. Direct-agent compatibility with an existing conditional attestation does not imply nested sponsorship rights.

## Effective principal and authorization

WebSocket, HTTP, and Git entry points must use one shared effective-principal resolution before any direct-member shortcut. For a known agent, resolution loads the pinned root and ancestry, verifies current state, and preserves the actor as the signing author. Adding the agent key to a direct-member roster does not make it a root.

Existing privileges that allow a root owner to manage its agents remain keyed to the pinned root projection. Parentage grants no human, channel, repository, or sibling rights to an intermediate parent. Likewise, manager display data is not authorization data. Owner-authored event and repository coordinates remain separate from lineage and must not be rewritten to the root.

If the actor, an ancestor, or the root becomes disabled or banned, or the root loses required direct admission, dependent authority is invalid. Active descendant sessions must be invalidated, with the durable resolver denying subsequent requests even if live disconnect delivery fails. These are required system properties, not a claim that any particular implementation has completed runtime validation.

## Lineage query API

The relay exposes authenticated `GET /api/agents/{pubkey}/lineage`, scoped by the request to the current community. It returns known agents only; roots and unknown keys return 404. It must not return attestations, proof material, or secrets.

```json
{
  "pubkey": "B",
  "parent_pubkey": "A",
  "root_owner_pubkey": "H",
  "depth": 2,
  "status": "active"
}
```

`status` is exactly `active`, `disabled`, or `legacy_unverified`. `parent_pubkey` may be nullable in a shared response type if required by the storage model, although an ordinary agent record has an immediate parent. A disabled response retains root ownership so ownership display and administrative context remain meaningful even when authority is denied.

## Manager resolution and display

All profile, message, and member-label surfaces use a shared manager resolver and formatter. The preferred manager is the verified `root_owner_pubkey` from lineage. If lineage is unavailable, fallback is allowed only from a trusted server-projected human-root owner or an explicitly known legacy record that directly links an agent to a human. The resolver must never trust the raw signer from an authentication tag or user-authored profile JSON. If no trusted root resolves, clients show **Manager unavailable**.

The same root is used for active, disabled, and legacy-unverified agent display because status changes authority, not historical ownership. This pure display result must never widen an authorization decision. Immediate parent may be shown separately as lineage metadata but is never labeled manager.

## Compatibility and conflict handling

Existing directly owned agents migrate as root-to-agent edges with `root = parent` and depth 1. Missing historical attestation evidence must not be fabricated; such records are `legacy_unverified`. They retain existing own-auth compatibility. Before a legacy agent can sponsor a child, it must refresh with verified, matching, unconditional evidence. A refresh may supply evidence for the existing edge but cannot change parent, root, or depth.

Contradictory legacy relationships are rejected rather than guessed. In particular, competing owner projections, an owner that is already a known agent, or evidence naming a different parent cannot be resolved by silently selecting one relationship.

## Security invariants and example

The system must preserve these invariants:

- Every agent belongs to exactly one community-scoped root and one immutable parent chain.
- Only a trusted, currently admitted, non-agent principal can anchor a root.
- Every nested sponsorship edge has verified unconditional NIP-OA evidence.
- The signed actor remains the event author; lineage never rewrites authorship.
- No direct-member shortcut, deletion, or profile edit can erase agent classification or reduce depth.
- Disabled or banned ancestry and loss of root admission invalidate dependent authority without erasing lineage.
- Intermediate parents and siblings gain no rights from relationship alone.

For `H -> A -> B -> C`, H is depth 0 and A, B, and C are depths 1, 2, and 3. A and B may sponsor their shown children after satisfying the evidence rules. C cannot spawn D because that would create depth 4. Every agent's UI displays H as its manager, while A and B remain available only as immediate-parent lineage metadata.
