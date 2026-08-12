# Future corporate identity configuration contract

Historical corporate identity approaches based on provider-specific middleware, unsigned forwarded headers, or a parallel authorization authority are retired guidance. Buzz's provider-neutral contract is [NIP-FI](nips/NIP-FI.md).

## Availability boundary

This documentation revision defines a proposed configuration contract for a
later NIP-FI implementation. It does not add a parser for
`BUZZ_NIP_FI_V1_CONFIG_JSON`, remove or reject legacy variables, install a
protected authorization runtime, or activate discovery or enforcement. The
later implementation stack must reconcile this shape with its reviewed code
and executable adapters before claiming any behavior below.

Even after the parser exists, configuring the runtime is not conformance. A deployment must pass the
[behavioral evidence matrix](nips/NIP-FI-CONFORMANCE.md) at its exact
deployed revision before NIP-FI discovery or enforcement is advertised, and
operators must verify the effective configuration in their deployment;
public wording alone is not activation or conformance evidence.

## Proposed runtime document

The later implementation stack reserves `BUZZ_NIP_FI_V1_CONFIG_JSON` as its
sole identity-configuration input. The `V1` suffix versions this proposed
runtime document; it does not name or enable a legacy transport profile. The
implementation must provide the following modes and reject the
legacy provider-specific variables rather than treating them as aliases.

### Proposed operating modes

- **Off:** `BUZZ_NIP_FI_V1_CONFIG_JSON` is unset. Protected composition is
  not installed and existing unprotected behavior remains available.
- **DenyProtected:** the document is `{"deny_protected":true}`. Every
  protected route is denied before its handler runs. `deny_protected` takes
  precedence over every other field in the document.
- **Enforce:** the complete document below is provided. Missing, unknown, empty, or
  invalid fields fail startup.

```json
{
  "issuer": "https://issuer.example",
  "audience": "buzz-relay",
  "subject_claim": "sub",
  "event_author_claim": "nostr_pubkey",
  "clock_skew_seconds": 30,
  "maximum_token_lifetime_seconds": 3600,
  "jwks": {
    "jwks_uri": "https://issuer.example/.well-known/jwks.json"
  },
  "lease": { "maximum_seconds": 300 },
  "policy_revision": 1,
  "audit": {
    "max_events_per_domain": 1000000,
    "max_bytes_per_domain": 4294967296,
    "max_envelope_bytes": 65536
  },
  "client_status_admission": {
    "max_presentations_per_domain": 1000000,
    "max_presentations_per_actor": 10000,
    "max_presentations_per_peer": 10000
  },
  "transport": {
    "kind": "trusted_proxy_hmac_v2",
    "active_secrets_base64url": ["replace-with-base64url-secret"],
    "maximum_provenance_age_seconds": 60,
    "future_skew_seconds": 5
  },
  "enrollment": { "kind": "canonical_admission" },
  "restore": { "kind": "operation_manifest" },
  "delegation": { "enabled": false }
}
```

### Proposed document rules and bounds

The future parser must reject unknown fields. In Enforce mode:

- `issuer` and `audience` are required non-empty strings of at most 2048
  characters each.
- The implementation's closed asymmetric algorithm set enters verifier-policy
  identity through deterministic policy construction. If a later document
  makes that set configurable, adding or removing an algorithm must change the
  identity and algorithm order must be normalized.
- `subject_claim` defaults to `sub`. It and the optional `event_author_claim`
  are limited to 128 characters.
- `clock_skew_seconds` defaults to `0` and is at most 300.
- `maximum_token_lifetime_seconds` is required, positive, and at most 86400.
- `jwks` accepts exactly one HTTPS `jwks_uri` or `discovery_uri`; credentials,
  fragments, redirects, and private-network targets are rejected. The source
  kind and normalized authenticated URI enter verifier-policy identity.
- `lease.maximum_seconds` is required, positive, and at most 3600.
- `policy_revision` is required and positive.
- `audit` sets the immutable authorization-evidence capacity
  (`max_events_per_domain`, `max_bytes_per_domain`, `max_envelope_bytes`).
  There is no online prune, export, reset, or acknowledgement workflow — size
  the budget for the installation's lifetime with generous headroom, because
  exhaustion denies further authorization-affecting operations instead of
  dropping evidence.
- Denied operations never consume that non-reclaimable authorization-evidence
  budget and never create authorization receipts. A later implementation must
  attempt denial observations through a separate finite-capacity,
  non-authoritative channel. Channel exhaustion drops or truncates observation,
  emits aggregate saturation signals where possible, and cannot weaken, delay,
  or reverse the denial.
- `client_status_admission` limits are positive;
  `max_presentations_per_domain` cannot exceed `audit.max_events_per_domain`,
  and the per-actor and per-peer limits cannot exceed the per-domain limit.
- `transport`, `enrollment`, and `restore` are required non-empty objects
  consumed by matching runtime adapters. The example uses the stock
  `trusted_proxy_hmac_v2` adapter. A later implementation may instead select
  `client_attached` or one installed registered profile for a bound route and
  domain. Selection occurs before listeners open, never from request input,
  and failure never falls back to another profile.

