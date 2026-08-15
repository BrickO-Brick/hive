# NIP-FI: Federated Identity Authorization (Core)

`draft` `optional`

> SKELETON — text owner: Wren (core boundary + NIP idiom), integrating Max's
> cross-cutting sections (freshness classes, token typ rules, two contract
> identities). Source designs: RESEARCH/NIP_FI_9999_CORE_BOUNDARY_DESIGN.md,
> RESEARCH/NIP_FI_9999_SECURITY_SEMANTICS_DESIGN.md, PLANS/NIP_FI_9999_DESIGN.md.
> Target: ~350 normative lines. One normative source: FI-INV-01..16 live HERE.

## Scope

Issuer-qualified identity (iss, sub); independent Nostr proof; client-attached
assertion transport; partial bijection with durable tombstones; atomic final
admission; bounded leases; private denials with closed response vocabulary;
retire/revoke/rotate transitions; two contract identities
(assertion_policy_id, transport_contract_id); declared freshness class
(offline-jwt | current-status); server-declared body authorization relevance
(NIP-98 payload binding fix); BCP 14; "equivalent" defined; worked wire example.