The future implementation must validate the `jwks` refresh policy at construction: a fetched document
cannot exceed 4 MiB, a snapshot cannot stay fresh longer than 24 hours, every
refresh bound is finite and nonzero, and an accepted key set contains between
1 and 128 keys. Production deployments may use tighter bounds. Key refreshes are
single-flight and stale verification fails closed. Current-status
presentation renews within 120 seconds, so active connections observe
authoritative policy changes within that polling bound.

### Delegation

Delegation is disabled by default. Omitting the `delegation` object or setting
`{"enabled": false}` disables it, and a disabled delegation object must not
carry capabilities or a lifetime. Enabling it requires `enabled: true`, a
non-empty unique `capabilities` list drawn from the closed route-capability
set, and a positive `maximum_seconds` of at most 3600 that does not exceed
`lease.maximum_seconds`. Delegated authority is always capability-scoped —
never transport-wide — and the relay's NIP-11 information document does not
advertise delegation.

Corporate-identity delegation is unsupported by this documentation stack. The public production
path does not implement complete delegated issuance, owner-bound resolution,
expiry, invalidation, reconnect, or protected-transport behavior. Operators
must keep delegation disabled, and discovery must report it as false or omit
it. Enabling the configuration shape does not add the missing authority and
must not be used to advertise support. See the
[integration guide's availability boundary](NIP_FI_INTEGRATION.md#delegation-availability)
for the implementation and evidence requirements.

Direct NIP-FI authorization and future delegation are separate capabilities.
Delegation can be advertised only after a reviewed delegated-owner
implementation passes the complete applicable cross-transport lifecycle and
session evidence.

## Supported boundary

NIP-FI combines a verified issuer-qualified assertion result with independent fresh Nostr key proof, current durable binding and lifecycle state, server-owned request context, and final application admission. The stock `trusted-proxy-hmac-v2` construction binds HMAC provenance to the complete canonical request. A private registered trusted-edge profile may use another reviewed construction only when it satisfies the same normalized-result and final-admission contract. Header presence and network location alone are insufficient.

NIP-FI defines no public corporate directory or identity projection. Issuer-qualified identity and profile claims remain access-controlled enforcement data.

## No parallel authority

An enforcing domain has one current NIP-FI authority and policy lineage for every protected ingress. Do not:

- accept a legacy corporate header when NIP-FI denies;
- keep a provider-specific identity path for selected routes;
- infer identity from email or subject without the configured issuer;
- copy assertion expiry into durable binding expiry;
- import revoked, disabled, or retired state as an active binding; or
- expose corporate claims in Nostr events, discovery, logs, metrics, or traces.

NIP-42 and NIP-98 continue to prove control of a Nostr key. They do not replace the additional NIP-FI authority for a protected operation.

## Migration plan

1. **Inventory:** enumerate every protected WebSocket and HTTP ingress, existing identity source, forwarded field, policy, binding store, lifecycle action, and fallback.
2. **Freeze legacy expansion:** add no routes, providers, claims, or identities to the legacy authority while migration is in progress.
3. **Define domains and policies:** map each server-owned domain to exact issuer-qualified identities `(iss, sub)`, accepted semantics, enrollment mode, and transport profile.
4. **Normalize state:** represent active durable bindings, immutable provenance, retired pairs, disabled identities, revoked keys, pending replacement lineage, typed history, and versions.
5. **Verify imports:** require independent evidence for imported identity/key pairs. Do not treat a forwarded header, email match, or expired assertion as proof of key control.
6. **Install without activation:** deploy the later exact implementation with discovery and enforcement off, one canonical normalized-result and final-admission contract, and no legacy fallback.
7. **Run behavior:** execute all applicable `FI-TRACE-*` adapters at the exact artifact, deployment, and policy digests, including route inventory and deployed-boundary proxy negatives.
8. **Cut over atomically:** enable one authority across the complete protected-ingress set and remove the legacy path. Canary isolated domains or deployments, not individual routes under competing authorities.
9. **Verify and retain:** test old headers, old keys, tombstones, conflicts, denial privacy, dependency outages, restore, and rollback; retain privacy-safe evidence.

If historical data lacks proof or unambiguous issuer qualification, keep it non-authoritative until a separately authorized provisioning or recovery transition establishes current state.

## Rollback and repair

Rollback returns to a previously conformant artifact with compatible current state, or disables discovery and fails protected operations closed. It never restores unsigned forwarding, a removed verification key, a parallel provider runtime, or an older authority database.

Correct an imported binding or lifecycle fact with a reviewed privileged compensating transition. Preserve typed history and incident evidence; do not delete the record to make ordinary enrollment available again.

## Operator references

- [Integration contract](NIP_FI_INTEGRATION.md)
- [Threat model](NIP_FI_THREAT_MODEL.md)
- [Stock deployment](NIP_FI_DEPLOYMENT.md)
- [Runtime operations](NIP_FI_RUNTIME_OPERATIONS.md)
- [Contributor guide](NIP_FI_CONTRIBUTING.md)
